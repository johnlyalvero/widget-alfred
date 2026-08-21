# Kinso — Documentation

Personal-use Linux/Electron rebuild of a macOS desktop-companion widget: a small
icon rail docked to the screen edge that expands into five panels — an AI
assistant ("Alfred"), Notifications, Notes, Calendar, and Inbox. Originally
scaffolded from a reference demo video (see `functional-spec.md` and
`reference-frames/`), then progressively rebuilt so each panel talks to real
data instead of sample content.

This document covers both **what it does** (functional) and **how it's built**
(technical). For day-to-day setup (install, Google connection steps, settings
file), see `../app/README.md` — this document goes deeper and stays current
with the actual code, not the original spec.

---

## 1. Functional overview

### 1.1 The rail and panel

A 56px icon rail docks to the right edge of whichever monitor the cursor is
on, vertically centered, 2px from the edge. Clicking an icon expands a panel
next to the rail (406×418px → as of the current build, **1.5×** that:
576×626px); clicking the same icon again, or a panel's back/close control,
collapses it. Position re-evaluates on every open/close/mode-switch, and on
demand via the global hotkey `Control+Shift+K` (configurable in
`settings.json`), which is the only way to move the widget to a different
monitor without first being able to click it there.

The five modes, left to right in the rail: **Alfred** (sparkle), **Notifications**
(bell), **Notes** (doc), **Calendar** (cal), **Inbox** (envelope).

### 1.2 Alfred (AI assistant)

- Chat interface wired to **OpenRouter** (not Anthropic directly) — add your
  own OpenRouter API key inline the first time you open the panel. Defaults
  to the free `openai/gpt-oss-20b:free` model; any OpenRouter model id can be
  set in `settings.json`.
- Named after Batman's butler. Both the UI (panel title, input placeholder,
  tray menu item) and its own system-prompt persona identify it as Alfred.
- **Tool-calling**: Alfred can look things up rather than only working from
  what's in the chat. Five read-only tools:
  - `list_notes` / `read_note` — Obsidian vault, always available.
  - `list_calendar_events` — Google Calendar, only offered once Google is
    connected.
  - `list_emails` / `read_email` — Gmail, only offered once Google is
    connected.
  - Tools are **omitted from the request entirely** (not just unused) when
    their backing connection isn't there, so the model never attempts a call
    it can't serve.
  - Deliberately read-only: Alfred can find and summarize a note, tell you
    what's on your calendar, or read you an email — but it never sends mail,
    edits an event, or modifies a note itself. Those stay manual actions in
    their own panels, so nothing real happens without you seeing it happen
    directly in the UI that does it.
- Replies render as real **Markdown** (bold, headings, lists, inline code,
  fenced code blocks, tables, links, blockquotes) via a vendored copy of
  `marked`, not literal `**`/`#`/`|` characters. Your own messages render as
  plain text — no reason to interpret markdown you didn't intend as
  formatting.
- The wand icon in the Notes panel also calls Alfred (a single-shot rewrite
  request, not the tool-calling chat) to tidy a note into bullet points.

### 1.3 Notifications

A live feed, not a static list. Gated behind Google connection — shows a
"Connect Google" prompt otherwise, since without it there's nothing real to
show.

- Merges **unread Gmail** (up to 8) and **today's remaining Calendar events**
  (up to 5, deliberately bounded to today — see §3.6 for why) into one list,
  each row tagged with a type icon (inbox icon for mail, calendar icon for
  events).
- Each row has a **dismiss (×)** button: for a Gmail row this marks the
  message read via the real API; for a Calendar row this hides it from the
  feed going forward (persisted locally — see §3.5, since Calendar events
  have no "read" state to piggyback on).
- Clicking a row (not the × button) jumps into the relevant dedicated panel
  — Inbox for mail, Calendar for events — already showing that specific item.
- The rail's bell dot reflects a **live background poll** (every 30s) of
  whether unread mail exists, independent of whether any panel is open — see
  §3.7.

### 1.4 Notes

