// Rate Limits for Claude - MV3 service worker.
//
// Fetches subscription usage from claude.ai's internal usage endpoint (using
// the logged-in session cookie) and renders it into the toolbar action:
//   - icon:    three bars (5h / 7d / Fable), colored by pace, on a
//              translucent background in Fable's pace color
//   - tooltip: all buckets with pace, reset times and last-refresh time
//
// "Pace" compares actual utilization with the utilization you would have if
// the quota were consumed evenly across its window. The goal for the weekly
// buckets is to finish the week near 100%: blue means you are under-using
// quota that will be wasted at reset, amber/red means you will run out early.
//
// Refresh policy:
//   - clicking the icon refreshes immediately
//   - otherwise at most once per REFRESH_INTERVAL_MS, and only when the user
//     is active (chrome.idle) AND a Chrome window is focused

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLAUDE_ORIGIN = "https://claude.ai";
const ORGANIZATIONS_URL = `${CLAUDE_ORIGIN}/api/organizations`;
const usageUrl = (orgId) => `${CLAUDE_ORIGIN}/api/organizations/${orgId}/usage`;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Minimum time between automatic (non-click) refreshes. */
const REFRESH_INTERVAL_MS = 60 * MINUTE_MS;
/** How often the alarm wakes up to check whether a refresh is due. */
const CHECK_INTERVAL_MINUTES = 5;
/** User counts as "using the computer" if there was input within this window. */
const IDLE_THRESHOLD_SECONDS = 5 * 60;
const ALARM_NAME = "claude-rates-check";

/** Buckets, in display order. The usage JSON carries a `limits[]` array whose
 *  entries have `kind`, `percent`, `resets_at`, and (for model-scoped
 *  limits) `scope.model.display_name`. Top-level `five_hour` / `seven_day`
 *  objects are used as a fallback when `limits[]` is absent.
 *
 *  `windowMs` is the bucket's window length; the window is assumed to start
 *  at `resets_at - windowMs`. `flagUnderuse` says whether being behind pace
 *  is worth flagging (yes for weekly quotas we want to use up, no for the
 *  5-hour session window). */
const LIMIT_KIND_SESSION = "session";
const LIMIT_KIND_WEEKLY_ALL = "weekly_all";
const LIMIT_KIND_WEEKLY_SCOPED = "weekly_scoped";
const FABLE_MODEL_DISPLAY_NAME = "fable";

const BUCKET_FIVE_HOUR = {
  label: "5h",
  matchesLimit: (limit) => limit.kind === LIMIT_KIND_SESSION,
  legacyKey: "five_hour",
  windowMs: 5 * HOUR_MS,
  flagUnderuse: false,
};
const BUCKET_SEVEN_DAY = {
  label: "7d",
  matchesLimit: (limit) => limit.kind === LIMIT_KIND_WEEKLY_ALL,
  legacyKey: "seven_day",
  windowMs: 7 * DAY_MS,
  flagUnderuse: true,
};
const BUCKET_FABLE = {
  label: "Fable",
  matchesLimit: (limit) =>
    limit.kind === LIMIT_KIND_WEEKLY_SCOPED &&
    limitModelName(limit).toLowerCase() === FABLE_MODEL_DISPLAY_NAME,
  legacyKey: null,
  windowMs: 7 * DAY_MS,
  flagUnderuse: true,
};
const BUCKETS = [BUCKET_FIVE_HOUR, BUCKET_SEVEN_DAY, BUCKET_FABLE];
/** The bucket that gets visual emphasis in the icon: it absorbs any leftover
 *  horizontal pixels (so its bar is slightly wider when the size allows) and
 *  its pace color tints the icon background. */
const EMPHASIZED_BUCKET = BUCKET_FABLE;

/** Pace status of a bucket. */
const PACE_UNKNOWN = "unknown";
const PACE_UNDER = "under";
const PACE_ON = "on";
const PACE_OVER = "over";
const PACE_CRITICAL = "critical";

/** Pace thresholds: (actual - expected) utilization, in percentage points.
 *  Measured in points rather than as a ratio so that early in a window,
 *  when the expected value is tiny, small absolute usage does not read as
 *  wildly over pace. */
const PACE_UNDER_POINTS = -15;
const PACE_OVER_POINTS = 15;
const PACE_CRITICAL_POINTS = 30;
/** Utilization at or above which a bucket is simply exhausted. */
const UTIL_EXHAUSTED_PERCENT = 100;

/** Plain utilization thresholds, used only when pace cannot be computed
 *  (no usable resets_at). */
const UTIL_WARN_PERCENT = 50;
const UTIL_CRITICAL_PERCENT = 80;

