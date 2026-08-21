# Functional Specification — "Kinso"-style Desktop Companion (Linux reconstruction)

Source material: `clip_inspo.mp4` (720×1280, 29.4s, 30fps) — a vertical promo/demo reel for a macOS
menu-bar-adjacent AI desktop widget. Reference frames extracted to `docs/reference-frames/`.

> **Naming/trademark note:** the source app is branded "Kinso" (visible in the demo's own inbox:
> "U.S. Trademark Application - KINSO Filed", "Kinso build 1.4.2 is ready to test"). That name and
> any of its marks are a third party's IP. This spec keeps the name only as a build label for your
> personal-use clone; rename it (`app.config.json` → `branding.name`) before sharing or shipping it
> to anyone else.

## 1. What the product is

A small always-on-top **glass panel** that docks to the right edge of the screen, collapsed by
default to a **5-icon vertical rail**. Clicking a rail icon expands a panel (~340×480 logical px)
showing one of five modes. It's a cross-cutting "second brain" companion that sits over whatever
else you're doing — not a full application window, never goes full-screen, never appears in the
Dock/taskbar as a normal window.

The 5 modes, in rail order top→bottom (confirmed by which rail icon shows the active/highlighted
state in each section of the demo):

| # | Rail icon | Mode | Core job |
|---|-----------|------|----------|
| 1 | sparkle/comet | **Ask Kinso (AI chat)** | Natural-language Q&A over the user's own connected data (mail, calendar, notes) |
| 2 | bell | **Priority Notifications** | A triaged, swipeable stream of "important" messages pulled out of the inbox noise |
| 3 | document | **Notes / Meeting Transcription** | Live-updating notes doc per meeting, auto-filled during a call |
| 4 | calendar | **Calendar** | Today's schedule + event detail (join link, invitees, edit/delete) |
| 5 | envelope | **Unified Inbox** | One merged feed across multiple connected mail/chat accounts |

## 2. Global chrome (present in every mode)

**Idle state** (`docs/reference-frames/06_idle_rail-only.png`): only the rail is visible — a dark
pill, ~40px wide, floating near the right edge of the screen with a visible gap from the true edge
(not flush-docked), vertically roughly centered. No panel, no background dimming, fully
click-through everywhere except the rail itself.

**Expanded state**: clicking a rail icon slides/fades in the panel immediately to the left of the
rail. The rail stays visible and docked to the panel's right edge; the *currently active* icon gets
a light rounded-square highlight (~30% white fill) behind the glyph, inactive icons are plain muted
outlines. Clicking the same icon again (or its mode's close [X]) collapses back to idle. Clicking a
different rail icon while a panel is open swaps panel content in place (rail stays put).

**Panel surface**: dark frosted glass (~`rgba(22,24,29,0.75)` + backdrop blur, wallpaper visible
faintly through it), 16–18px corner radius, 1px hairline border at ~8% white, soft drop shadow.
Primary text near-white (`#F3F4F6`), secondary/meta text muted gray (`#9AA0A8`).

**Notification affordance**: rail's bell icon shows a small red dot badge when unread priority
items exist.

## 3. Mode-by-mode spec

### 3.1 Ask Kinso (AI chat)
Ref: `05_ai_empty.png`, `05_ai_query.png`.

- Header: back caret, then right-aligned utility icons — edit/compose, comment/history, clock
  (past conversations) — then rail.
- Empty state: greeting `"Good morning, {FirstName}"` (time-of-day aware — "Good afternoon" /
  "Good evening" per local clock), centered animated sparkle/comet mark, otherwise blank.
- Input bar pinned to bottom: placeholder `"Ask Kinso"`, left icons `+` (attach/add context) and
  `⌘` (command palette / shortcuts hint), right icons mic (voice input) and a filled circular send
  button.
- On submit: user message renders as a plain left-aligned line at top of the thread; empty-state
  graphic disappears; an animated `•••` "thinking" indicator appears below it while a response
  streams in. (Clip cuts before a response renders — response layout is *not observed*, treat as
  an assumption: render as a left-aligned markdown-capable text block, matching thread styling of
  most chat UIs of this style.)
- Sample query captured in source: *"Where is that contract from last week?"* — implies the
  assistant is expected to answer over connected mail/doc context, not be a generic chatbot.

### 3.2 Priority Notifications
Ref: `01_notifications_title.png`, `01_notifications_card-invite.png`,
`01_notifications_card-code.png`, `01_notifications_card-boardpack.png`.

- Header toolbar: `< ✓ … >` cluster left (back / mark-done / overflow-menu / next), then
  `history-clock` and `× close` right.
- A thin progress bar hairline flashes across the very top edge on advance — indicates the stack
  behaves like a **story/card deck**: one notification visible at a time, `>` advances to the next,
  `✓` presumably archives-and-advances (dismiss as handled).
- Card body: sender avatar/brand-mark (colored square, e.g. Gmail red "M"), sender name, subject
  line, 2–3 line preview of the message body.
- Reply composer docked at card bottom: `"Start typing"` placeholder, formatting icons
  (`Aa` text style, `@` mention, paperclip attach), and on the right `emoji`, `mic`, send.
- Cards observed in source (sample content only — do not ship as real data):
  1. Frank Greeff — calendar invite ("Frank Gmail Testing @ Thu 11 Jun 2026…")
  2. Google — sign-in verification code
  3. Henrik Saar — "Q2 board pack — feedback by Friday"
  4. Sarah Chen — "Partnership Follow-up" (conference follow-up)

### 3.3 Notes / Meeting Transcription
Ref: `02_notes_title.png`, `02_notes_typing-1.png`, `02_notes_typing-2.png`.

- Header: back caret, doc-title chip with small file icon (`"My notes"`), then an expand icon and a
  sparkle/wand icon (AI-clean-up-notes action), external-link-out icon, and a **live-recording
  pill** on the far right — green dot + waveform bars, shown only while a meeting is being
  transcribed.
- Body: freeform note titled with the meeting name (e.g. "Frank x Jacques Meeting"); bullet lines
  appear incrementally, character-by-character, simulating live transcription→summary output
  during a call. This is the one mode in the deck shown mid-animation (text growing over 3 frames)
  — confirms notes are written progressively, not pasted in whole.
- Clicking away/back presumably files the note under that meeting's calendar entry (not directly
  observed — reasonable inference from the meeting-named title).