Direct access to a real Obsidian vault folder —
`~/Documents/Obsidian/vault/1 - Rough Notes` — not app-owned sample data.
Every note in the list is a real `.md` file in that folder; creating,
editing, and renaming operate on the real files.

- **Title = filename.** Renaming the title field renames the file on disk,
  auto-disambiguated with a numeric suffix if another file already has that
  name — it will never silently overwrite another note.
- Autosaves ~400ms after you stop typing (same debounce shape the app already
  used elsewhere), and always flushes any pending save before navigating away
  from a note.
- **`B` / `H` toolbar buttons** wrap the current text selection in
  `**bold**` / `==highlight==` — Obsidian's own markdown syntax, so it
  renders correctly there too. With no selection, they insert an empty pair
  with the cursor placed between them.
- **`↗`** (the panel's external-link icon) opens the note directly in
  Obsidian via an `obsidian://open?...` URI (requires Obsidian installed and
  registered for that URI scheme).
- The wand icon rewrites the note body via Alfred into tidy bullets.
- **No delete** from inside Kinso — remove a note from the vault or Obsidian
  itself. This was a deliberate scope boundary, not an oversight.
- The REC pill is a purely client-side, session-only visual toggle — no real
  audio capture, and (unlike everything else in this panel) it is not
  persisted, since there's nowhere sensible to store an arbitrary flag on a
  plain markdown file without polluting it with frontmatter.

### 1.5 Calendar

Shows **only** real Google Calendar events — no local/sample data. Gated
behind Google connection the same way Notifications and Inbox are.

- Lists events for the **next 6 months** (bounded — see §3.6), sorted
  correctly by date-then-time (not just time-of-day, which used to interleave
  events from different days that happened to share a clock time), each row
  showing a formatted date (`Aug 22, 2026`) plus time range or `All day`.
- Editing an event (title/date/time) really `PATCH`es it on Google Calendar.
- **`↗`** in the detail view opens the event on the real Google Calendar web
  UI.
- **No add, no delete** — only modify. The original task explicitly asked
  for "modify," not creation or deletion, and this is a deliberate,
  maintained scope boundary rather than a missing feature.
- "Copy" on a meeting link (Google Meet, if the event has one) copies it to
  the clipboard.

### 1.6 Inbox

Real Gmail, not sample rows.

- Defaults to showing **unread only** on open (toggleable to "All"). The
  unread query is a real server-side Gmail search (`is:unread in:inbox ...`),
  not a client-side filter over the most-recent N messages — see §3.8 for why
  that distinction matters.
- Both the unread filter and the general list **exclude Gmail's Promotions,
  Social, and Updates categories** — effectively just the Primary tab. Tuned
  in one place (`GMAIL_EXCLUDE_CATEGORIES` in `main.js`), applied everywhere
  Gmail is queried (Inbox, the bell dot, Notifications).
- Clicking a message opens a detail view: full body, a real **reply** box
  (sends via the Gmail API, threaded correctly using the original message's
  RFC `Message-Id`, not Gmail's internal id), and an **`↗`** link to open the
  thread in Gmail's own web UI.
- Compose stays a **local-only draft** (`drafts.json`) — nothing is actually
  sent from there. This was an explicit, deliberate scope boundary: replying
  to an existing thread is real; composing new mail is not (not asked for).

---

## 2. Architecture

### 2.1 Process layout

Standard three-part Electron split, each in `app/src/`:

| File | Process | Role |
|---|---|---|
| `main.js` (~820 lines) | Main (Node) | Window/tray/hotkey management, all external API calls (Google OAuth, Gmail, Calendar, OpenRouter, Obsidian filesystem), local JSON store, IPC handlers |
| `preload.js` (29 lines) | Preload (isolated) | The *only* bridge between renderer and main — exposes a frozen `window.kinso` object via `contextBridge.exposeInMainWorld` |
| `renderer/app.js` (~760 lines) | Renderer (Chromium page) | All UI: rendering, state, wiring. Talks to `main.js` exclusively through `window.kinso.*` |
| `renderer/styles.css`, `renderer/index.html` | Renderer | Styling and the static shell (rail/panel containers, inline SVG icon sprite) |

**Security posture**: `contextIsolation: true`, `nodeIntegration: false`, and
a `Content-Security-Policy` meta tag restricting scripts/styles to `'self'`
(index.html). The renderer never touches Node or Electron APIs directly — it
can only call the specific functions `preload.js` chose to expose, and that
exposed object is frozen (verified: `Object.isFrozen(window.kinso) === true`,
reassigning a property on it silently no-ops). `app.disableHardwareAcceleration()`
is set at startup — a workaround for a GPU/compositor rendering artifact
during window resize (see §3.9), not a general default.

### 2.2 IPC surface

Every channel `preload.js` exposes, and what it does in `main.js`:

| `window.kinso.*` | IPC channel | Notes |
|---|---|---|
| `getStore(name)` / `setStore(name, data)` | `store:get` / `store:set` | Generic — reads/writes `~/.config/Kinso/data/<name>.json`. Any name works; no allowlist. Currently backs `drafts` and `dismissedNotifs`. |
| `getSettings()` / `setSettings(partial)` | `settings:get` / `settings:set` | Reads/merges `~/.config/Kinso/settings.json` |
| `askAI(message, history)` | `ai:ask` | The Alfred tool-calling loop (§3.3) |
| `setMode(mode)` | `ui:set-mode` (send, not invoke) | Triggers `applyBounds()` — repositions/resizes the window for the new mode |
| `onOpenAI(cb)` / `onDockSide(cb)` | `hotkey:open-ai` / `dock:side` (main→renderer) | Tray "Open Alfred" and the rail/panel left↔right CSS flip |
| `openExternal(url)` | `shell:open-external` | Generic `shell.openExternal` — used by every "open in browser" link |
| `copy(text)` | `clipboard:copy` | |
| `quit()` | `app:quit` | |
| `googleStatus()` / `googleConnect(creds)` / `googleDisconnect()` | `google:status` / `google:connect` / `google:disconnect` | OAuth loopback flow (§3.2) |
| `gmailList(opts)` / `gmailHasUnread()` / `gmailGet(id)` / `gmailReply(payload)` / `gmailMarkRead(id)` | `gmail:*` | §3.4 |
| `calendarList(opts)` / `calendarUpdate(id, patch)` | `calendar:*` | §3.4 |
| `notesList()` / `notesGet(id)` / `notesSave(payload)` / `notesOpenExternal(id)` | `notes:*` | §3.5 |

### 2.3 Local storage

Three separate things live under `~/.config/Kinso/`, and it's worth keeping
them straight:

1. **`settings.json`** — the only credential/preference store. Shape:
   ```json
   {
     "firstName": "there",
     "apiKey": null,
     "model": "openai/gpt-oss-20b:free",
     "hotkey": "Control+Shift+K",
     "googleClientId": null,
     "googleClientSecret": null,
     "google": null
   }
   ```
   `apiKey` is the OpenRouter key. `google` holds
   `{ refreshToken, accessToken, expiresAt, email }` once connected, or
   `null`. There is currently no UI to clear `google` — edit the file
   directly and restart to disconnect (matches how there's also no UI to
   clear `apiKey`).
2. **`data/*.json`** — the generic local store from `store:get`/`store:set`.
   Only two files actually get written today: `drafts.json` (Inbox compose)
   and `dismissedNotifs.json` (dismissed Calendar-sourced notification ids —
   §3.5). Older files from earlier iterations of this app
   (`notifications.json`, `inbox.json`, `notes.json`, `events.json`) are
   orphaned: nothing reads or writes them anymore, since those panels moved
   to real data sources. They're harmless if still present on disk from a
   previous install, just unused.
3. **The Obsidian vault itself** — `~/Documents/Obsidian/vault/1 - Rough
   Notes/*.md`. Not under `~/.config/Kinso/` at all, and not app-owned; the
   Notes panel is a thin, careful window onto files that exist independently
   of this app.

---

## 3. Technical deep dives

### 3.1 Window docking and multi-monitor behavior

`boundsFor(mode, display)` in `main.js` computes bounds off
`screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` — the display
under the *cursor*, not the OS's notion of "primary," which matters a lot on
an asymmetric multi-monitor layout. The dock side is always right (a
left-follows-cursor mode was tried and reverted — made reasoning about
placement unpredictable for no real benefit). Width/height are fixed per
mode (`RAIL_W`×`WIDGET_H` idle, `EXPANDED_W`×`EXPANDED_H` expanded — see
`PANEL_SCALE = 1.5` for the current sizing multiplier on the expanded panel
specifically; the idle rail is unaffected), and x/y are recomputed to stay
right-edge-docked and vertically centered on whichever display was resolved.

**Wayland**: positioning silently doesn't work at all — not flaky, a hard
protocol limitation (Wayland deliberately doesn't let a client set its own
absolute screen position). Forcing XWayland was tried and made things worse
(GPU crash-loops on the machine this was built on). The reliable path is a
real X11 session ("Ubuntu on Xorg" from the login screen), where positioning,
including the cursor-following monitor selection, works exactly as written.

### 3.2 Google OAuth (loopback flow)

`google:connect` implements the installed-app loopback flow Google
recommends for desktop apps:

1. Starts a one-shot `http.createServer` on an OS-assigned port
   (`listen(0, '127.0.0.1')`).
2. Opens the system browser to Google's consent screen via
   `shell.openExternal`, with that port baked into the `redirect_uri`. No
   port needs pre-registration — Google's "Desktop app" OAuth client type
   auto-permits any `http://127.0.0.1:<port>` loopback redirect.
3. On the callback hit, exchanges the code at
   `https://oauth2.googleapis.com/token`, fetches the connected email via
   `gmail.googleapis.com/.../profile`, persists
   `{ googleClientId, googleClientSecret, google: {...} }` to settings, and
   closes the server. 120s timeout guard.

Scopes requested: `gmail.modify`, `gmail.send`, `calendar.events` — enough
for read + mark-read + send + read/write events, nothing broader (no full
`https://mail.google.com/`, no full `calendar` scope with calendar-list/
delete access).

`getGoogleAccessToken()` is the shared helper every Gmail/Calendar call goes
through: returns the cached access token if not expired, otherwise refreshes
via `grant_type=refresh_token` and persists the new token. `prompt=consent`
is forced on connect so Google always issues a refresh token, even on repeat
authorizations.

**Known caveat documented for the user**: while the Google Cloud OAuth
consent screen stays in "Testing" publishing status, issued refresh tokens
expire after 7 days, forcing a weekly reconnect. Flipping to "Production"
avoids this (still fine unverified for solo use — a one-time "Google hasn't
verified this app" click-through per consent, not a functional block).

### 3.3 Alfred's tool-calling loop

`ai:ask` builds a standard OpenAI-shaped tool-calling loop (OpenRouter passes
this through uniformly to compatible models — confirmed working with the
free default model, `openai/gpt-oss-20b:free`, which does support
`tool_calls` correctly):

```
messages = [system, ...history, user]
loop up to 4 rounds:
  POST /chat/completions { model, messages, tools }
  if response has tool_calls:
    push the assistant's tool_calls message onto messages
    for each call: run it, push { role: 'tool', tool_call_id, content: JSON }
    continue loop
  else:
    return the text content — done
```

The tool implementations (`runAlfredTool`) call the *same* internal
functions the IPC handlers use — `gmailListImpl`, `gmailGetImpl`,
`calendarListImpl`, `notesListImpl`, `notesGetImpl` — extracted once as
named `async function`s specifically so both the direct-IPC path (renderer
UI actions) and the tool-calling path (Alfred deciding to look something up)
share one implementation, not two copies that could drift.

`tools` is filtered per-request: Calendar/Gmail tools are only included when
`settings.google.refreshToken` exists, so a disconnected user's Alfred never
sees (and can't attempt) a tool it would just fail.

### 3.4 Gmail / Calendar API specifics worth knowing

- **Gmail body extraction** (`extractBody`) recurses into `payload.parts` at
  *every* level, not just the top one — Gmail nests `multipart/alternative`
  inside `multipart/mixed` whenever a message has an attachment or inline
  image, which is the common case, not an edge case. Prefers `text/plain`,
  falls back to `text/html` with tags stripped.
- **Reply threading** uses the *real* RFC `Message-Id` header
  (`messageIdHeader`, captured by `gmail:get`) for `In-Reply-To`/`References`
  — not Gmail's own `id`/`threadId`, which would thread correctly inside
  Gmail's own UI (it groups by `threadId` regardless) but silently break
  threading for any other mail client viewing the same thread.
- **Calendar timezone**: `calendar:update` stamps `start`/`end` with the
  local IANA timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone`
  — resolves correctly to the real OS timezone from Electron's main process
  (bundled Node ships full ICU).

### 3.5 Why some things need a local persisted "dismissed" list

Gmail has a real `UNREAD` label the app can toggle — marking a Notifications
card's mail as read via the API *is* the persistence; there's nothing extra
to track. Google Calendar events have no equivalent "dismissed" concept.
Early on, dismissing a Calendar-sourced Notifications card only cleared the
in-memory list for that session — closing and reopening the panel re-fetched
the same upcoming events and they'd reappear, which read as a bug (it was
one). Fixed by tracking dismissed Calendar event ids in
`dismissedNotifs.json` (via the generic `store:get`/`store:set` — no new IPC
needed) and filtering them out on every fetch.

### 3.6 Why Notifications and Calendar have different time windows

Recurring Google Calendar events expand into a distinct event id per
occurrence (`singleEvents: true`). An unbounded "soonest N events" fetch,
combined with dismissal freeing up a slot, meant dismissing a recurring
event's occurrences just kept pulling in occurrences further and further into
the future to backfill — for a twice-daily recurring meeting, that surfaced
as "dismissed notifications that never stop coming back." Two different,
deliberately-chosen bounds fix this for their respective contexts:

- **Notifications**: bounded to *today* (`timeMax` = end of today) — matches
  what a "notification" should mean (imminent), and a recurring event's
  tomorrow-occurrence is correctly treated as a new day's notification, not
  a repeat of one already dismissed.
- **Calendar** (the full panel, not the notification feed): bounded to the
  *next 6 months* — otherwise yearly-recurring events (birthdays) pushed the
  list years into the future instead of showing what's actually coming up.
  Fetch cap raised to `max: 500` (from an earlier `15`) since the time bound,
  not an arbitrary count, is meant to be the limiting factor.

Both reuse one `calendar:list` handler with an optional `timeMax` parameter
— the Calendar panel's own fetch and the Notifications feed's fetch just pass
different values.

### 3.7 The bell dot: why it polls, and why it doesn't trust cached state

Two bugs, found and fixed in sequence:

1. **Staleness**: the dot originally derived from whatever the Notifications
   feed last fetched (`cache.liveNotifs`). Reading mail via the Inbox panel
   directly (bypassing a Notifications-card click) never touched that cache,
   so the dot could stay lit long after the real unread mail was gone. Fixed
   by a single `refreshUnreadDot()` helper — calls the cheap
   `gmail:has-unread` check and is now invoked from every point unread state
   could plausibly change (boot, opening Notifications, opening Inbox,
   marking a message read, dismissing a Gmail notification card) — plus:
2. **Live polling**: none of those trigger points fire for mail that arrives
   while the user isn't touching the app at all. `startUnreadPolling()`
   wraps `refreshUnreadDot` in a 30-second `setInterval`, started once at
   boot (if already connected) or immediately after a fresh `google:connect`
   succeeds. The renderer keeps running while idle (the window is only
   resized/hidden, never destroyed), so the interval keeps firing regardless
   of whether a panel is open — verified directly against real timestamps
   (three fires 30000ms/29999ms apart with zero manual interaction).

### 3.8 Inbox's "Unread" filter: server-side query, not client-side slice

An earlier version fetched the 15 most-recent inbox messages and filtered
client-side for `unread === true`. That silently breaks the moment an unread
message isn't among the 15 most recent — a perfectly real, older unread email
sitting further back in the inbox would never show under "Unread," even
though the bell dot (which searches Gmail directly for `is:unread`) correctly
flagged it. Fixed by making `unreadOnly` change the actual Gmail search query
(`is:unread in:inbox ...` vs `in:inbox ...`) server-side, so what the list
shows and what the dot means are always the same set.

### 3.9 The open/close resize "flash," and why it's fixed by hiding, not by explaining it

`applyBounds()` doesn't just resize the window between idle and expanded —
it also *moves* it (staying right-edge-docked and vertically centered means
idle↔expanded is roughly a 500px position jump, not a pure resize). On this
GPU/compositor combination, something was visibly rendering mid-transition
regardless of a couple of earlier mitigations already in the code
(`app.disableHardwareAcceleration()`, an explicit opaque `backgroundColor`
noted as workarounds for a suspected GPU-swapchain artifact and a
newly-exposed-pixel paint flash, respectively — see the comments in
`main.js` and `styles.css`). Rather than continue chasing the exact
low-level cause, `applyBounds()` now hides the window for the duration of the
bounds change and shows it again after:

```js
const wasVisible = win.isVisible();
if (wasVisible) win.hide();
win.setBounds(bounds);
win.webContents.send('dock:side', bounds.dockSide);
if (wasVisible) win.show();
```

This is a structural guarantee, not a probabilistic fix — nothing is ever
presented to the screen mid-transition, so there's nothing to flash,
regardless of what would have caused it.

### 3.10 Notes: filesystem safety

Because Notes reads/writes real files (unlike every other local store, which
is app-owned JSON in `~/.config/Kinso/`), every handler resolves a given
filename against `NOTES_VAULT_DIR` via `path.resolve` and refuses anything
that would escape it (`safeNotePath`) — a defensive guard against path
traversal, appropriate now that this is genuine filesystem access rather than
the sandboxed local JSON store the rest of the app uses.

### 3.11 Markdown rendering (Alfred's replies)

`marked` (a small, dependency-free CommonMark/GFM parser) is used, but the
renderer process can't `require()` an npm package directly —
`contextIsolation: true` / `nodeIntegration: false` means only `preload.js`
has any Node access, and this is a purely synchronous, CPU-only operation
with no reason to round-trip through IPC. Its browser-ready UMD build is
vendored directly into `renderer/vendor/marked.umd.js` and loaded via a plain
`<script>` tag before `app.js` — confirmed to load cleanly under the page's
existing `script-src 'self'` CSP. `breaks: true` is set so a single newline
in a reply reads as a line break, matching how models actually format
answers (not full CommonMark's "needs a blank line" rule). Only assistant
messages are rendered as markdown; the user's own typed messages stay plain
escaped text.

---

## 4. Known limitations / deliberate non-goals

These are choices, not gaps waiting to be filled — listed so they don't get
mistaken for bugs:

- **No write/send/delete from Alfred.** Chat can look things up, never act.
- **No note deletion** from inside the app (vault/Obsidian handles that).
- **No Calendar add/delete**, only modify — matches what was actually asked
  for.
- **Compose in Inbox is local-draft-only** — nothing is sent from there.
- **No Gmail push notifications** — the 30s poll is the mechanism; there's no
  Cloud Pub/Sub push subscription (would need a public HTTPS endpoint and
  weekly watch renewal — disproportionate for a personal single-user app).
- **REC pill in Notes is cosmetic** — no real audio capture, not persisted.
- **No UI to disconnect Google or clear the OpenRouter key** — both are
  edit-the-JSON-file-directly operations for now.

## 5. Build & run

```bash
cd app
npm install
npm start          # electron . --no-sandbox — sandboxed chrome-sandbox
                    # binary isn't setuid after a plain npm install; see
                    # README.md for the fully-sandboxed alternative
npm run dist        # electron-builder → AppImage + .deb under dist/
```

No test suite exists. Verification throughout this project's development has
been done by driving the actual running app — via Chrome DevTools Protocol
(`--remote-debugging-port`, scripted clicks and `Runtime.evaluate`) for
functional checks, and screen capture for visual/rendering checks — rather
than unit tests, since almost everything of substance here is either a real
external API integration or real-window rendering behavior that a unit test
wouldn't exercise.