const COLOR_ON_PACE = "#2e9e5b";
const COLOR_UNDER_PACE = "#3b82f6";
const COLOR_OVER_PACE = "#d9a400";
const COLOR_CRITICAL = "#d0342c";
const COLOR_UNKNOWN = "#9a9a9a";
/** Empty part of a bar. Translucent so it reads on light and dark toolbars. */
const COLOR_TRACK = "rgba(128, 128, 128, 0.35)";

const ICON_SIZES = [16, 32];
/** The icon size, in pixels, at which 1 px = 1 DIP. Pixel measurements
 *  below are given in DIP and scaled by size / ICON_BASE_SIZE. */
const ICON_BASE_SIZE = 16;
/** Left empty at the bottom so the icon sits level with other toolbar icons. */
const ICON_BOTTOM_INSET_DIP = 1;
const ICON_CORNER_RADIUS_DIP = 1;
/** Icon geometry, expressed as fractions of the icon size. */
const ICON_BAR_GAP_FRACTION = 0.1;
const ICON_MIN_FILL_FRACTION = 0.08;
/** Opacity of the icon background, which is tinted with the emphasized
 *  bucket's pace color. */
const ICON_BACKGROUND_ALPHA = 0.25;

const STORAGE_KEY = "state";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PersistedState
 * @property {string|null} orgId
 * @property {number|null} lastFetchAt   epoch ms of last successful fetch
 * @property {Object|null} usage         raw usage JSON
 * @property {string|null} lastError
 */

/** @returns {Promise<PersistedState>} */
async function loadState() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] ?? {};
  return {
    orgId: stored.orgId ?? null,
    lastFetchAt: stored.lastFetchAt ?? null,
    usage: stored.usage ?? null,
    lastError: stored.lastError ?? null,
  };
}