### 3.4 Calendar
Ref: `03_calendar_list.png`, `03_calendar_detail.png`.

- **List view**: header `< Today >` (day navigation), then a vertical stack of event rows, each a
  colored left-edge bar (accent color appears to flag conflicts — two overlapping-time events both
  render with a red bar) + title + `time · duration` meta line.
- Sample day observed: Frank×Tahlia 8:00–8:30, Phase 2 Ideation 8:30 (1h), Customer call—Initech
  8:30 (30m, overlaps previous → red), Board prep 9:00 (15m), Board Meeting 9:00 (1h, also
  overlaps → red), Team Standup 10:00 (30m), *Tentative:* Coffee with Investor 11:00 (30m), Client
  Call - TechCorp.
- **Detail view** (tap a row): replaces the list in-place with an event card — title, full date +
  time range, `Organized by {name}`, a "Join with Zoom" row showing the meeting URL with a
  copy-to-clipboard icon, an Invitees section (avatar chips + accept-status dot per invitee,
  "1 awaiting" summary), edit(pencil)/delete(trash)/close(×) icons top-right of the card.

### 3.5 Unified Inbox
Ref: `04_inbox_list.png`.

- Header row: a horizontal strip of small connected-account icons (envelope="all", then one icon
  per connected mail/chat provider — colors suggest Gmail, iMessage/SMS, WhatsApp, and others),
  each toggle-able as a filter, plus a compose (pencil-square) icon at the row's right end.
- Below: a flat merged list across all accounts, newest first, each row = avatar, sender(s) line
  (can be multiple names for a thread, e.g. "David, Sarah, me"), subject + preview snippet
  truncated to one line, timestamp right-aligned. Unread rows get a small leading accent dot and
  slightly brighter text.
- This is explicitly a **read/triage surface**, not a full mail client — clicking a row most likely
  opens that thread in the Notifications-style card view (not observed directly, inferred from
  shared visual language between the two modes).

## 4. macOS-specific behaviors → Linux equivalents

| macOS behavior in the clip | Ubuntu/GNOME equivalent to build |
|---|---|
| Lives outside Dock, no menu-bar-extra icon shown mid-clip (may have one off-screen) | A GNOME Shell **AppIndicator/tray icon** for quick toggle + right-click menu (quit, settings) |
| Always-on-top floating panel over any app/desktop | Electron `BrowserWindow` with `alwaysOnTop: true`, `frame:false`, `transparent:true`, `skipTaskbar:true` |
| Global summon (not shown, but implied by "lives on your desktop") | `globalShortcut.register()` for a configurable hotkey, e.g. `Super+K` |
| Docked near right edge, not flush | Position window at `screenWidth - panelWidth - margin`, recompute on display/resolution change |
| Frosted-glass translucency | CSS `backdrop-filter: blur()` over a semi-transparent background (works in Electron/Chromium; GTK-native would need a compositor-level blur which Ubuntu's default Mutter doesn't provide out of the box — flagged as a known visual gap) |

## 5. Explicit assumptions / gaps (not visible in the clip)

- No settings/onboarding/account-linking screen is shown at all — connecting real Gmail/Calendar/
  chat accounts is entirely unspecified. Treated as a stretch goal, not part of the "as-is" clone.
- The AI response layout, multi-turn thread scrolling, and error states are unobserved.
- No dark/light theme toggle is shown (clip only shows dark).
- No resize/reposition/drag affordance is shown on the panel itself.
- Notification "✓" semantics (archive vs. snooze vs. mark-read) is inferred from icon convention,
  not confirmed by the clip.

## 6. Deliverables produced from this spec

1. `docs/mockups/index.html` — static, click-through mockup of all 7 states (idle, AI empty/with
   query, notifications, notes, calendar list/detail, inbox), also published as an Artifact.
2. `app/` — an Electron implementation of the same 5 modes with working local interactivity (see
   `app/README.md` for what's wired to real logic vs. sample data).
