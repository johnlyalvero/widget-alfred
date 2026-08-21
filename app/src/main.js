const { app, BrowserWindow, Tray, Menu, screen, ipcMain, clipboard, globalShortcut, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const os = require('os');

// TEMP DIAGNOSTIC: testing whether the open/close resize flash is a GPU-compositor swapchain
// artifact (X11/GLX briefly stretches the *old* frame's texture to the new window size before
// the GPU submits a correctly-sized new one) by routing around it via software rendering.
app.disableHardwareAcceleration();

// Wayland's protocol doesn't let a client position its own window (BrowserWindow.setBounds()'s
// x/y is silently ignored by Mutter) or query the real global cursor position — both of which
// this widget depends on to dock itself to a screen edge. Forcing XWayland (X11) looks like the
// fix (setBounds() reports success, getCursorScreenPoint() returns real coordinates) but on this
// machine it's worse than useless: the GPU process segfaults repeatedly under XWayland
// (exit_code=139), and even with hardware acceleration disabled to dodge that, the resulting
// window never actually gets mapped by the compositor at all — it runs, it answers geometry
// queries, and nothing is ever drawn on screen. Staying on native Wayland ozone: the window is
// at least real and visible, just not positionable via any client-side API. Positioning (see
// boundsFor() below) only actually lands on a real X11 session, not XWayland-under-Wayland.

const ICONS_DIR = path.join(__dirname, '..', 'assets', 'icons');
const SEED_DATA_DIR = path.join(__dirname, '..', 'data');
const USER_DATA_DIR = path.join(app.getPath('userData'), 'data');
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

// "My notes" reads/writes real files here instead of the local JSON store — this is the user's
// actual Obsidian vault, not sample/app-owned data.
const OBSIDIAN_VAULT_DIR = path.join(os.homedir(), 'Documents', 'Obsidian', 'vault');
const NOTES_VAULT_DIR = path.join(OBSIDIAN_VAULT_DIR, '1 - Rough Notes');

const RAIL_W = 56;
// Panel size is 1.5x its original (340x418-ish) footprint — only the expanded content panel
// scales; the idle rail (RAIL_W/WIDGET_H below) stays the same compact strip.
const PANEL_SCALE = 1.5;
const PANEL_W = Math.round(340 * PANEL_SCALE), GAP = 10;
const EXPANDED_W = PANEL_W + GAP + RAIL_W;
// Idle rail height: the rail's own natural content height (5 icons × 36px + 4 gaps × 8px + 10px
// padding top/bottom, from styles.css) so it hugs its icons tightly instead of centering them in
// extra empty space.
const WIDGET_H = 232;
// Expanded (panel open) height: deliberately taller than idle — more room for note/list/chat
// content — so idle and expanded are two genuinely different footprints now, not a shared value.
const EXPANDED_H = Math.round(WIDGET_H * 1.8 * PANEL_SCALE);
const EDGE_MARGIN = 2;

let win = null;
let tray = null;

function ensureUserData() {
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  for (const file of fs.readdirSync(SEED_DATA_DIR)) {
    const dest = path.join(USER_DATA_DIR, file);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(SEED_DATA_DIR, file), dest);
  }
  if (!fs.existsSync(SETTINGS_PATH)) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
      firstName: 'there',
      apiKey: null,
      model: 'openai/gpt-oss-20b:free',
      hotkey: 'Control+Shift+K',
      googleClientId: null,
      googleClientSecret: null,
      google: null
    }, null, 2));
  }
}