/** @param {PersistedState} state */
async function saveState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} from ${url}`);
    this.status = status;
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return response.json();
}

/** Picks the org to query: prefers one with the "chat" capability. */
async function discoverOrgId() {
  const orgs = await fetchJson(ORGANIZATIONS_URL);
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new Error("No organizations returned from claude.ai");
  }
  const chatOrg = orgs.find(
    (org) => Array.isArray(org.capabilities) && org.capabilities.includes("chat")
  );
  const chosen = chatOrg ?? orgs[0];
  if (typeof chosen.uuid !== "string") {
    throw new Error("Organization has no uuid field");
  }
  return chosen.uuid;
}

/** Fetches usage, refreshing state. Errors are recorded in state, not thrown. */
async function refresh() {
  const state = await loadState();
  try {
    if (state.orgId === null) state.orgId = await discoverOrgId();
    let usage;
    try {
      usage = await fetchJson(usageUrl(state.orgId));
    } catch (err) {
      // A stale/wrong org id yields 403/404; rediscover once and retry.
      if (err instanceof HttpError && (err.status === 403 || err.status === 404)) {
        state.orgId = await discoverOrgId();
        usage = await fetchJson(usageUrl(state.orgId));
      } else {
        throw err;
      }
    }
    state.usage = usage;
    state.lastFetchAt = Date.now();
    state.lastError = null;
  } catch (err) {
    state.lastError = describeError(err);
  }
  await saveState(state);
  await render(state);
}

function describeError(err) {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return `Not logged in (HTTP ${err.status}). Open claude.ai and sign in, then click to retry.`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Refresh policy
// ---------------------------------------------------------------------------

/** True if the user is active on the computer AND Chrome is the focused app. */
async function userIsActiveInChrome() {
  const idleState = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
  if (idleState !== "active") return false;
  try {
    const window = await chrome.windows.getLastFocused();
    return window.focused === true;
  } catch {
    return false;
  }
}

/** Refreshes only if the data is stale and the user is actively using Chrome. */
async function maybeRefresh() {
  const state = await loadState();
  const stale =
    state.lastFetchAt === null || Date.now() - state.lastFetchAt >= REFRESH_INTERVAL_MS;
  if (!stale) return;
  if (!(await userIsActiveInChrome())) return;
  await refresh();
}

// ---------------------------------------------------------------------------
// Bucket resolution and pace
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BucketView
 * @property {string} label
 * @property {Object|null} limit          matched entry from usage.limits[], or null
 * @property {number|null} utilization    percent, or null if unavailable
 * @property {string|null} resetsAt       ISO timestamp, or null
 * @property {number|null} expected       percent expected at even pace, or null
 * @property {string} pace                one of the PACE_* values
 * @property {boolean} flagUnderuse       copied from the bucket spec
 */

/** Display name of the model a scoped limit applies to, or "" if unscoped. */
function limitModelName(limit) {
  const name = limit?.scope?.model?.display_name;
  return typeof name === "string" ? name : "";
}

/** The usage.limits[] array, or [] if absent/malformed. */
function usageLimits(usage) {
  return usage !== null && typeof usage === "object" && Array.isArray(usage.limits)
    ? usage.limits
    : [];
}

/** Raw (utilization, resetsAt, limit) for a bucket, before pace is computed. */
function resolveRawBucket(usage, spec) {
  const unavailable = { limit: null, utilization: null, resetsAt: null };
  if (usage === null || typeof usage !== "object") return unavailable;

  const limit = usageLimits(usage).find((l) => l && spec.matchesLimit(l)) ?? null;
  if (limit !== null) {
    return {
      limit,
      utilization: typeof limit.percent === "number" ? limit.percent : null,
      resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null,
    };
  }

  const legacy = spec.legacyKey !== null ? usage[spec.legacyKey] : null;
  if (legacy === null || legacy === undefined || typeof legacy !== "object") {
    return unavailable;
  }
  return {
    limit: null,
    utilization: typeof legacy.utilization === "number" ? legacy.utilization : null,
    resetsAt: typeof legacy.resets_at === "string" ? legacy.resets_at : null,
  };
}

/** Utilization (percent) expected at `now` if the window were consumed evenly,
 *  assuming the window started at resets_at - windowMs. Null if resets_at is
 *  missing, unparseable, already past, or further out than the window. */
function expectedUtilization(spec, resetsAt, now) {
  if (resetsAt === null) return null;
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs) || resetMs <= now) return null;
  const elapsedMs = now - (resetMs - spec.windowMs);
  if (elapsedMs < 0) return null;
  return (elapsedMs / spec.windowMs) * 100;
}

function paceStatus(spec, utilization, expected) {
  if (utilization === null || expected === null) return PACE_UNKNOWN;
  if (utilization >= UTIL_EXHAUSTED_PERCENT) return PACE_CRITICAL;
  const deviation = utilization - expected;
  if (deviation >= PACE_CRITICAL_POINTS) return PACE_CRITICAL;
  if (deviation >= PACE_OVER_POINTS) return PACE_OVER;
  if (spec.flagUnderuse && deviation <= PACE_UNDER_POINTS) return PACE_UNDER;
  return PACE_ON;
}

/** @returns {BucketView} */
function resolveBucket(usage, spec, now) {
  const raw = resolveRawBucket(usage, spec);
  const expected = expectedUtilization(spec, raw.resetsAt, now);
  return {
    label: spec.label,
    limit: raw.limit,
    utilization: raw.utilization,
    resetsAt: raw.resetsAt,
    expected,
    pace: paceStatus(spec, raw.utilization, expected),
    flagUnderuse: spec.flagUnderuse,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Fallback coloring when pace is unknown. */
function colorForUtilization(utilization) {
  if (utilization === null) return COLOR_UNKNOWN;
  if (utilization >= UTIL_CRITICAL_PERCENT) return COLOR_CRITICAL;
  if (utilization >= UTIL_WARN_PERCENT) return COLOR_OVER_PACE;
  return COLOR_ON_PACE;
}

/** @param {BucketView} bucket */
function colorForBucket(bucket) {
  switch (bucket.pace) {
    case PACE_UNDER:
      return COLOR_UNDER_PACE;
    case PACE_ON:
      return COLOR_ON_PACE;
    case PACE_OVER:
      return COLOR_OVER_PACE;
    case PACE_CRITICAL:
      return COLOR_CRITICAL;
    default:
      return colorForUtilization(bucket.utilization);
  }
}

/** "#rrggbb" -> "rgba(r, g, b, alpha)". */
function withAlpha(hexColor, alpha) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
  if (match === null) throw new Error(`Expected #rrggbb color, got ${hexColor}`);
  const [r, g, b] = match.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Draws one vertical bar per bucket into an ImageData of the given size,
 *  over a background tinted with the emphasized bucket's pace color. Bars
 *  share the width evenly; any leftover pixels widen the emphasized bar. */
