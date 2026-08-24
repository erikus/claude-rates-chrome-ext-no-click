# claude-rates-chrome-ext-no-click

Chrome extension that shows your Claude subscription rate limits in the
toolbar **without clicking**: the icon is three bars (5-hour, 7-day, Fable),
the badge is the 5-hour utilization %, and hovering shows all buckets with
reset times.

- **Click** the icon to refresh immediately.
- Otherwise it refreshes **at most once per hour**, and only when you are
  active at the computer (`chrome.idle`) **and** a Chrome window is focused.

It reads `https://claude.ai/api/organizations/{orgId}/usage` (the `limits[]` array: `session`, `weekly_all`, and the `weekly_scoped` entry for Fable) using your
existing claude.ai login cookie - an unofficial internal endpoint that may
change. If the badge shows `!`, hover for the error (usually "not logged in").

## Load it

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** -M-^FM-^R pick `~/chrome-extensions/claude-rates`
   (a symlink to this repo) or this repo directory directly.
3. Pin the extension via the puzzle-piece menu so it stays in the toolbar.

Reload the extension from `chrome://extensions` after editing files.

## Layout

- `manifest.json` - MV3 manifest (permissions: `alarms`, `storage`, `idle`;
  host access to `claude.ai`).
- `background.js` - service worker: fetch, refresh policy, icon/badge/tooltip
  rendering. Tunables (refresh interval, idle threshold, color thresholds,
  which bucket goes in the badge) are constants at the top.
