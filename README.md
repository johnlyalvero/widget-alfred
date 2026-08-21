# Widget Alfred

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Linux/Electron rebuild of the 5-mode desktop-companion widget documented in
`docs/functional-spec.md`. Personal-use only — see the naming note in that spec before
sharing this with anyone else.

## Run it

```bash
cd app
npm install
npm start
```

A small icon rail appears docked near the right edge of your screen, vertically centered, 2px
from the border. Click an icon to expand its panel; click it again (or the panel's back/close
icon) to collapse back to the rail. The position is fixed — it is not draggable right now (see
"Position" below for how to move it).

- Global hotkey: `Control+Shift+K` relocates the widget to whichever monitor your cursor is
  currently on — it doesn't open or change any panel, just moves. Handy since you can't click a
  panel that isn't on your current screen: move the mouse, press the hotkey, *then* click.
  Change the key by editing `hotkey` in the settings file (see below) and restarting the app.
- A tray icon (sparkle mark) gives you Show/Hide, **Open Alfred** (this one does open the AI
  panel), and Quit.

## What's really functional vs. sample data

| Mode | What works |
|---|---|
| Notifications | Genuinely wired to your Google account once connected (see below): a live feed of unread Gmail + upcoming Calendar events as snip cards, cycled with `›`. `✓` marks a Gmail card read for real; clicking a card opens the full item in Inbox or Calendar. Before connecting, shows a "Connect Google" prompt instead of sample data |
| Notes | Direct access to your real Obsidian vault — reads and writes actual `.md` files in `~/Documents/Obsidian/vault/1 - Rough Notes`, not app-owned data. Create/edit notes, autosaved to disk; renaming the title renames the file (auto-disambiguated, never clobbers another note). `B`/`H` buttons wrap the selection in `**bold**`/`==highlight==`. The wand icon calls the model to tidy the note into bullets, if you've added an API key. `↗` opens the note in Obsidian itself (`obsidian://` link — needs Obsidian installed). No delete from within Kinso — remove a note from the vault/Obsidian directly. The REC pill is a visual toggle only — no real audio capture, and it's not persisted (nothing to save it to on a plain markdown file) |
| Calendar | Shows only your real Google Calendar — no local/sample events. Gated behind Google connection (shows a "Connect Google" prompt until then). Editing an event really updates it on Google, with an "Open in Google Calendar" link. "Copy" on a meeting link copies to your clipboard. No add/delete from within Kinso — only modify, matching what's actually wired up |
| Inbox | Genuinely wired to Gmail once connected: real message list, click a row to read the full email, reply for real, "Open in Gmail" link. Before connecting, shows a "Connect Google" prompt. Compose stays a local-only draft (`drafts.json`) — nothing is sent from there |
| Alfred | The AI panel (named for Batman's butler) — genuinely wired to the OpenRouter API, add your own key inline the first time you open it. Defaults to the free `openai/gpt-oss-20b:free` model, but you can point `model` at any OpenRouter model id. Has read-only tool access to your Obsidian notes always, and to Calendar/Gmail once Google is connected — it can look things up ("what's on my calendar tomorrow?", "any notes about X?", "read me that email from Y") but never sends mail or edits the calendar itself; those stay manual actions in their own panels |

All local sample/seed data lives in `data/*.json` and is copied into your user data directory
on first run (`~/.config/Kinso/data/`) — edit either the seed files here (for a fresh install)
or the copies in `~/.config/Kinso/data/` (for your running app) to change what's shown for the
still-local pieces (Notes, local Calendar events).

## Connecting your Google account (Gmail + Calendar)

Notifications and Inbox need this; Calendar works without it but merges in real events once
connected. This is a one-time setup you do in Google Cloud, since only your own Google account
can create it:

1. [console.cloud.google.com](https://console.cloud.google.com) → create or pick a project →
   **APIs & Services → Library** → enable **Gmail API** and **Google Calendar API**.
2. **APIs & Services → OAuth consent screen** → User type **External** → add your own email as
   a **test user**. While the app stays in "Testing" publishing status, Google expires refresh
   tokens after 7 days (you'd need to reconnect weekly) — flip publishing status to
   **In production** to avoid that. It's still fine unverified for solo/personal use; you'll
   just click through a one-time "Google hasn't verified this app" warning per consent.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → application type
   **Desktop app**. Copy the **Client ID** and **Client Secret** it gives you.
4. Open Notifications or Inbox in Kinso, paste the Client ID and Secret into the "Connect"
   screen, and click Connect. Your system browser opens Google's real consent screen — approve
   it there, and Kinso picks up the connection automatically, no restart needed.

Scopes requested: `gmail.modify`, `gmail.send`, `calendar.events` — read/reply/mark-read for
mail, read/write for calendar events. Nothing broader (no full-account access, no calendar
deletion).

## Settings & your API key

Stored locally, never anywhere else, at `~/.config/Kinso/settings.json`:

```json
{
  "firstName": "there", "apiKey": null, "model": "openai/gpt-oss-20b:free", "hotkey": "Control+Shift+K",
  "googleClientId": null, "googleClientSecret": null, "google": null
}
```

Set `firstName` for the AI panel's greeting. `apiKey` and the `google*` fields are all easiest
to set from inside the app (each panel prompts for what it needs), but you can also paste them
here directly. `google` holds the OAuth tokens once connected — like the AI key, there's no
disconnect button in the UI yet, so set `google` back to `null` here and restart to disconnect.

**Position**: not a setting — the widget always docks to the **right edge** of whichever monitor
your cursor is currently on, re-evaluated whenever it opens, closes, or switches panels, and also
on demand via the global hotkey (see above) — the deliberate way to move it across monitors,
since you can't click a panel that isn't on your screen yet. It's always vertically centered, 2px
from that edge. Left-edge docking was tried too (side following left/right cursor position, not
just which monitor) but made testing/reasoning about where it'd land unpredictable on an
asymmetric layout, for no real benefit — dropped in favor of a fixed right side. Dragging is gone
entirely; it was causing the window to blow up and cover the whole screen when a drag didn't end
cleanly, so I pulled it out rather than leave something flaky in place. Happy to take another pass
at it later with a more robust approach if you want it back.

Position only actually applies on a real X11 session — GNOME's Wayland session doesn't let apps
position their own windows at all (see "Known Linux caveats" below), so on Wayland this widget
still renders, just wherever the compositor decides to put it, and stays there.

## Known Linux caveats

- **Sandbox helper**: a plain `npm install` leaves Electron's `chrome-sandbox` helper without
  the root-owned setuid bit it needs, so `npm start` runs with `--no-sandbox` by default. That's
  fine here — the app never loads remote or untrusted content, only its own local files, with
  `contextIsolation` on and `nodeIntegration` off. If you'd rather run fully sandboxed:
  ```bash
  sudo chown root app/node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 app/node_modules/electron/dist/chrome-sandbox
  cd app && npm run start:sandboxed
  ```
- **Always-on-top on Wayland**: GNOME's Wayland compositor (Mutter) has weaker, less consistent
  support for "stay above everything" than X11 does. The app asks for the strongest level
  Electron exposes (`screen-saver`) and re-asserts it on blur/show as a safety net. I also tried
  forcing the app through XWayland (X11 compatibility), which has much more mature always-on-top
  support — but in this environment that made the GPU process crash-loop, so it's reverted. If
  always-on-top is still flaky for you, logging into an "Ubuntu on Xorg" session from the login
  screen (rather than forcing it from inside the app) is the safer way to get X11's behavior.
- **Positioning on Wayland doesn't work at all, not just "flaky"**: this isn't an Electron bug —
  the Wayland protocol deliberately doesn't let a client set its own absolute screen position, so
  `BrowserWindow.setBounds()`'s `x`/`y` is silently ignored by Mutter no matter what the app asks
  for. Forcing XWayland to work around it looks promising (`setBounds()` reports success,
  `getCursorScreenPoint()` returns real coordinates) but on at least one machine tested here the
  resulting window never actually got mapped by the compositor — it ran, answered geometry
  queries, and drew nothing. The reliable fix is the same "Ubuntu on Xorg" login session
  mentioned above; under a real X11 session (not XWayland-under-Wayland) positioning, including
  the cursor-following monitor selection described under Settings, works exactly as written.
- No settings UI exists yet beyond the API key field — everything else is edit-the-JSON-file
  for now.

## Packaging (optional, for later)

`cd app && npm run dist` uses `electron-builder` to produce an AppImage and a `.deb` under
`app/dist/` — see `docs/functional-spec.md` for the fuller production-readiness checklist
(testing, CI, icons, auto-update) before you'd want to actually ship this to another machine.
