let st = { endTime: 0, duration: 0, totalMs: 0, recents: [], recentTimes: [], max: 90, def: 30 };
let mode = 'for';          // 'for' = minutes, 'until' = end time
let firstLoad = true;
let errorUntil = 0;        // while Date.now() < errorUntil, the note shows an error

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');

function send(cmd, arg) {
  return chrome.runtime.sendMessage({ cmd, arg }).then((r) => {
    if (r) st = r;
    renderStatic();
    tick();
  });
}

function showError(text) {
  const n = $('note');
  n.textContent = text;
  n.classList.add('error');
  errorUntil = Date.now() + 3500;
}

function fmt(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = pad(s % 60);
  return h ? `${h}:${pad(m)}:${sec}` : `${m}:${sec}`;
}

function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtMinutes(min) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

// ---- End-time helpers -----------------------------------------------------

// The next occurrence of an "HH:MM" (today, or tomorrow if already past).
// Defaults to the value in the time box.
function untilTarget(v = $('until').value) {
  if (!v) return 0;
  const [h, m] = v.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// Default end time: 30 minutes from now, rounded up to the next 5 minutes.
function defaultUntil() {
  const t = new Date(Date.now() + 30 * 60000);
  t.setSeconds(0, 0);
  t.setMinutes(Math.ceil(t.getMinutes() / 5) * 5);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// Returns { ok, target, text } for an "HH:MM" (default: the time box).
function untilCheck(v = $('until').value) {
  const target = untilTarget(v);
  if (!target) return { ok: false, text: 'Pick an end time' };
  const ms = target - Date.now();
  const mins = Math.ceil(ms / 60000);
  if (ms < 60000) return { ok: false, text: 'Pick a time at least 1 minute from now' };
  if (ms > st.max * 60000 + 1000) {
    return { ok: false, text: `That's ${fmtMinutes(mins)} away — max is ${st.max} min` };
  }
  return { ok: true, target, text: `Runs ${fmtMinutes(mins)}, until ${fmtClock(target)}` };
}

// "HH:MM" -> "1:30 PM" in the user's locale.
function hhmmLabel(v) {
  const [h, m] = v.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return fmtClock(d.getTime());
}

function startUntil(v) {
  const c = untilCheck(v);
  if (!c.ok) { showError(c.text); return; }
  $('until').value = v;
  send('until', { end: c.target, hhmm: v });
}

// ---- Mode -----------------------------------------------------------------

function setMode(m, save = true) {
  mode = m === 'until' ? 'until' : 'for';
  $('modeFor').setAttribute('aria-checked', String(mode === 'for'));
  $('modeUntil').setAttribute('aria-checked', String(mode === 'until'));
  $('forFields').hidden = mode !== 'for';
  $('untilFields').hidden = mode !== 'until';
  renderRecents();
  errorUntil = 0;

  if (mode === 'until' && !$('until').value) $('until').value = defaultUntil();
  const input = mode === 'for' ? $('minutes') : $('until');
  input.focus();
  if (mode === 'for') input.select();

  if (save) {
    try { chrome.storage.local.set({ popupMode: mode }); } catch (_) { /* ignore */ }
  }
  tick();
}

// ---- Rendering ------------------------------------------------------------

// Parts that only change when state changes.
function renderStatic() {
  const input = $('minutes');
  input.max = st.max;
  if (firstLoad) {
    input.value = st.recents[0] || st.def;
    firstLoad = false;
  }

  renderRecents();
}

// Recent durations in Minutes mode, recent end times in End-time mode.
function renderRecents() {
  const box = $('recents');
  box.textContent = '';
  const list = mode === 'until' ? st.recentTimes : st.recents;
  for (const v of list) {
    const b = document.createElement('button');
    b.type = 'button';
    if (mode === 'until') {
      b.textContent = hhmmLabel(v);
      b.dataset.hhmm = v;
      b.addEventListener('click', () => startUntil(v));
    } else {
      b.textContent = `${v} min`;
      b.addEventListener('click', () => {
        $('minutes').value = v;
        send('start', v);
      });
    }
    box.appendChild(b);
  }
  $('recentWrap').hidden = list.length === 0;
  updateTimeButtons();
}

// Gray out recent end times that are currently out of range.
function updateTimeButtons() {
  for (const b of $('recents').querySelectorAll('button[data-hhmm]')) {
    const c = untilCheck(b.dataset.hhmm);
    b.disabled = !c.ok;
    b.title = c.text;
  }
}

// Parts that change every frame.
function tick() {
  const left = st.endTime - Date.now();
  const on = left > 0;
  const total = st.totalMs || 60000;

  document.body.classList.toggle('on', on);
  document.body.classList.toggle('warn', on && left <= 120000);

  $('time').textContent = on ? fmt(left) : '--:--';
  $('status').textContent = on
    ? `Staying awake until ${fmtClock(st.endTime)}`
    : 'Off — normal screen lock applies';
  $('fill').style.width = on ? `${Math.min(100, (left / total) * 100)}%` : '0%';
  $('go').textContent = on ? 'Restart' : 'Start';
  $('stop').hidden = !on;

  if (mode === 'until') updateTimeButtons();

  // Note line: an error if one is showing, otherwise the end-time preview.
  const note = $('note');
  if (Date.now() < errorUntil) return;
  note.classList.remove('error');
  if (mode === 'until') {
    const c = untilCheck();
    note.textContent = c.text;
    note.classList.toggle('error', !c.ok);
  } else {
    note.textContent = '';
  }
}

// ---- Events ---------------------------------------------------------------

$('modeFor').addEventListener('click', () => setMode('for'));
$('modeUntil').addEventListener('click', () => setMode('until'));
$('until').addEventListener('input', () => { errorUntil = 0; tick(); });

$('form').addEventListener('submit', (e) => {
  e.preventDefault();

  if (mode === 'until') {
    startUntil($('until').value);
    return;
  }

  const raw = $('minutes').value.trim();
  const n = Math.round(Number(raw));
  if (!raw || !Number.isFinite(n) || n < 1) {
    showError(`Enter 1–${st.max} minutes`);
    return;
  }
  if (n > st.max) showError(`Maximum is ${st.max} minutes`);
  const m = Math.min(n, st.max);
  $('minutes').value = m;
  send('start', m);
});

$('stop').addEventListener('click', () => send('stop'));

// ---- Init -----------------------------------------------------------------

send('get').then(async () => {
  let saved = 'for';
  try {
    const r = await chrome.storage.local.get('popupMode');
    if (r && r.popupMode) saved = r.popupMode;
  } catch (_) { /* ignore */ }
  setMode(saved, false);
});
setInterval(tick, 250);