const DEFAULT_SETTINGS = {
  firstName: 'there', apiKey: null, model: 'openai/gpt-oss-20b:free', hotkey: 'Control+Shift+K',
  googleClientId: null, googleClientSecret: null, google: null
};

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(partial) {
  const current = loadSettings();
  const next = { ...current, ...partial };
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function readStore(name) {
  const p = path.join(USER_DATA_DIR, `${name}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeStore(name, data) {
  const p = path.join(USER_DATA_DIR, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  return true;
}

// ---------- Obsidian vault notes ----------

function ensureNotesVaultDir() {
  if (!fs.existsSync(NOTES_VAULT_DIR)) fs.mkdirSync(NOTES_VAULT_DIR, { recursive: true });
}

// Every handler below takes a filename, not a path — this resolves it against the vault dir and
// refuses anything that would escape it (e.g. a filename containing "../"), since this is now
// real filesystem access to the user's actual notes, not the sandboxed local JSON store.
function safeNotePath(filename) {
  const resolved = path.resolve(NOTES_VAULT_DIR, filename);
  if (resolved !== NOTES_VAULT_DIR && !resolved.startsWith(NOTES_VAULT_DIR + path.sep)) {
    throw new Error('invalid_path');
  }
  return resolved;
}

function sanitizeTitle(title) {
  return (title || 'Untitled').trim().replace(/[\\/:*?"<>|]/g, '-') || 'Untitled';
}

function uniqueMdFilename(title) {
  const base = sanitizeTitle(title);
  let name = `${base}.md`;
  let i = 2;
  while (fs.existsSync(path.join(NOTES_VAULT_DIR, name))) {
    name = `${base} ${i}.md`;
    i++;
  }
  return name;
}

// ---------- Google OAuth + Gmail/Calendar ----------

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events'
].join(' ');

// Gmail tab categories kept out of Inbox / the unread count-dot / Notifications — just Primary
// mail is left. Tune this list in one place rather than the query strings that use it.
const GMAIL_EXCLUDE_CATEGORIES = ['promotions', 'social', 'updates'];
const GMAIL_EXCLUDE_QUERY = GMAIL_EXCLUDE_CATEGORIES.map(c => `-category:${c}`).join(' ');

async function refreshGoogleToken(settings) {
  const g = settings.google;
  if (!g || !g.refreshToken) throw new Error('not_connected');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: settings.googleClientId,
      client_secret: settings.googleClientSecret,
      refresh_token: g.refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error_description || data.error || 'refresh_failed');
  const updated = { ...g, accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 - 30000 };
  saveSettings({ google: updated });
  return updated.accessToken;
}

async function getGoogleAccessToken() {
  const settings = loadSettings();
  const g = settings.google;
  if (!g || !g.refreshToken) throw new Error('not_connected');
  if (g.accessToken && g.expiresAt && Date.now() < g.expiresAt) return g.accessToken;
  return refreshGoogleToken(settings);
}

function decodeBase64Url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Gmail nests multipart/alternative inside multipart/mixed whenever a message has an attachment
// or inline image — a normal case, not an edge case — so this has to recurse into part.parts at
// every level, not just scan the top-level array.
function extractBody(payload) {
  if (!payload) return '';
  if (payload.parts) {
    let plainText = null, htmlText = null;
    const walk = (parts) => {
      for (const p of parts) {
        if (p.mimeType === 'text/plain' && p.body?.data && !plainText) plainText = decodeBase64Url(p.body.data);
        else if (p.mimeType === 'text/html' && p.body?.data && !htmlText) htmlText = decodeBase64Url(p.body.data);
        if (p.parts) walk(p.parts);
      }
    };
    walk(payload.parts);
    if (plainText) return plainText;
    if (htmlText) return htmlText.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return '';
  }
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  return '';
}

// Use whichever display the cursor is actually on, not the OS's "primary" display — on a
// multi-monitor setup those are frequently different, and docking against the wrong monitor's
// edge is what put the widget near the seam between screens instead of a real border.
function activeDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

// The display is dynamic (whichever monitor the cursor is on), but the side is always right —
// letting side follow left/right cursor position too made testing/reasoning about where the
// widget would land unpredictable on an asymmetric multi-monitor layout, and added no real
// value over a fixed side.
function boundsFor(mode, display) {
  const d = display || activeDisplay();
  const wa = d.workArea;
  const dockSide = 'right';
  const width = mode === 'idle' ? RAIL_W : EXPANDED_W;
  const height = mode === 'idle' ? WIDGET_H : EXPANDED_H;
  const x = Math.round(wa.x + wa.width - EDGE_MARGIN - width);
  const y = Math.round(wa.y + (wa.height - height) / 2);
  return { width, height, x, y, dockSide };
}

// setBounds() alone doesn't tell the renderer which edge got picked, but the CSS needs to know
// (rail/panel order flips) — so every reposition also pushes the resolved side over IPC.
//
// idle<->expanded isn't just a resize — it's a ~500px position jump too (boundsFor keeps the
// panel right-edge-docked and vertically centered, and idle/expanded are different footprints),
// and whatever paints mid-transition on this GPU/compositor combo (disableHardwareAcceleration
// above already tried to route around one suspected cause) is still visible as a brief flash/
// slide. Hiding for the duration of the bounds change sidesteps the rendering question entirely
// instead of chasing its exact cause — nothing is ever presented mid-transition, so there's
// nothing to flash. The window reappears already painted at its final bounds.
function applyBounds(mode, display) {
  if (!win) return;
  const bounds = boundsFor(mode, display);
  const wasVisible = win.isVisible();
  if (wasVisible) win.hide();
  win.setBounds(bounds);
  win.webContents.send('dock:side', bounds.dockSide);
  if (wasVisible) win.show();
}

function createWindow() {
  win = new BrowserWindow({
    ...boundsFor('idle'),
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    // Linux only: tells Mutter/GNOME Shell this is docked system chrome, not a normal app
    // window ('dock' is purely a WM hint here — doesn't reserve screen space, that needs a
    // separate strut property we never set). Doesn't hurt, but didn't fix the open/close resize
    // flash on its own — see backgroundColor below for the actual suspected cause.
    type: 'dock',
    // Without an explicit color, Chromium can paint newly-exposed pixels (the area a resize just
    // grew into) with an opaque default for one frame before the real transparent content lands
    // — a known flash on Linux for transparent BrowserWindows that never set this.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 'screen-saver' is the highest level Electron exposes — needed for this to reliably stay
  // above other always-on-top / fullscreen app windows too, not just normal ones.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    // Wayland compositors commonly ignore the constructor's initial x/y; re-assert it
    // explicitly once the window exists, which setBounds() reliably honors afterward.
    applyBounds('idle');
    win.show();
    win.moveTop();
  });

  // Belt-and-suspenders: re-assert top-most whenever we might have lost it, since some
  // window managers don't perfectly honor a one-time "always on top" request.
  win.on('blur', () => win.moveTop());
  win.on('show', () => win.moveTop());

  screen.on('display-metrics-changed', () => applyBounds(win.__mode || 'idle'));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ICONS_DIR, 'icon-32.png'));
  tray = new Tray(img);
  tray.setToolTip('Kinso');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: () => { if (win) win.isVisible() ? win.hide() : win.show(); } },
    { label: 'Open Alfred', click: () => openAI() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
  tray.on('click', () => { if (win) win.isVisible() ? win.hide() : win.show(); });
}

// Tray menu's "Open Alfred" — actually opens the AI panel. Goes through the renderer (which
// then calls back into 'ui:set-mode', repositioning as a side effect) because it needs to change
// what's showing, not just where.
function openAI() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.webContents.send('hotkey:open-ai');
}

// The global hotkey — a pure "come to me" trigger, decoupled from opening any panel. Whatever is
// currently showing (idle rail, or any mode) stays showing; only the docked monitor/position gets
// re-evaluated against the cursor. Resolved entirely in the main process — no round trip through
// the renderer, since that's extra machinery this doesn't need and one less thing to break.
function relocateToCursor() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  applyBounds(win.__mode || 'idle');
}

function registerHotkey() {
  const { hotkey } = loadSettings();
  try {
    globalShortcut.register(hotkey, relocateToCursor);
  } catch {
    // fall back silently; user can change the hotkey in settings.json
  }
}

app.whenReady().then(() => {
  ensureUserData();
  createWindow();
  createTray();
  registerHotkey();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* keep running in tray */ });

// ---------- IPC ----------

ipcMain.handle('store:get', (_e, name) => readStore(name));
ipcMain.handle('store:set', (_e, name, data) => writeStore(name, data));
ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, partial) => saveSettings(partial));
ipcMain.handle('clipboard:copy', (_e, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('app:quit', () => app.quit());

ipcMain.on('ui:set-mode', (_e, mode) => {
  if (!win) return;
  win.__mode = mode;
  applyBounds(mode);
});

// Alfred's tools — read-only on purpose. Reply/modify stay manual UI actions the user triggers
// themselves; the chat assistant can look things up but never sends mail or changes the
// calendar on its own.
const ALFRED_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: "List the user's notes from their Obsidian vault, each with a short preview. Use this to find a note by topic before reading it in full with read_note.",
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read the full content of one note from the Obsidian vault.',
      parameters: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Exact note title, without the .md extension, as returned by list_notes' } },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_calendar_events',
      description: "List the user's upcoming Google Calendar events.",
      parameters: {
        type: 'object',
        properties: { days: { type: 'number', description: 'How many days ahead to look. Default 14.' } },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_emails',
      description: "List the user's recent Gmail inbox messages (sender, subject, snippet, id). Use this to find a message before reading it in full with read_email.",
      parameters: {
        type: 'object',
        properties: { unreadOnly: { type: 'boolean', description: 'Only return unread messages. Default false.' } },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_email',
      description: 'Read the full body of one email.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The email id, as returned by list_emails' } },
        required: ['id']
      }
    }
  }
];

async function runAlfredTool(name, args) {
  try {
    if (name === 'list_notes') {
      return notesListImpl().map(n => ({ title: n.title, preview: n.preview, updatedAt: n.updatedAt }));
    }
    if (name === 'read_note') {
      const note = notesGetImpl(`${args.title}.md`);
      return { title: note.title, body: note.body };
    }
    if (name === 'list_calendar_events') {
      const days = args.days || 14;
      const timeMax = new Date(Date.now() + days * 86400000).toISOString();
      const r = await calendarListImpl({ max: 100, timeMax });
      if (!r.ok) return { error: r.error };
      return r.events.map(e => ({ title: e.title, date: e.date, start: e.start, end: e.end, allDay: e.allDay, description: e.description }));
    }
    if (name === 'list_emails') {
      const r = await gmailListImpl({ max: 15, unreadOnly: !!args.unreadOnly });
      if (!r.ok) return { error: r.error };
      return r.messages.map(m => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet, unread: m.unread, date: m.date }));
    }
    if (name === 'read_email') {
      const r = await gmailGetImpl(args.id);
      if (!r.ok) return { error: r.error };
      return { from: r.message.from, subject: r.message.subject, body: r.message.body };
    }
    return { error: 'unknown_tool' };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

ipcMain.handle('ai:ask', async (_e, { message, history }) => {
  const settings = loadSettings();
  if (!settings.apiKey) return { ok: false, error: 'no_api_key' };
  const hasGoogle = !!(settings.google && settings.google.refreshToken);
  // Notes need no Google connection; calendar/mail tools only make sense once connected —
  // omitting them otherwise keeps the model from attempting (and failing) a call it can't serve.
  const tools = ALFRED_TOOLS.filter(t => hasGoogle || ['list_notes', 'read_note'].includes(t.function.name));
  const messages = [
    { role: 'system', content: "You are Alfred, a concise personal desktop assistant living in a small floating panel — named for Batman's butler. You can look up the user's Obsidian notes, Google Calendar, and Gmail via tools when it helps answer their question; don't call a tool for things you can already answer directly. Answer briefly — a few sentences at most unless asked for more." },
    ...(history || []),
    { role: 'user', content: message }
  ];
  try {
    for (let round = 0; round < 4; round++) {
      const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: settings.model || 'openai/gpt-oss-20b:free',
          max_tokens: 1024,
          messages,
          ...(tools.length ? { tools } : {})
        })
      });
      const data = await resp.json();
      if (!resp.ok) {
        return { ok: false, error: 'request_failed', message: data?.error?.message || `HTTP ${resp.status}` };
      }
      const choice = data.choices?.[0];
      const toolCalls = choice?.message?.tool_calls;
      if (!toolCalls || !toolCalls.length) {
        return { ok: true, text: choice?.message?.content || '' };
      }
      messages.push(choice.message);
      for (const call of toolCalls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* leave empty */ }
        const result = await runAlfredTool(call.function.name, args);
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    return { ok: false, error: 'request_failed', message: 'Too many tool calls in a row' };
  } catch (err) {
    return { ok: false, error: 'request_failed', message: String((err && err.message) || err) };
  }
});

ipcMain.handle('shell:open-external', (_e, url) => { shell.openExternal(url); return true; });

ipcMain.handle('google:status', () => {
  const settings = loadSettings();
  return { connected: !!(settings.google && settings.google.refreshToken), email: settings.google?.email || null };
});

ipcMain.handle('google:disconnect', () => {
  saveSettings({ google: null });
  return true;
});

// Loopback authorization-code flow: opens the system browser to Google's consent screen, and a
// one-shot local HTTP server on an OS-assigned port catches the redirect. Desktop-app OAuth
// clients auto-permit any http://127.0.0.1:<port> redirect, so no port needs pre-registration.
ipcMain.handle('google:connect', async (_e, { clientId, clientSecret }) => {
  return new Promise((resolve) => {
    let server;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch {}
      resolve(result);
    };
    server = http.createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth/callback') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(err
        ? '<html><body style="font-family:sans-serif;padding:40px;">Google sign-in failed. You can close this tab and try again in Kinso.</body></html>'
        : '<html><body style="font-family:sans-serif;padding:40px;">Connected. You can close this tab and go back to Kinso.</body></html>');
      if (err) { finish({ ok: false, error: err }); return; }
      try {
        const port = server.address().port;
        const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: `http://127.0.0.1:${port}/oauth/callback`
          })
        });
        const tokenData = await tokenResp.json();
        if (!tokenResp.ok) { finish({ ok: false, error: tokenData.error_description || tokenData.error || 'token_exchange_failed' }); return; }

        const profResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });
        const prof = await profResp.json().catch(() => ({}));

        saveSettings({
          googleClientId: clientId,
          googleClientSecret: clientSecret,
          google: {
            refreshToken: tokenData.refresh_token,
            accessToken: tokenData.access_token,
            expiresAt: Date.now() + tokenData.expires_in * 1000 - 30000,
            email: prof.emailAddress || null
          }
        });
        finish({ ok: true, email: prof.emailAddress || null });
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
      }
    });
    server.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://127.0.0.1:${port}/oauth/callback`,
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        access_type: 'offline',
        prompt: 'consent'
      });
      shell.openExternal(authUrl);
    });
    setTimeout(() => finish({ ok: false, error: 'timeout' }), 120000);
  });
});