function drawIcon(size, buckets, emphasizedIndex) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  const dip = size / ICON_BASE_SIZE;
  const barHeight = size - Math.round(ICON_BOTTOM_INSET_DIP * dip);
  const cornerRadius = ICON_CORNER_RADIUS_DIP * dip;

  // Everything (background and bars) is clipped to a rounded rectangle.
  ctx.beginPath();
  ctx.roundRect(0, 0, size, barHeight, cornerRadius);
  ctx.clip();

  ctx.fillStyle = withAlpha(colorForBucket(buckets[emphasizedIndex]), ICON_BACKGROUND_ALPHA);
  ctx.fillRect(0, 0, size, barHeight);

  const gap = Math.max(1, Math.round(size * ICON_BAR_GAP_FRACTION));
  const baseWidth = Math.floor((size - gap * (buckets.length - 1)) / buckets.length);
  const leftover = size - (baseWidth * buckets.length + gap * (buckets.length - 1));
  const barWidths = buckets.map((_, i) => baseWidth + (i === emphasizedIndex ? leftover : 0));

  let x = 0;
  buckets.forEach((bucket, i) => {
    const barWidth = barWidths[i];
    ctx.fillStyle = COLOR_TRACK;
    ctx.fillRect(x, 0, barWidth, barHeight);

    const fraction =
      bucket.utilization === null
        ? ICON_MIN_FILL_FRACTION
        : Math.max(ICON_MIN_FILL_FRACTION, Math.min(1, bucket.utilization / 100));
    const fillHeight = Math.max(1, Math.round(barHeight * fraction));
    ctx.fillStyle = colorForBucket(bucket);
    ctx.fillRect(x, barHeight - fillHeight, barWidth, fillHeight);

    x += barWidth + gap;
  });

  return ctx.getImageData(0, 0, size, size);
}

function formatPercent(utilization) {
  return utilization === null ? "\u2014" : `${Math.round(utilization)}%`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / MINUTE_MS));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatReset(resetsAt, now) {
  if (resetsAt === null) return "";
  const resetMs = Date.parse(resetsAt);
  if (Number.isNaN(resetMs)) return "";
  return `resets in ${formatDuration(resetMs - now)}`;
}

/** @param {BucketView} bucket */
function formatPace(bucket) {
  if (bucket.pace === PACE_UNKNOWN) return "";
  const deviation = Math.round(bucket.utilization - bucket.expected);
  const expected = `${Math.round(bucket.expected)}% expected`;
  if (bucket.utilization >= UTIL_EXHAUSTED_PERCENT) return `exhausted, ${expected}`;
  if (deviation === 0) return `on pace, ${expected}`;
  // Being under pace is not a problem for buckets we do not try to use up.
  if (deviation < 0 && !bucket.flagUnderuse) return "";
  const direction = deviation > 0 ? "over" : "under";
  return `${Math.abs(deviation)} pts ${direction} pace, ${expected}`;
}

/** @param {BucketView} bucket */
function formatBucketLine(bucket, now) {
  const details = [formatPace(bucket), formatReset(bucket.resetsAt, now)].filter(
    (s) => s !== ""
  );
  const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
  return `${bucket.label}: ${formatPercent(bucket.utilization)}${suffix}`;
}

function buildTitle(state, buckets, now) {
  const lines = ["Rate Limits for Claude"];
  for (const b of buckets) lines.push(formatBucketLine(b, now));
  // Any limits[] entries not covered by the buckets above (e.g. other scoped models).
  const shownLimits = new Set(buckets.map((b) => b.limit).filter((l) => l !== null));
  const otherLimits = usageLimits(state.usage)
    .filter((l) => l && !shownLimits.has(l) && typeof l.percent === "number")
    .map((l) => `${limitModelName(l) || l.kind}: ${formatPercent(l.percent)}`);
  if (otherLimits.length > 0) lines.push(`Other: ${otherLimits.join(", ")}`);
  if (state.lastFetchAt !== null) {
    lines.push(`Updated ${formatDuration(now - state.lastFetchAt)} ago`);
  }
  if (state.lastError !== null) lines.push(`Error: ${state.lastError}`);
  lines.push("Blue = under pace, green = on pace, amber/red = over pace");
  lines.push("Click to refresh");
  return lines.join("\n");
}

/** @param {PersistedState} state */
async function render(state) {
  const now = Date.now();
  const buckets = BUCKETS.map((spec) => resolveBucket(state.usage, spec, now));

  const emphasizedIndex = BUCKETS.indexOf(EMPHASIZED_BUCKET);

  const imageData = {};
  for (const size of ICON_SIZES) {
    imageData[size] = drawIcon(size, buckets, emphasizedIndex);
  }
  await chrome.action.setIcon({ imageData });
  await chrome.action.setTitle({ title: buildTitle(state, buckets, now) });
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

async function initialize() {
  chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  await render(await loadState());
  await maybeRefresh();
}

chrome.runtime.onInstalled.addListener(() => {
  initialize();
});
chrome.runtime.onStartup.addListener(() => {
  initialize();
});

chrome.action.onClicked.addListener(() => {
  refresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) maybeRefresh();
});

chrome.idle.onStateChanged.addListener((newState) => {
  if (newState === "active") maybeRefresh();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) maybeRefresh();
});

// The worker may be restarted by Chrome at any time; re-render cached state so
// the icon/tooltip reflect the latest data even before the next refresh.
loadState().then(render);
