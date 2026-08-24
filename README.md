# claude-rates-chrome-ext-no-click

Chrome extension that shows your Claude subscription rate limits in the
toolbar **without clicking**: the icon is three bars (5-hour, 7-day, Fable)
on a background tinted with Fable's pace color, and hovering shows all buckets
with pace and reset times.

- **Click** the icon to refresh immediately.
- Otherwise it refreshes **at most once per hour**, and only when you are
  active at the computer (`chrome.idle`) **and** a Chrome window is focused.

It reads `https://claude.ai/api/organizations/{orgId}/usage` (the `limits[]`
array: `session`, `weekly_all`, and the `weekly_scoped` entry for Fable) using
your existing claude.ai login cookie - an unofficial internal endpoint that may
change. If the bars stay grey, hover for the error (usually "not logged in").

## Colors mean pace, not level

The goal is to end each week having used the whole weekly quota, so bar
colors compare what you have used with what you *would* have used at a
steady rate across the window (window start = `resets_at` minus 7 days or
5 hours):

| Color | Meaning | Rule (actual - expected, in points) |
| ----- | ------- | ----------------------------------- |
| Blue  | Under pace: quota will go unused at reset | <= -15 (weekly buckets only) |
| Green | On pace | between |
| Amber | Over pace: you will run out early | >= +15 |
| Red   | Well over pace, or exhausted | >= +30, or >= 100% used |
| Grey  | No data | - |

The 5-hour bucket is never flagged for under-use; only for going too fast.
If a bucket has no usable `resets_at`, plain level thresholds (50% / 80%) are
used instead. Thresholds are constants at the top of `background.js`.

The Fable bar is the emphasized one: it gets any leftover horizontal pixels
(so it is slightly wider at sizes where the width does not divide evenly), and
the icon background is a translucent version of its pace color. No badge is
used because Chrome paints it over the bottom of the icon, hiding the bars.

## Load it

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. **Load unpacked** and pick `~/chrome-extensions/claude-rates`
   (a symlink to this repo) or this repo directory directly.
3. Pin the extension via the puzzle-piece menu so it stays in the toolbar.

Reload the extension from `chrome://extensions` after editing files.

## Other machines

Chrome Sync does not sync unpacked extensions, and Chrome refuses to install a
self-hosted `.crx` outside the Web Store on macOS/Windows unless it is
force-installed by enterprise policy. Realistic options:

1. **Clone + Load unpacked** on each machine (the steps above). Updates are
   `git pull` then reload from `chrome://extensions`. No account, no review.
2. **Chrome Web Store, unlisted.** One-time $5 developer registration, a
   review pass, then anyone with the link can install it and it auto-updates.
   Not searchable. This is the only path that gives auto-updates without
   enterprise policy.

## Layout

- `manifest.json` - MV3 manifest (permissions: `alarms`, `storage`, `idle`;
  host access to `claude.ai`).
- `background.js` - service worker: fetch, refresh policy, pace computation,
  icon/tooltip rendering. Tunables (refresh interval, idle threshold,
  pace thresholds, which bucket is emphasized) are constants at the top.