async function gmailListImpl({ max = 12, unreadOnly = false } = {}) {
  try {
    const token = await getGoogleAccessToken();
    // Server-side query, not a client-side filter over the most-recent N — an unread message
    // that isn't among the N most recent inbox items would otherwise never surface under
    // "Unread" even though it's genuinely unread (and the bell dot, which searches for unread
    // specifically, would correctly flag it while the list showed nothing).
    const q = `${unreadOnly ? 'is:unread in:inbox' : 'in:inbox'} ${GMAIL_EXCLUDE_QUERY}`;
    const listResp = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listResp.json();
    if (!listResp.ok) return { ok: false, error: listData.error?.message || 'list_failed' };
    const ids = (listData.messages || []).map(m => m.id);
    const messages = await Promise.all(ids.map(async id => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const d = await r.json();
      const headers = Object.fromEntries((d.payload?.headers || []).map(h => [h.name, h.value]));
      return {
        id: d.id, threadId: d.threadId,
        from: headers.From || '', subject: headers.Subject || '(no subject)',
        snippet: d.snippet || '', unread: (d.labelIds || []).includes('UNREAD'),
        date: d.internalDate ? new Date(Number(d.internalDate)).toISOString() : null
      };
    }));
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

ipcMain.handle('gmail:list', (_e, opts) => gmailListImpl(opts));

ipcMain.handle('gmail:has-unread', async () => {
  try {
    const token = await getGoogleAccessToken();
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(`is:unread in:inbox ${GMAIL_EXCLUDE_QUERY}`) + '&maxResults=1', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error?.message || 'check_failed' };
    return { ok: true, hasUnread: (d.messages || []).length > 0 };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

async function gmailGetImpl(id) {
  try {
    const token = await getGoogleAccessToken();
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error?.message || 'get_failed' };
    const headers = Object.fromEntries((d.payload?.headers || []).map(h => [h.name, h.value]));
    return {
      ok: true,
      message: {
        id: d.id, threadId: d.threadId,
        from: headers.From || '', to: headers.To || '', subject: headers.Subject || '(no subject)',
        messageIdHeader: headers['Message-ID'] || headers['Message-Id'] || '',
        body: extractBody(d.payload),
        unread: (d.labelIds || []).includes('UNREAD'),
        webLink: `https://mail.google.com/mail/u/0/#all/${d.threadId}`
      }
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

ipcMain.handle('gmail:get', (_e, { id }) => gmailGetImpl(id));

ipcMain.handle('gmail:reply', async (_e, { threadId, to, subject, messageIdHeader, body }) => {
  try {
    const token = await getGoogleAccessToken();
    const settings = loadSettings();
    const from = settings.google?.email || '';
    const subj = /^re:/i.test(subject || '') ? subject : `Re: ${subject || ''}`;
    const lines = [
      from ? `From: ${from}` : null,
      `To: ${to}`,
      `Subject: ${subj}`,
      messageIdHeader ? `In-Reply-To: ${messageIdHeader}` : null,
      messageIdHeader ? `References: ${messageIdHeader}` : null,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      body
    ].filter(l => l !== null).join('\r\n');
    const raw = Buffer.from(lines, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, threadId })
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error?.message || 'send_failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('gmail:mark-read', async (_e, { id }) => {
  try {
    const token = await getGoogleAccessToken();
    const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ removeLabelIds: ['UNREAD'] })
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return { ok: false, error: d.error?.message || 'mark_read_failed' }; }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

async function calendarListImpl({ max = 12, timeMax } = {}) {
  try {
    const token = await getGoogleAccessToken();
    const timeMin = new Date().toISOString();
    const params = { timeMin, maxResults: String(max), singleEvents: 'true', orderBy: 'startTime' };
    if (timeMax) params.timeMax = timeMax;
    const url = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?' + new URLSearchParams(params);
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error?.message || 'list_failed' };
    const events = (d.items || []).map(ev => ({
      id: ev.id,
      title: ev.summary || '(no title)',
      date: (ev.start?.dateTime || ev.start?.date || '').slice(0, 10),
      start: ev.start?.dateTime ? ev.start.dateTime.slice(11, 16) : '00:00',
      end: ev.end?.dateTime ? ev.end.dateTime.slice(11, 16) : '23:59',
      allDay: !ev.start?.dateTime,
      tentative: false,
      description: ev.description || '',
      zoom: ev.hangoutLink || (ev.conferenceData?.entryPoints || []).find(p => p.entryPointType === 'video')?.uri || null,
      invitees: (ev.attendees || []).map(a => a.displayName || a.email),
      organizer: ev.organizer?.email || '',
      awaiting: null,
      htmlLink: ev.htmlLink,
      source: 'google'
    }));
    return { ok: true, events };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

ipcMain.handle('calendar:list', (_e, opts) => calendarListImpl(opts));

ipcMain.handle('calendar:update', async (_e, { id, patch }) => {
  try {
    const token = await getGoogleAccessToken();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const body = {};
    if (patch.title !== undefined) body.summary = patch.title;
    if (patch.description !== undefined) body.description = patch.description;
    if (patch.location !== undefined) body.location = patch.location;
    if (patch.date && patch.start) body.start = { dateTime: `${patch.date}T${patch.start}:00`, timeZone: tz };
    if (patch.date && patch.end) body.end = { dateTime: `${patch.date}T${patch.end}:00`, timeZone: tz };
    const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) return { ok: false, error: d.error?.message || 'update_failed' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

function notesListImpl() {
  ensureNotesVaultDir();
  return fs.readdirSync(NOTES_VAULT_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const full = path.join(NOTES_VAULT_DIR, f);
      const stat = fs.statSync(full);
      const content = fs.readFileSync(full, 'utf8');
      const firstLine = content.split('\n').find(l => l.trim()) || '';
      return {
        id: f,
        title: f.replace(/\.md$/, ''),
        preview: firstLine.replace(/^#+\s*/, '').slice(0, 140),
        updatedAt: stat.mtime.toISOString()
      };
    });
}

function notesGetImpl(id) {
  const body = fs.readFileSync(safeNotePath(id), 'utf8');
  return { id, title: id.replace(/\.md$/, ''), body };
}

ipcMain.handle('notes:list', () => notesListImpl());
ipcMain.handle('notes:get', (_e, { id }) => notesGetImpl(id));

// Handles both create (id null) and update, including renaming the file when the title changed
// — auto-disambiguating with a numeric suffix rather than ever clobbering another note.
ipcMain.handle('notes:save', (_e, { id, title, body }) => {
  ensureNotesVaultDir();
  let currentId = id;
  if (id) {
    const currentPath = safeNotePath(id);
    const desired = `${sanitizeTitle(title)}.md`;
    if (desired !== id) {
      let candidate = desired, i = 2;
      while (candidate !== id && fs.existsSync(path.join(NOTES_VAULT_DIR, candidate))) {
        candidate = `${sanitizeTitle(title)} ${i}.md`;
        i++;
      }
      fs.renameSync(currentPath, safeNotePath(candidate));
      currentId = candidate;
    }
  } else {
    currentId = uniqueMdFilename(title);
  }
  fs.writeFileSync(safeNotePath(currentId), body || '', 'utf8');
  return { id: currentId };
});

ipcMain.handle('notes:open-external', (_e, { id }) => {
  const p = safeNotePath(id);
  const rel = path.relative(OBSIDIAN_VAULT_DIR, p).replace(/\.md$/, '');
  const uri = `obsidian://open?vault=${encodeURIComponent('vault')}&file=${encodeURIComponent(rel)}`;
  shell.openExternal(uri);
  return true;
});
