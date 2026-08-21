const ic = (id, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24"><use href="#${id}"/></svg>`;
const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const cache = {};
async function loadStore(name) {
  if (!cache[name]) cache[name] = await window.kinso.getStore(name);
  return cache[name];
}
async function saveStore(name, data) {
  cache[name] = data;
  await window.kinso.setStore(name, data);
  return data;
}
let settings = null;
async function loadSettings() { settings = await window.kinso.getSettings(); return settings; }

let mode = 'idle';
let sub = {};
let aiThread = []; // lives outside `sub` so it survives switching to another mode and back

function setMode(next, nextSub = {}) {
  mode = next;
  sub = nextSub;
  window.kinso.setMode(mode);
  render();
}

function showToast(msg) {
  const panel = document.getElementById('panel');
  let t = panel.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; panel.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(t.__timer);
  t.__timer = setTimeout(() => t.classList.remove('show'), 1600);
}

function greeting() {
  const h = new Date().getHours();
  const period = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
  const name = (settings && settings.firstName) || 'there';
  return `Good ${period}, ${name}`;
}

// ---------------- rail ----------------

function renderRail() {
  const items = [
    { m: 'ai', icon: 'ic-sparkle' },
    { m: 'notif', icon: 'ic-bell', dot: false },
    { m: 'notes', icon: 'ic-doc' },
    { m: 'cal', icon: 'ic-cal' },
    { m: 'inbox', icon: 'ic-inbox' },
  ];
  const hasUnread = !!cache.hasUnreadGmail;
  document.getElementById('rail').innerHTML = items.map(it => `
    <button class="rail-btn ${mode === it.m ? 'on' : ''}" data-m="${it.m}" title="${it.m}">
      ${ic(it.icon)}${it.m === 'notif' && hasUnread ? '<span class="dot"></span>' : ''}
    </button>`).join('');
  document.querySelectorAll('.rail-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = btn.dataset.m;
      if (mode === m) { setMode('idle'); return; }
      openMode(m);
    });
  });
}

async function openMode(m) {
  if (m === 'ai') { await loadSettings(); setMode('ai', { turn: 'empty' }); }
  else if (m === 'notif') {
    await loadSettings();
    if (!settings.google) { setMode('notif', {}); return; }
    setMode('notif', { pending: true });
    await fetchLiveNotifs();
    sub.pending = false; render();
    refreshUnreadDot();
  }
  else if (m === 'notes') {
    setMode('notes', { view: 'list', pending: true });
    cache.notes = await window.kinso.notesList();
    sub.pending = false; render();
  }
  else if (m === 'cal') {
    await loadSettings();
    if (!settings.google) { setMode('cal', {}); return; }
    setMode('cal', { view: 'list', pending: true });
    // Bounded to 6 months out — otherwise yearly-recurring events (birthdays etc.) push the list
    // years into the future instead of showing what's actually coming up.
    const sixMonthsOut = new Date();
    sixMonthsOut.setMonth(sixMonthsOut.getMonth() + 6);
    const r = await window.kinso.calendarList({ max: 500, timeMax: sixMonthsOut.toISOString() });
    cache.googleEvents = r.ok ? r.events : [];
    sub.pending = false; render();
  }
  else if (m === 'inbox') {
    await loadSettings();
    if (!settings.google) { setMode('inbox', {}); return; }
    setMode('inbox', { view: 'list', pending: true, unreadOnly: true });
    await loadInboxList();
    sub.pending = false; render();
    refreshUnreadDot();
  }
}

// ---------------- panel dispatch ----------------

function panelHeader(inner) { return `<div class="p-head">${inner}</div>`; }

function render() {
  const panel = document.getElementById('panel');
  if (mode === 'idle') {
    panel.classList.remove('show');
    panel.innerHTML = '';
    renderRail();
    return;
  }
  panel.classList.add('show');
  if (mode === 'ai') panel.innerHTML = renderAI();
  else if (mode === 'notif') panel.innerHTML = renderNotif();
  else if (mode === 'notes') panel.innerHTML = renderNotes();
  else if (mode === 'cal') panel.innerHTML = renderCal();
  else if (mode === 'inbox') panel.innerHTML = renderInbox();
  wire();
  renderRail();
}

// ---------------- AI ----------------

