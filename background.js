// Claude Rate Limits - MV3 service worker.
//
// Fetches subscription usage from claude.ai's internal usage endpoint (using
// the logged-in session cookie) and renders it into the toolbar action:
//   - icon:    three bars (5h / 7d / Fable), colored by utilization
//   - badge:   the 5-hour utilization percentage
//   - tooltip: all buckets with reset times and last-refresh time
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

/** Minimum time between automatic (non-click) refreshes. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
/** How often the alarm wakes up to check whether a refresh is due. */
const CHECK_INTERVAL_MINUTES = 5;
/** User counts as "using the computer" if there was input within this window. */
const IDLE_THRESHOLD_SECONDS = 5 * 60;
const ALARM_NAME = "claude-rates-check";

/** Buckets, in display order. The usage JSON carries a `limits[]` array whose
 *  entries have `kind`, `percent`, `resets_at`, and (for model-scoped
 *  limits) `scope.model.display_name`. Top-level `five_hour` / `seven_day`
 *  objects are used as a fallback when `limits[]` is absent. */
const LIMIT_KIND_SESSION = "session";
const LIMIT_KIND_WEEKLY_ALL = "weekly_all";
const LIMIT_KIND_WEEKLY_SCOPED = "weekly_scoped";
const FABLE_MODEL_DISPLAY_NAME = "fable";

const BUCKET_FIVE_HOUR = {
  label: "5h",
  matchesLimit: (limit) => limit.kind === LIMIT_KIND_SESSION,
  legacyKey: "five_hour",
};
const BUCKET_SEVEN_DAY = {
  label: "7d",
  matchesLimit: (limit) => limit.kind === LIMIT_KIND_WEEKLY_ALL,
  legacyKey: "seven_day",
};
const BUCKET_FABLE = {
  label: "Fable",
  matchesLimit: (limit) =>
    limit.kind === LIMIT_KIND_WEEKLY_SCOPED &&
    limitModelName(limit).toLowerCase() === FABLE_MODEL_DISPLAY_NAME,
  legacyKey: null,
};
const BUCKETS = [BUCKET_FIVE_HOUR, BUCKET_SEVEN_DAY, BUCKET_FABLE];
/** Which bucket's utilization goes in the badge text. */
const BADGE_BUCKET = BUCKET_FIVE_HOUR;

/** Utilization thresholds (percent) for color coding. */
const UTIL_WARN_PERCENT = 50;
const UTIL_CRITICAL_PERCENT = 80;

const COLOR_OK = "#2e9e5b";
const COLOR_WARN = "#d9a400";
const COLOR_CRITICAL = "#d0342c";
const COLOR_UNKNOWN = "#9a9a9a";
const COLOR_TRACK = "#3a3a3a";
const COLOR_ERROR_BADGE = "#d0342c";
const COLOR_STALE_BADGE = "#6b6b6b";

const ICON_SIZES = [16, 32];
/** Icon geometry, expressed as fractions of the icon size. */
const ICON_BAR_GAP_FRACTION = 0.1;
const ICON_MIN_FILL_FRACTION = 0.08;

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
// Rendering
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BucketView
 * @property {string} label
 * @property {Object|null} limit       matched entry from usage.limits[], or null
 * @property {number|null} utilization percent, or null if unavailable
 * @property {string|null} resetsAt    ISO timestamp, or null
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

function unavailableBucket(spec) {
  return { label: spec.label, limit: null, utilization: null, resetsAt: null };
}

/** @returns {BucketView} */
function resolveBucket(usage, spec) {
  if (usage === null || typeof usage !== "object") return unavailableBucket(spec);

  const limit = usageLimits(usage).find((l) => l && spec.matchesLimit(l)) ?? null;
  if (limit !== null) {
    return {
      label: spec.label,
      limit,
      utilization: typeof limit.percent === "number" ? limit.percent : null,
      resetsAt: typeof limit.resets_at === "string" ? limit.resets_at : null,
    };
  }

  const legacy = spec.legacyKey !== null ? usage[spec.legacyKey] : null;
  if (legacy === null || legacy === undefined || typeof legacy !== "object") {
    return unavailableBucket(spec);
  }
  return {
    label: spec.label,
    limit: null,
    utilization: typeof legacy.utilization === "number" ? legacy.utilization : null,
    resetsAt: typeof legacy.resets_at === "string" ? legacy.resets_at : null,
  };
}

function colorForUtilization(utilization) {
  if (utilization === null) return COLOR_UNKNOWN;
  if (utilization >= UTIL_CRITICAL_PERCENT) return COLOR_CRITICAL;
  if (utilization >= UTIL_WARN_PERCENT) return COLOR_WARN;
  return COLOR_OK;
}

/** Draws three vertical bars into an ImageData of the given size. */
function drawIcon(size, buckets) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);

  const gap = Math.max(1, Math.round(size * ICON_BAR_GAP_FRACTION));
  const barWidth = Math.floor((size - gap * (buckets.length - 1)) / buckets.length);
  const totalWidth = barWidth * buckets.length + gap * (buckets.length - 1);
  const xStart = Math.floor((size - totalWidth) / 2);

  buckets.forEach((bucket, i) => {
    const x = xStart + i * (barWidth + gap);
    ctx.fillStyle = COLOR_TRACK;
    ctx.fillRect(x, 0, barWidth, size);

    const fraction =
      bucket.utilization === null
        ? ICON_MIN_FILL_FRACTION
        : Math.max(ICON_MIN_FILL_FRACTION, Math.min(1, bucket.utilization / 100));
    const fillHeight = Math.max(1, Math.round(size * fraction));
    ctx.fillStyle = colorForUtilization(bucket.utilization);
    ctx.fillRect(x, size - fillHeight, barWidth, fillHeight);
  });

  return ctx.getImageData(0, 0, size, size);
}

function formatPercent(utilization) {
  return utilization === null ? "\u2014" : `${Math.round(utilization)}%`;
}

function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.round(ms / 60000));
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
  return ` (resets in ${formatDuration(resetMs - now)})`;
}

function buildTitle(state, buckets, now) {
  const lines = ["Claude Rate Limits"];
  for (const b of buckets) {
    lines.push(`${b.label}: ${formatPercent(b.utilization)}${formatReset(b.resetsAt, now)}`);
  }
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
  lines.push("Click to refresh");
  return lines.join("\n");
}

/** @param {PersistedState} state */
async function render(state) {
  const now = Date.now();
  const buckets = BUCKETS.map((spec) => resolveBucket(state.usage, spec));

  const imageData = {};
  for (const size of ICON_SIZES) imageData[size] = drawIcon(size, buckets);
  await chrome.action.setIcon({ imageData });

  const badgeBucket = buckets[BUCKETS.indexOf(BADGE_BUCKET)];
  if (state.lastError !== null && state.usage === null) {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: COLOR_ERROR_BADGE });
  } else {
    await chrome.action.setBadgeText({ text: formatPercent(badgeBucket.utilization) });
    await chrome.action.setBadgeBackgroundColor({
      color: state.lastError !== null ? COLOR_STALE_BADGE : colorForUtilization(badgeBucket.utilization),
    });
  }
  await chrome.action.setBadgeTextColor({ color: "#ffffff" });
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
