# Widget positioning — on stand-by

**Status (2026-08-20): paused.** Cross-monitor repositioning via the global hotkey is not
confirmed working end-to-end. Do not re-litigate the parts already confirmed below — pick up
from "Open question" at the bottom.

## What it's supposed to do

- Widget always docks to the **right edge** of whichever monitor the cursor is on.
- Repositioning is re-evaluated whenever a panel opens/closes/switches (via rail click), and via
  a dedicated global hotkey (`Control+Shift+K`, `main.js` → `relocateToCursor()`) that *only*
  repositions — it doesn't open any panel, doesn't touch `mode`, no renderer round-trip.
- Static per-side setting (`dockSide: "left"/"right"` in settings.json) was removed entirely —
  this is dynamic-only now, keyed off cursor position and `screen.getDisplayNearestPoint()`.

## What's confirmed working in isolation

- `screen.getAllDisplays()` correctly reports **2 separate displays** — not merged into one
  (checked directly, ruled out as a cause).
- `screen.getCursorScreenPoint()` + `getDisplayNearestPoint()` correctly resolves to whichever
  monitor the cursor is actually on — verified multiple times against real cursor coordinates
  matching real xrandr geometry.
- `boundsFor()`'s math is correct — verified via `win.getBounds()` after `setBounds()` matching
  the requested `{x,y,width,height}` exactly (no drift, atomic on this X11 session).
- The **global hotkey fires reliably at the OS/Electron level**, isolated from the rest of the
  app — a standalone script that only does `globalShortcut.register('Control+Shift+K', ...)`
  logged a clean hotkey-fired event on every press, no misses, no GNOME keybinding conflict found
  (`gsettings list-recursively` shows nothing bound to Ctrl+Shift+K).
- Click-triggered repositioning (rail icon clicks) was verified working correctly via CDP-scripted
  clicks earlier in this session, before the hotkey was decoupled from opening AI.

## Open question

Despite every individual piece above checking out, the user reports **no visible movement** when
actually pressing `Control+Shift+K` after moving the cursor to the other monitor, in live use of
the real running app (not the isolated test script). This gap — isolated pieces work, live
end-to-end doesn't — is unexplained. Not yet tried:

- Add targeted logging *inside the real running app's* `relocateToCursor()` (not an isolated
  script) and confirm it's actually invoked, with what cursor/bounds values, at the exact moment
  of a live keypress.
- Rule out that the cursor genuinely reached the other monitor before the keypress (a screenshot
  or cursor-position check right before pressing, not after).
- Check whether `win.moveTop()` (called on `'show'`/`'blur'`) or some other always-on-top
  reassertion could be interacting with `setBounds()` in a way that reverts position.
- Consider whether GNOME's window-manager placement policy (separately from the hotkey mechanism)
  is silently overriding `setBounds()` for this specific window under some condition not yet
  identified — everything confirmed above was either an isolated non-Kinso test window, or a
  scripted CDP-driven interaction, neither of which is a perfect proxy for a real global-hotkey
  keypress reaching the real app.

## Relevant code

- `app/src/main.js`: `activeDisplay()`, `boundsFor()`, `applyBounds()`, `relocateToCursor()`,
  `registerHotkey()`.
- `app/README.md`: "Position" section and the hotkey bullet under "Run it" describe the intended
  (not fully verified) behavior.