function renderAI() {
  const hasKey = settings && settings.apiKey;
  let body;
  if (!hasKey) {
    body = `<div class="ai-keysetup">
      <p>Alfred needs an OpenRouter API key to answer questions — it never leaves this machine except to call the API directly.</p>
      <div class="row">
        <input id="apiKeyInput" type="password" placeholder="sk-or-..." />
        <button id="saveKeyBtn">Save</button>
      </div>
    </div>`;
  } else if (!aiThread.length) {
    body = `<div class="ai-empty-state"><div class="comet"></div><div class="greet">${greeting()}</div></div>`;
  } else {
    body = `<div class="ai-thread">${aiThread.map(m => {
      if (m.role === 'user') return `<div class="ai-msg ai-msg-user">${escapeHtml(m.content)}</div>`;
      if (m.role === 'error') return `<div class="ai-msg ai-error">${escapeHtml(m.content)}</div>`;
      return `<div class="ai-msg ai-msg-assistant markdown-body">${renderMarkdown(m.content)}</div>`;
    }).join('')}${sub.pending ? '<div class="ai-thinking"><span></span><span></span><span></span></div>' : ''}</div>`;
  }
  return `
    ${panelHeader(`
      <button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button>
      <div class="p-title" style="margin-left:2px;">Alfred</div>
      <div class="spacer"></div>
      <button class="p-icon-btn" data-act="new-thread">${ic('ic-pencil')}</button>
      <button class="p-icon-btn" title="Coming soon">${ic('ic-history')}</button>
    `)}
    <div class="p-body">${body}</div>
    <div class="p-foot">
      <div class="ai-inputbar">
        <button class="p-icon-btn">${ic('ic-plus')}</button>
        <input id="aiInput" placeholder="Ask Alfred" ${sub.pending ? 'disabled' : ''}/>
        <button class="p-icon-btn">${ic('ic-cmd')}</button>
        <button class="p-icon-btn">${ic('ic-mic')}</button>
        <button class="send" id="aiSend" ${sub.pending ? 'disabled' : ''}>${ic('ic-send')}</button>
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Single newlines read as line breaks in chat replies, not "still the same paragraph" —
// matches how models actually format answers, unlike default CommonMark.
if (window.marked) window.marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text) {
  if (!window.marked) return escapeHtml(text);
  try { return window.marked.parse(text || ''); }
  catch { return escapeHtml(text); }
}

function parseFromName(from) {
  const m = /^"?([^"<]+)"?\s*<[^>]+>$/.exec(from || '');
  return (m ? m[1] : from || '').trim() || 'Unknown';
}
function initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

// ---------------- Google (shared: connect flow + Gmail/Calendar fetch helpers) ----------------

// The rail's bell dot must reflect real, current unread state — not a cached snapshot of
// whatever the Notifications feed last showed, which goes stale the moment mail is read from
// anywhere else (e.g. the Inbox panel). Call this after anything that could change unread state.
function refreshUnreadDot() {
  window.kinso.gmailHasUnread().then(r => {
    if (r.ok) { cache.hasUnreadGmail = r.hasUnread; renderRail(); }
  });
}

// Background poll so a newly-arrived email lights up the dot on its own, not only when the user
// happens to open a panel. gmail:has-unread is a cheap maxResults=1 query, safe to run this
// often. The window/renderer stays alive while idle (just resized to the rail), so the interval
// keeps ticking even with no panel open.
let unreadPollTimer = null;
function startUnreadPolling() {
  if (unreadPollTimer) return;
  unreadPollTimer = setInterval(refreshUnreadDot, 30000);
}

function renderGoogleSetup(label) {
  const savedId = (settings && settings.googleClientId) || '';
  return `<div class="ai-keysetup">
    <p>${escapeHtml(label)} needs your Google account connected — nothing leaves this machine except direct calls to Google's own API.</p>
    <div class="row"><input id="gClientId" placeholder="Google OAuth Client ID" value="${escapeHtml(savedId)}" /></div>
    <div class="row">
      <input id="gClientSecret" type="password" placeholder="Google OAuth Client Secret" />
      <button data-act="google-connect">${sub.pending ? 'Connecting…' : 'Connect'}</button>
    </div>
  </div>`;
}

async function connectGoogle() {
  const idEl = document.getElementById('gClientId');
  const secretEl = document.getElementById('gClientSecret');
  const clientId = (idEl && idEl.value.trim()) || '';
  const clientSecret = (secretEl && secretEl.value.trim()) || '';
  if (!clientId || !clientSecret) { showToast('Enter both Client ID and Secret'); return; }
  settings = settings || {};
  settings.googleClientId = clientId;
  settings.googleClientSecret = clientSecret;
  await window.kinso.setSettings({ googleClientId: clientId, googleClientSecret: clientSecret });
  sub.pending = true; render();
  const resp = await window.kinso.googleConnect({ clientId, clientSecret });
  sub.pending = false;
  if (resp.ok) {
    settings.google = { email: resp.email };
    startUnreadPolling();
    showToast(`Connected as ${resp.email || 'Google'}`);
    if (mode === 'notif') openMode('notif');
    else if (mode === 'inbox') openMode('inbox');
    else if (mode === 'cal') { sub.view = 'list'; openMode('cal'); }
    else render();
  } else {
    showToast('Connect failed: ' + (resp.error || 'unknown error'));
    render();
  }
}

// Gmail's own UNREAD label is the persistence for dismissed mail cards (mark-read on dismiss).
// Calendar events have no such flag, so dismissed event ids are tracked in a local store —
// otherwise the same upcoming event just comes back on the next fetch, since nothing on
// Google's side changed.
async function dismissedCalIds() {
  return new Set((await loadStore('dismissedNotifs').catch(() => [])) || []);
}

async function fetchLiveNotifs() {
  // Bounded to "today" on purpose: a recurring event (e.g. twice-daily) expands into a new
  // Google event id per occurrence, so an unbounded fetch just backfills with tomorrow's/next
  // week's instances the moment today's are dismissed — reads as notifications that never stop.
  // Today's cutoff keeps the feed to what's actually imminent; tomorrow's occurrence is a new
  // day's notification, not a re-appearance of one already dismissed.
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  const [gmailResp, calResp, dismissed] = await Promise.all([
    window.kinso.gmailList({ max: 15 }),
    window.kinso.calendarList({ max: 20, timeMax: endOfToday.toISOString() }),
    dismissedCalIds()
  ]);
  const gmailCards = (gmailResp.ok ? gmailResp.messages : [])
    .filter(m => m.unread)
    .slice(0, 8)
    .map(m => {
      const name = parseFromName(m.from);
      return { source: 'gmail', id: m.id, threadId: m.threadId, badge: initials(name), color: '#4285f4',
        name, sub: m.subject, body: m.snippet };
    });
  const calCards = (calResp.ok ? calResp.events : [])
    .filter(e => !dismissed.has(e.id))
    .slice(0, 5)
    .map(e => ({
      source: 'calendar', id: e.id, badge: 'C', color: '#8b7cf6',
      name: e.title, sub: `${e.date} · ${e.allDay ? 'All day' : `${e.start}–${e.end}`}`,
      body: e.description || (e.zoom ? `Meeting link: ${e.zoom}` : 'No description')
    }));
  cache.liveNotifs = [...gmailCards, ...calCards];
  return cache.liveNotifs;
}

// Always refetches (no stale-cache shortcut) — the query itself depends on sub.unreadOnly, so a
// cached list from the other mode would be actively wrong, not just stale.
async function loadInboxList() {
  const r = await window.kinso.gmailList({ max: 15, unreadOnly: !!sub.unreadOnly });
  cache.gmail = r.ok ? r.messages : [];
  return cache.gmail;
}

async function openInboxDetail(id) {
  const row = (cache.gmail || []).find(r => r.id === id);
  setMode('inbox', { view: 'detail', id, pending: true, unreadOnly: sub.unreadOnly });
  const resp = await window.kinso.gmailGet(id);
  sub.pending = false;
  if (resp.ok) {
    cache.gmailDetail = resp.message;
    if (resp.message.unread) {
      window.kinso.gmailMarkRead(id);
      if (row) row.unread = false;
      refreshUnreadDot();
    }
  }
  render();
}

async function openCalDetail(id) {
  if (!cache.googleEvents) {
    showToast('Opening…');
    const r = await window.kinso.calendarList({ max: 20 });
    cache.googleEvents = r.ok ? r.events : [];
  }
  setMode('cal', { view: 'detail', id });
}

async function sendAIMessage(text) {
  if (!text.trim()) return;
  aiThread.push({ role: 'user', content: text });
  sub.pending = true;
  render();
  const history = aiThread.filter(m => m.role !== 'error').map(m => ({ role: m.role, content: m.content }));
  const resp = await window.kinso.askAI(text, history.slice(0, -1));
  sub.pending = false;
  if (resp.ok) aiThread.push({ role: 'assistant', content: resp.text });
  else if (resp.error === 'no_api_key') aiThread.push({ role: 'error', content: 'No API key set. Open the sparkle mode again to add one.' });
  else aiThread.push({ role: 'error', content: `Couldn't reach the model: ${resp.message || resp.error}` });
  render();
}

