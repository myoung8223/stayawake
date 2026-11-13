// Stay Awake — background service worker (Manifest V3)
//
// Holds a ChromeOS "display" wake lock via chrome.power while a manually
// started countdown is running. The lock belongs to the extension, not a tab,
// so it works no matter what window or fullscreen content is in front.
//
// Rules:
//   * Nothing happens until a person starts it from the popup.
//   * A run is either a duration in whole minutes (1..MAX_MINUTES) or an end
//     clock time no more than MAX_MINUTES away.
//   * The last RECENT_COUNT unique durations and end times are remembered as
//     quick buttons.
//   * When time runs out the lock is released and normal ChromeOS idle/lock
//     policy takes over again.
//   * The countdown is cleared on browser/session startup, so a reboot or new
//     sign-in never resumes a leftover countdown.

const MAX_MINUTES     = 90;  // longest allowed duration — edit here to change
const DEFAULT_MINUTES = 30;  // pre-filled in the popup before anything is chosen
const WARN_MINUTES    = 2;   // warning notification this long before expiry
const RECENT_COUNT    = 9;   // how many recent durations / end times to remember

const WARN_MS = WARN_MINUTES * 60000;

const ICON_ON  = { 16: 'icons/on16.png',  32: 'icons/on32.png'  };
const ICON_OFF = { 16: 'icons/off16.png', 32: 'icons/off32.png' };

// Most-recent-first list of unique values, capped at RECENT_COUNT.
function pushRecent(list, v) {
  return [v, ...list.filter((x) => x !== v)].slice(0, RECENT_COUNT);
}

function clampMinutes(m) {
  const n = Math.round(Number(m));
  if (!Number.isFinite(n) || n < 1) return 0;
  return Math.min(n, MAX_MINUTES);
}

async function getState() {
  const s = await chrome.storage.local.get(['endTime', 'duration', 'totalMs', 'recents', 'recentTimes']);
  const running = s.endTime && s.endTime > Date.now();
  return {
    endTime:  running ? s.endTime : 0,
    duration: running ? (s.duration || 0) : 0,
    totalMs:  running ? (s.totalMs || (s.duration || 0) * 60000) : 0,
    recents:  Array.isArray(s.recents) ? s.recents.slice(0, RECENT_COUNT) : [],
    recentTimes: Array.isArray(s.recentTimes) ? s.recentTimes.slice(0, RECENT_COUNT) : [],
    max:      MAX_MINUTES,
    def:      DEFAULT_MINUTES
  };
}

async function refreshBadge(endTime) {
  const mins = Math.max(1, Math.ceil((endTime - Date.now()) / 60000));
  await chrome.action.setBadgeText({ text: String(mins) });
  await chrome.action.setBadgeBackgroundColor({
    color: mins <= WARN_MINUTES ? '#d97706' : '#15803d'
  });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: '#ffffff' });
  }
  await chrome.action.setTitle({ title: `Stay Awake — ${mins} min left` });
}

// Set the countdown to end at endTime (0 = turn off).
async function apply(endTime) {
  await chrome.alarms.clearAll();
  chrome.notifications.clear('warn');

  if (!endTime || endTime <= Date.now()) {
    await chrome.storage.local.remove(['endTime', 'duration', 'totalMs']);
    chrome.power.releaseKeepAwake();
    await chrome.action.setIcon({ path: ICON_OFF });
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'Stay Awake (off)' });
    return;
  }

  await chrome.storage.local.set({ endTime });
  chrome.power.requestKeepAwake('display');
  chrome.alarms.create('expire', { when: endTime });
  chrome.alarms.create('tick', { periodInMinutes: 0.5 });
  if (endTime - Date.now() > WARN_MS + 5000) {
    chrome.alarms.create('warn', { when: endTime - WARN_MS });
  }
  await chrome.action.setIcon({ path: ICON_ON });
  await refreshBadge(endTime);
}

// Start (or restart) with a duration in minutes. Replaces any running countdown.
// remember=false skips updating the recent-durations list.
async function start(minutes, remember = true) {
  const m = clampMinutes(minutes);
  if (!m) return;
  if (remember) {
    const { recents } = await getState();
    await chrome.storage.local.set({ recents: pushRecent(recents, m) });
  }
  await chrome.storage.local.set({ duration: m, totalMs: m * 60000 });
  await apply(Date.now() + m * 60000);
}

// Start (or restart) so the countdown ends at a specific clock time.
// arg = { end: ms epoch, hhmm: "HH:MM" as picked }. The end must be at least
// 1 minute and at most MAX_MINUTES away. hhmm is remembered as a recent time.
async function startUntil(arg) {
  const end = Number(arg && arg.end);
  const ms = end - Date.now();
  if (!Number.isFinite(ms) || ms < 60000 || ms > MAX_MINUTES * 60000 + 1000) return;
  const hhmm = arg && arg.hhmm;
  if (typeof hhmm === 'string' && /^\d{2}:\d{2}$/.test(hhmm)) {
    const { recentTimes } = await getState();
    await chrome.storage.local.set({ recentTimes: pushRecent(recentTimes, hhmm) });
  }
  await chrome.storage.local.set({ duration: Math.ceil(ms / 60000), totalMs: ms });
  await apply(end);
}

async function handle(msg) {
  switch (msg && msg.cmd) {
    case 'start': await start(msg.arg); break;
    case 'until': await startUntil(msg.arg); break;
    case 'stop':  await apply(0);       break;
    case 'get':
    default:      break;
  }
  return getState();
}

// ---- Events ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // async response
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const { endTime, duration } = await getState();
  if (!endTime) { await apply(0); return; }

  if (alarm.name === 'expire') {
    if (Date.now() >= endTime - 1000) await apply(0);
  } else if (alarm.name === 'tick') {
    chrome.power.requestKeepAwake('display'); // harmless re-assert
    await refreshBadge(endTime);
  } else if (alarm.name === 'warn') {
    await refreshBadge(endTime);
    chrome.notifications.create('warn', {
      type: 'basic',
      iconUrl: 'icons/on128.png',
      title: `Stay Awake ends in ${WARN_MINUTES} minutes`,
      message: 'Normal screen-lock rules resume when the timer ends.',
      buttons: [{ title: `Restart ${duration} min` }],
      priority: 1
    });
  }
});

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  if (id !== 'warn' || index !== 0) return;
  chrome.notifications.clear('warn');
  const { duration, recents } = await getState();
  start(duration || recents[0] || DEFAULT_MINUTES, false);
});

// New session / reboot: never resume a leftover countdown.
chrome.runtime.onStartup.addListener(() => apply(0));

// Install / update: keep a running countdown, otherwise make sure all is off.
chrome.runtime.onInstalled.addListener(async () => {
  const { endTime } = await getState();
  apply(endTime);
});