// ---------------- Notifications ----------------

function renderNotif() {
  if (!(settings && settings.google)) return renderGoogleSetup('Notifications');
  if (sub.pending) {
    return `${panelHeader(`<div class="p-title">Notifications</div>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
  }
  const list = cache.liveNotifs || [];
  return `
    ${panelHeader(`<button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button><div class="p-title" style="margin-left:2px;">Notifications</div><div class="spacer"></div><button class="p-icon-btn" data-act="close">${ic('ic-close')}</button>`)}
    <div class="p-body" style="padding-top:6px;">
      ${!list.length ? `<div class="notif-empty">You're all caught up.</div>` : list.map(n => `
        <div class="inbox-row" data-act="open-notif" data-id="${n.id}">
          <div class="inbox-avatar" style="background:${n.color}">${ic(n.source === 'gmail' ? 'ic-inbox' : 'ic-cal')}</div>
          <div class="inbox-main">
            <div class="inbox-top"><span class="inbox-from">${escapeHtml(n.name)}</span></div>
            <div class="inbox-preview">${escapeHtml(n.sub)} — ${escapeHtml(n.body)}</div>
          </div>
          <button class="p-icon-btn" data-act="dismiss-notif" data-id="${n.id}" title="Dismiss">${ic('ic-close')}</button>
        </div>`).join('')}
    </div>`;
}

// ---------------- Notes ----------------

function renderNotes() {
  if (sub.pending) {
    return `${panelHeader(`<div class="p-title">${ic('ic-doc')} My notes</div>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
  }
  const notes = cache.notes || [];
  if (sub.view === 'list' || !sub.id) {
    const items = notes.slice().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    return `
      ${panelHeader(`<button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button><div class="p-title">${ic('ic-doc')} My notes</div>`)}
      <div class="p-body">
        ${items.map(n => `<div class="notes-list-item" data-id="${n.id}">
          <div class="t">${escapeHtml(n.title || 'Untitled')}</div>
          <div class="p">${escapeHtml(n.preview || 'No content yet')}</div>
        </div>`).join('')}
        <div class="notes-new" data-act="new-note">${ic('ic-plus')} New note</div>
      </div>`;
  }
  const note = cache.currentNote;
  if (!note || note.id !== sub.id) {
    return `${panelHeader(`<button class="p-icon-btn" data-act="back-list">${ic('ic-back')}</button>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
  }
  return `
    ${panelHeader(`
      <button class="p-icon-btn" data-act="back-list">${ic('ic-back')}</button>
      <div class="spacer"></div>
      <button class="p-icon-btn" data-act="fmt-bold" title="Bold"><b style="font-size:13px;">B</b></button>
      <button class="p-icon-btn" data-act="fmt-highlight" title="Highlight"><span style="font-size:11px; background:#ffe066; color:#111; border-radius:3px; padding:0 3px;">H</span></button>
      <button class="p-icon-btn" data-act="ai-cleanup" title="Clean up with AI">${ic('ic-wand')}</button>
      <button class="p-icon-btn" data-act="open-external" title="Open in Obsidian">${ic('ic-ext')}</button>
      <span class="rec-pill ${sub.recording ? 'live' : ''}" data-act="toggle-rec" title="Mock recording toggle — no real audio capture yet"><span class="rd"></span>REC</span>
    `)}
    <div class="p-body">
      <input class="notes-title-input" id="noteTitle" value="${escapeHtml(note.title || '')}" placeholder="Untitled" />
      <textarea class="notes-body-input" id="noteBody" placeholder="Start writing...">${escapeHtml(note.body || '')}</textarea>
    </div>`;
}

let notesSaveTimer = null;
async function flushNotesSave() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = null;
  if (!cache.currentNote) return;
  const resp = await window.kinso.notesSave({ id: cache.currentNote.id, title: cache.currentNote.title, body: cache.currentNote.body });
  if (resp && resp.id) cache.currentNote.id = resp.id;
}

// Patches the in-memory note immediately (so typing feels instant) and writes the real file to
// disk after a short pause — same debounce shape the old JSON-store version used, just backed by
// a real file now. A rename (title change) is disambiguated on the main-process side, never
// clobbers another note.
function scheduleNotesSave(patch) {
  if (!cache.currentNote) return;
  Object.assign(cache.currentNote, patch);
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(flushNotesSave, 400);
}

// Wraps the current textarea selection in `marker` (e.g. **bold**, ==highlight==) — or, with
// nothing selected, inserts an empty pair and places the cursor between them ready to type.
function wrapNoteSelection(marker) {
  const ta = document.getElementById('noteBody');
  if (!ta) return;
  const start = ta.selectionStart, end = ta.selectionEnd;
  const value = ta.value;
  const selected = value.slice(start, end);
  ta.value = value.slice(0, start) + marker + selected + marker + value.slice(end);
  ta.focus();
  if (selected) ta.setSelectionRange(start + marker.length, end + marker.length);
  else ta.setSelectionRange(start + marker.length, start + marker.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------- Calendar ----------------

function overlaps(a, b) { return a.start < b.end && b.start < a.end; }
function conflictsFor(events, e) {
  return events.some(o => o.id !== e.id && o.date === e.date && overlaps(e, o));
}

function formatEventDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function renderCal() {
  if (!(settings && settings.google)) return renderGoogleSetup('Calendar');
  if (sub.pending) {
    return `${panelHeader(`<div class="p-title">Today</div>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
  }
  // Sort by date+time together, not just time-of-day — otherwise events on different days but
  // the same clock time (e.g. two 09:00 meetings a week apart) interleave out of order.
  const events = (cache.googleEvents || []).slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (sub.view === 'list') {
    const rows = events.map(e => `
      <div class="cal-row" data-id="${e.id}">
        <div class="cal-bar ${conflictsFor(events, e) ? 'conflict' : ''}"></div>
        <div>
          <div class="cal-title">${e.tentative ? '<span class="tent">Tentative: </span>' : ''}${escapeHtml(e.title)}</div>
          <div class="cal-meta">${formatEventDate(e.date)} · ${e.allDay ? 'All day' : `${e.start} – ${e.end}`}</div>
        </div>
      </div>`).join('');
    return `
      ${panelHeader(`<button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button><div class="p-title" style="margin-left:2px;">Today</div>`)}
      <div class="p-body">${rows}${!events.length ? `<div class="notif-empty">Nothing on your calendar today.</div>` : ''}</div>`;
  }
  if (sub.view === 'edit') {
    const e = events.find(x => x.id === sub.id);
    return `
      ${panelHeader(`<button class="p-icon-btn" data-act="cal-cancel-edit">${ic('ic-back')}</button><div class="p-title">Event</div>`)}
      <div class="p-body">
        <input class="notes-title-input" id="evTitle" value="${escapeHtml(e.title)}" placeholder="Event title" style="margin-bottom:12px;"/>
        <input id="evDate" type="date" value="${e.date}" style="width:100%; background:rgba(255,255,255,.06); border:1px solid var(--hairline); border-radius:8px; padding:6px 8px; color:var(--text-hi); font-size:12px; margin-bottom:12px;"/>
        <div style="display:flex; gap:8px; margin-bottom:12px;">
          <input id="evStart" type="time" value="${e.start}" style="flex:1; background:rgba(255,255,255,.06); border:1px solid var(--hairline); border-radius:8px; padding:6px 8px; color:var(--text-hi); font-size:12px;"/>
          <input id="evEnd" type="time" value="${e.end}" style="flex:1; background:rgba(255,255,255,.06); border:1px solid var(--hairline); border-radius:8px; padding:6px 8px; color:var(--text-hi); font-size:12px;"/>
        </div>
        <input id="evZoom" value="${escapeHtml(e.zoom || '')}" placeholder="Meeting link" style="width:100%; background:rgba(255,255,255,.06); border:1px solid var(--hairline); border-radius:8px; padding:8px; color:var(--text-hi); font-size:12px; margin-bottom:14px;" disabled/>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button class="p-icon-btn" data-act="cal-cancel-edit" style="width:auto; padding:0 12px; color:var(--text-lo);">Cancel</button>
          <button data-act="cal-save-edit" data-id="${e.id}" style="background:var(--text-hi); color:#111; border:none; border-radius:8px; padding:0 14px; height:28px; font-size:12px; font-weight:600; cursor:pointer;">Save</button>
        </div>
      </div>`;
  }
  // detail
  const e = events.find(x => x.id === sub.id);
  return `
    ${panelHeader(`
      <button class="p-icon-btn" data-act="cal-back">${ic('ic-back')}</button>
      <div class="spacer"></div>
      <button class="p-icon-btn" data-act="cal-edit">${ic('ic-pencil')}</button>
      <button class="p-icon-btn" data-act="cal-back">${ic('ic-close')}</button>
    `)}
    <div class="p-body">
      <div class="cal-detail-title">${escapeHtml(e.title)}</div>
      <div class="cal-detail-when">${formatEventDate(e.date)} · ${e.allDay ? 'All day' : `${e.start}–${e.end}`}${e.tentative ? ' (tentative)' : ''}</div>
      <div class="cal-detail-org">Organized by ${escapeHtml(e.organizer || 'you')}</div>
      ${e.zoom ? `<div class="zoom-row">${ic('ic-video')}<div class="zoom-url">${escapeHtml(e.zoom)}</div><button class="copy-btn" data-act="cal-copy-zoom" data-url="${escapeHtml(e.zoom)}">${ic('ic-copy')}</button></div>` : ''}
      ${e.htmlLink ? `<div class="zoom-row">${ic('ic-ext')}<div class="zoom-url">Open in Google Calendar</div><button class="copy-btn" data-act="cal-open-external" data-url="${escapeHtml(e.htmlLink)}">${ic('ic-ext')}</button></div>` : ''}
      <div class="invitees-label">Invitees ${e.awaiting ? `· ${e.awaiting}` : ''}</div>
      <div class="chip-row">${(e.invitees || []).map(v => `<span class="inv-chip"><span class="inv-avatar"></span>${escapeHtml(v)}</span>`).join('')}</div>
    </div>`;
}

// ---------------- Inbox ----------------

function renderInbox() {
  if (!(settings && settings.google)) return renderGoogleSetup('Inbox');
  if (sub.pending) {
    return `${panelHeader(`<div class="p-title">Inbox</div>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
  }

  if (sub.composing) {
    return `
      ${panelHeader(`<button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button><div class="spacer"></div>`)}
      <div class="p-body" style="padding-top:6px;">
        <div class="compose-modal">
          <input id="composeTo" placeholder="To" />
          <input id="composeSubject" placeholder="Subject" />
          <textarea id="composeBody" placeholder="Write a message..."></textarea>
          <div class="compose-actions">
            <button class="cancel" data-act="compose-cancel">Cancel</button>
            <button class="save" data-act="compose-save">Save draft</button>
          </div>
        </div>
      </div>`;
  }

  if (sub.view === 'detail') {
    const d = cache.gmailDetail;
    if (!d || d.id !== sub.id) {
      return `${panelHeader(`<button class="p-icon-btn" data-act="inbox-back">${ic('ic-back')}</button>`)}<div class="p-body"><div class="ai-thinking"><span></span><span></span><span></span></div></div>`;
    }
    return `
      ${panelHeader(`
        <button class="p-icon-btn" data-act="inbox-back">${ic('ic-back')}</button>
        <div class="spacer"></div>
        <button class="p-icon-btn" data-act="inbox-open-external">${ic('ic-ext')}</button>
        <button class="p-icon-btn" data-act="close">${ic('ic-close')}</button>
      `)}
      <div class="p-body">
        <div class="cal-detail-title">${escapeHtml(d.subject)}</div>
        <div class="cal-detail-org">From ${escapeHtml(d.from)}</div>
        <div class="zoom-row">${ic('ic-ext')}<div class="zoom-url">Open in Gmail</div><button class="copy-btn" data-act="inbox-open-external">${ic('ic-ext')}</button></div>
        <div class="notif-body-text" style="margin-top:10px; white-space:pre-wrap;">${escapeHtml(d.body)}</div>
      </div>
      <div class="p-foot">
        <div class="reply-box">
          <textarea id="replyInput" placeholder="Reply..."></textarea>
          <div class="reply-icons">
            <div class="grp"></div>
            <div class="grp"><button class="p-icon-btn" data-act="inbox-reply" style="width:22px;height:22px;background:var(--text-hi);color:#111;border-radius:50%;">${ic('ic-send')}</button></div>
          </div>
        </div>
      </div>`;
  }

  // No client-side filter here — loadInboxList() already scoped the query server-side
  // (is:unread vs in:inbox), so cache.gmail already holds exactly the right set.
  const rows = cache.gmail || [];
  return `
    ${panelHeader(`
      <button class="p-icon-btn" data-act="close">${ic('ic-fwd')}</button>
      <div class="spacer"></div>
      <button data-act="toggle-unread" style="background:none;border:1px solid var(--hairline); border-radius:8px; padding:0 10px; height:24px; font-size:11px; color:var(--text-lo); cursor:pointer;">${sub.unreadOnly ? 'Unread' : 'All'}</button>
      <button class="p-icon-btn" data-act="compose-open">${ic('ic-pencil')}</button>
    `)}
    <div class="p-body" style="padding-top:6px;">
      ${rows.map(r => `<div class="inbox-row ${r.unread ? 'unread' : ''}" data-act="open-row" data-id="${r.id}">
        <div class="inbox-avatar" style="background:#4285f4">${initials(parseFromName(r.from))}</div>
        <div class="inbox-main">
          <div class="inbox-top"><span class="inbox-from">${escapeHtml(parseFromName(r.from))}</span></div>
          <div class="inbox-preview">${escapeHtml(r.subject)} — ${escapeHtml(r.snippet)}</div>
        </div>
        ${r.unread ? '<span class="unread-dot"></span>' : ''}
      </div>`).join('')}
      ${!rows.length ? `<div class="notif-empty">Nothing here.</div>` : ''}
    </div>`;
}

// ---------------- wiring ----------------

function wire() {
  document.querySelectorAll('[data-act="close"]').forEach(b => b.addEventListener('click', () => setMode('idle')));

  const gConnectBtn = document.querySelector('[data-act="google-connect"]');
  if (gConnectBtn) gConnectBtn.addEventListener('click', connectGoogle);

  if (mode === 'ai') {
    const saveKeyBtn = document.getElementById('saveKeyBtn');
    if (saveKeyBtn) saveKeyBtn.addEventListener('click', async () => {
      const val = document.getElementById('apiKeyInput').value.trim();
      if (!val) return;
      settings = await window.kinso.setSettings({ apiKey: val });
      render();
    });
    const send = document.getElementById('aiSend');
    const input = document.getElementById('aiInput');
    if (send) send.addEventListener('click', () => { const v = input.value; input.value = ''; sendAIMessage(v); });
    if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !send.disabled) send.click(); });
    const newThread = document.querySelector('[data-act="new-thread"]');
    if (newThread) newThread.addEventListener('click', () => { aiThread = []; render(); });
  }

  if (mode === 'notif' && settings && settings.google && !sub.pending) {
    document.querySelectorAll('[data-act="open-notif"]').forEach(el => el.addEventListener('click', () => {
      const n = (cache.liveNotifs || []).find(x => x.id === el.dataset.id);
      if (!n) return;
      if (n.source === 'gmail') openInboxDetail(n.id);
      else openCalDetail(n.id);
    }));
    document.querySelectorAll('[data-act="dismiss-notif"]').forEach(el => el.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const id = el.dataset.id;
      const n = (cache.liveNotifs || []).find(x => x.id === id);
      if (n && n.source === 'gmail') {
        await window.kinso.gmailMarkRead(id);
        refreshUnreadDot();
      } else if (n && n.source === 'calendar') {
        const dismissed = (await loadStore('dismissedNotifs').catch(() => [])) || [];
        if (!dismissed.includes(id)) await saveStore('dismissedNotifs', [...dismissed, id]);
      }
      cache.liveNotifs = (cache.liveNotifs || []).filter(x => x.id !== id);
      render();
    }));
  }

  if (mode === 'notes' && !sub.pending) {
    document.querySelectorAll('.notes-list-item').forEach(el => el.addEventListener('click', async () => {
      const id = el.dataset.id;
      sub.view = 'edit'; sub.id = id; sub.recording = false; cache.currentNote = null; render();
      const note = await window.kinso.notesGet(id);
      cache.currentNote = note;
      render();
    }));
    const newNote = document.querySelector('[data-act="new-note"]');
    if (newNote) newNote.addEventListener('click', async () => {
      const resp = await window.kinso.notesSave({ id: null, title: 'Untitled', body: '' });
      cache.currentNote = { id: resp.id, title: 'Untitled', body: '' };
      sub.view = 'edit'; sub.id = resp.id; sub.recording = false; render();
    });
    const back = document.querySelector('[data-act="back-list"]');
    if (back) back.addEventListener('click', async () => {
      await flushNotesSave();
      sub.view = 'list'; sub.pending = true; render();
      cache.notes = await window.kinso.notesList();
      sub.pending = false; render();
    });
    const title = document.getElementById('noteTitle');
    if (title) title.addEventListener('input', () => scheduleNotesSave({ title: title.value }));
    const body = document.getElementById('noteBody');
    if (body) body.addEventListener('input', () => scheduleNotesSave({ body: body.value }));
    const rec = document.querySelector('[data-act="toggle-rec"]');
    if (rec) rec.addEventListener('click', () => { sub.recording = !sub.recording; render(); });
    const openExt = document.querySelector('[data-act="open-external"]');
    if (openExt) openExt.addEventListener('click', () => { if (cache.currentNote) window.kinso.notesOpenExternal(cache.currentNote.id); });
    const boldBtn = document.querySelector('[data-act="fmt-bold"]');
    if (boldBtn) boldBtn.addEventListener('click', () => wrapNoteSelection('**'));
    const hlBtn = document.querySelector('[data-act="fmt-highlight"]');
    if (hlBtn) hlBtn.addEventListener('click', () => wrapNoteSelection('=='));
    const cleanup = document.querySelector('[data-act="ai-cleanup"]');
    if (cleanup) cleanup.addEventListener('click', async () => {
      await loadSettings();
      if (!settings.apiKey) { showToast('Add an API key in the ✨ mode first'); return; }
      const bodyEl = document.getElementById('noteBody');
      showToast('Cleaning up…');
      const resp = await window.kinso.askAI(`Rewrite these raw meeting notes as tidy, short bullet points. Only output the bullets.\n\n${bodyEl.value}`, []);
      if (resp.ok) { bodyEl.value = resp.text.trim(); scheduleNotesSave({ body: bodyEl.value }); showToast('Cleaned up'); }
      else showToast('AI request failed');
    });
  }

  if (mode === 'cal' && settings && settings.google && !sub.pending) {
    document.querySelectorAll('.cal-row').forEach(el => el.addEventListener('click', () => { sub.view = 'detail'; sub.id = el.dataset.id; render(); }));
    const calBack = document.querySelector('[data-act="cal-back"]');
    if (calBack) calBack.addEventListener('click', () => { sub.view = 'list'; render(); });
    const calEdit = document.querySelector('[data-act="cal-edit"]');
    if (calEdit) calEdit.addEventListener('click', () => { sub.view = 'edit'; render(); });
    const calCancel = document.querySelector('[data-act="cal-cancel-edit"]');
    if (calCancel) calCancel.addEventListener('click', () => { sub.view = 'detail'; render(); });
    const calSave = document.querySelector('[data-act="cal-save-edit"]');
    if (calSave) calSave.addEventListener('click', async () => {
      const title = document.getElementById('evTitle').value.trim() || 'Untitled event';
      const date = document.getElementById('evDate').value || new Date().toISOString().slice(0, 10);
      const start = document.getElementById('evStart').value || '09:00';
      const end = document.getElementById('evEnd').value || '09:30';
      const id = calSave.dataset.id;
      await window.kinso.calendarUpdate(id, { title, date, start, end });
      const idx = (cache.googleEvents || []).findIndex(x => x.id === id);
      if (idx >= 0) cache.googleEvents[idx] = { ...cache.googleEvents[idx], title, date, start, end };
      sub.view = 'detail'; render();
    });
    const copyZoom = document.querySelector('[data-act="cal-copy-zoom"]');
    if (copyZoom) copyZoom.addEventListener('click', async () => { await window.kinso.copy(copyZoom.dataset.url); showToast('Link copied'); });
    const openExtCal = document.querySelector('[data-act="cal-open-external"]');
    if (openExtCal) openExtCal.addEventListener('click', () => window.kinso.openExternal(openExtCal.dataset.url));
  }

  if (mode === 'inbox' && settings && settings.google) {
    document.querySelectorAll('[data-act="open-row"]').forEach(el => el.addEventListener('click', () => openInboxDetail(el.dataset.id)));
    const toggleUnread = document.querySelector('[data-act="toggle-unread"]');
    if (toggleUnread) toggleUnread.addEventListener('click', async () => {
      sub.unreadOnly = !sub.unreadOnly;
      sub.pending = true; render();
      await loadInboxList();
      sub.pending = false; render();
    });
    const inboxBack = document.querySelector('[data-act="inbox-back"]');
    if (inboxBack) inboxBack.addEventListener('click', async () => {
      sub.view = 'list'; sub.pending = true; render();
      await loadInboxList();
      sub.pending = false; render();
    });
    document.querySelectorAll('[data-act="inbox-open-external"]').forEach(el => el.addEventListener('click', () => {
      if (cache.gmailDetail) window.kinso.openExternal(cache.gmailDetail.webLink);
    }));
    const inboxReply = document.querySelector('[data-act="inbox-reply"]');
    if (inboxReply) inboxReply.addEventListener('click', async () => {
      const ta = document.getElementById('replyInput');
      if (!ta.value.trim()) return;
      const d = cache.gmailDetail;
      inboxReply.disabled = true;
      const resp = await window.kinso.gmailReply({ threadId: d.threadId, to: d.from, subject: d.subject, messageIdHeader: d.messageIdHeader, body: ta.value.trim() });
      inboxReply.disabled = false;
      if (resp.ok) { ta.value = ''; showToast('Reply sent'); }
      else showToast('Reply failed: ' + (resp.error || 'unknown error'));
    });
    const composeOpen = document.querySelector('[data-act="compose-open"]');
    if (composeOpen) composeOpen.addEventListener('click', () => { sub.composing = true; render(); });
    const composeCancel = document.querySelector('[data-act="compose-cancel"]');
    if (composeCancel) composeCancel.addEventListener('click', () => { sub.composing = false; render(); });
    const composeSave = document.querySelector('[data-act="compose-save"]');
    if (composeSave) composeSave.addEventListener('click', async () => {
      const drafts = (await loadStore('drafts').catch(() => [])) || [];
      drafts.push({
        id: uid(),
        to: document.getElementById('composeTo').value,
        subject: document.getElementById('composeSubject').value,
        body: document.getElementById('composeBody').value,
        at: new Date().toISOString()
      });
      await saveStore('drafts', drafts);
      sub.composing = false; render();
      showToast('Draft saved locally');
    });
  }
}

// ---------------- boot ----------------

window.kinso.onOpenAI(() => openMode('ai'));
window.kinso.onDockSide(side => document.body.classList.toggle('dock-left', side === 'left'));

(async function boot() {
  await loadSettings();
  if (settings.google) { refreshUnreadDot(); startUnreadPolling(); }
  renderRail();
  render();
})();
