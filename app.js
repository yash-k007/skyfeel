/*
 * Skyfeel — a private mood + weather journal.
 *
 * Privacy and security rules this file follows:
 *  1. Entries are stored ONLY in this browser (localStorage). There is no server,
 *     no account, no analytics. Nobody else, including the app's maker, can read them.
 *  2. The only network calls go to Open-Meteo, and they carry only a rounded location
 *     (2 decimals ≈ 1 km) or a city name typed by the user. Never moods, tags or notes.
 *  3. User text is always rendered with textContent, never as HTML (no innerHTML),
 *     so a note can never run as code.
 *  4. Everything read from storage or from an imported file is validated and cleaned
 *     before use.
 */
'use strict';

(() => {
  // ---------- Constants ----------
  const STORE_KEY = 'skyfeel.v1';
  const APP_VERSION = '1.0.0';
  const NOTE_MAX = 280;
  const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
  const API_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  const API_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
  const BACKFILL_DAYS = 90;

  const MOODS = [
    { v: 1, emoji: '😞', label: 'Awful' },
    { v: 2, emoji: '🙁', label: 'Meh' },
    { v: 3, emoji: '😐', label: 'Okay' },
    { v: 4, emoji: '🙂', label: 'Good' },
    { v: 5, emoji: '😄', label: 'Great' },
  ];
  const TAGS = ['work', 'study', 'sport', 'friends', 'family', 'outdoors', 'rest', 'slept badly', 'sick', 'creative'];
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ---------- Small helpers ----------
  const $ = (sel) => document.querySelector(sel);

  /** Safe element builder: text is always set as text, never parsed as HTML. */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [key, val] of Object.entries(attrs)) {
        if (val === null || val === undefined || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
        else node.setAttribute(key, val === true ? '' : String(val));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
  function todayKey() { return dateKey(new Date()); }
  function prettyDate(k) {
    return parseKey(k).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }
  function weekdayIndex(k) { return (parseKey(k).getDay() + 6) % 7; } // Monday = 0
  function round2(x) { return Math.round(x * 100) / 100; }
  function isNum(x, min, max) { return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max; }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- Weather codes (WMO) ----------
  function weatherInfo(code) {
    if (code === 0) return { kind: 'sunny', emoji: '☀️', label: 'Clear' };
    if (code === 1) return { kind: 'sunny', emoji: '🌤️', label: 'Mostly clear' };
    if (code === 2) return { kind: 'cloudy', emoji: '⛅', label: 'Partly cloudy' };
    if (code === 3) return { kind: 'cloudy', emoji: '☁️', label: 'Overcast' };
    if (code === 45 || code === 48) return { kind: 'fog', emoji: '🌫️', label: 'Fog' };
    if (code >= 51 && code <= 57) return { kind: 'rain', emoji: '🌦️', label: 'Drizzle' };
    if (code >= 61 && code <= 67) return { kind: 'rain', emoji: '🌧️', label: 'Rain' };
    if (code >= 71 && code <= 77) return { kind: 'snow', emoji: '❄️', label: 'Snow' };
    if (code >= 80 && code <= 82) return { kind: 'rain', emoji: '🌦️', label: 'Showers' };
    if (code === 85 || code === 86) return { kind: 'snow', emoji: '🌨️', label: 'Snow showers' };
    if (code >= 95 && code <= 99) return { kind: 'storm', emoji: '⛈️', label: 'Thunderstorm' };
    return { kind: 'other', emoji: '🌡️', label: 'Mixed' };
  }
  const KIND_LABELS = { sunny: '☀️ Sunny', cloudy: '☁️ Cloudy', fog: '🌫️ Foggy', rain: '🌧️ Rainy', snow: '❄️ Snowy', storm: '⛈️ Stormy', other: '🌡️ Other' };

  // ---------- Validation (everything from storage or import passes through here) ----------
  function cleanWeather(w) {
    if (!w || typeof w !== 'object') return null;
    if (!Number.isInteger(w.code) || w.code < 0 || w.code > 99) return null;
    return {
      code: w.code,
      tmax: isNum(w.tmax, -90, 60) ? w.tmax : null,
      tmin: isNum(w.tmin, -90, 60) ? w.tmin : null,
      daylightH: isNum(w.daylightH, 0, 24) ? w.daylightH : null,
      place: typeof w.place === 'string' ? w.place.slice(0, 80) : '',
    };
  }

  function cleanEntry(e) {
    if (!e || typeof e !== 'object') return null;
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return null;
    const d = parseKey(e.date);
    if (Number.isNaN(d.getTime()) || dateKey(d) !== e.date) return null; // rejects 2026-02-31 etc.
    if (e.date > todayKey()) return null; // no future entries
    const mood = Number(e.mood);
    if (!Number.isInteger(mood) || mood < 1 || mood > 5) return null;
    const tags = Array.isArray(e.tags) ? [...new Set(e.tags.filter((t) => typeof t === 'string' && TAGS.includes(t)))] : [];
    const note = typeof e.note === 'string' ? e.note.slice(0, NOTE_MAX) : '';
    return {
      date: e.date,
      mood,
      tags,
      note,
      weather: cleanWeather(e.weather),
      updatedAt: isNum(e.updatedAt, 0, 8.64e15) ? e.updatedAt : Date.now(),
    };
  }

  function cleanPlace(p) {
    if (!p || typeof p !== 'object') return null;
    if (!isNum(p.lat, -90, 90) || !isNum(p.lon, -180, 180)) return null;
    const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : 'My area';
    return { name, lat: round2(p.lat), lon: round2(p.lon) };
  }

  function freshState() {
    return { version: 1, entries: {}, settings: { place: null, reminderTime: '20:00', onboarded: false } };
  }

  function cleanState(raw) {
    const s = freshState();
    if (!raw || typeof raw !== 'object') return s;
    const list = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries || {});
    for (const item of list) {
      const e = cleanEntry(item);
      if (e) s.entries[e.date] = e;
    }
    const st = raw.settings || {};
    s.settings.place = cleanPlace(st.place);
    s.settings.reminderTime = typeof st.reminderTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(st.reminderTime) ? st.reminderTime : '20:00';
    s.settings.onboarded = st.onboarded === true;
    return s;
  }

  // ---------- Storage (on this device only) ----------
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? cleanState(JSON.parse(raw)) : freshState();
    } catch {
      return freshState();
    }
  }

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch {
      toast('Could not save: storage is full or blocked by the browser.');
      return false;
    }
  }

  const state = load();

  // Ask the browser not to auto-clear our storage (helps on Android; harmless elsewhere).
  try { navigator.storage?.persist?.(); } catch { /* not supported */ }

  // ---------- Network (Open-Meteo only, never personal content) ----------
  async function fetchJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        credentials: 'omit',     // never send cookies
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchDayWeather(date, place) {
    const url = new URL(API_FORECAST);
    url.search = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,daylight_duration',
      timezone: 'auto',
      start_date: date,
      end_date: date,
    }).toString();
    const data = await fetchJSON(url.toString());
    const d = data && data.daily;
    if (!d || !Array.isArray(d.weather_code)) throw new Error('Unexpected weather data');
    return cleanWeather({
      code: d.weather_code[0],
      tmax: d.temperature_2m_max?.[0],
      tmin: d.temperature_2m_min?.[0],
      daylightH: typeof d.daylight_duration?.[0] === 'number' ? Math.round(d.daylight_duration[0] / 360) / 10 : null,
      place: place.name,
    });
  }

  let currentCache = null; // { key, at, data } — kept in memory only
  async function fetchCurrentWeather(place) {
    const key = `${place.lat},${place.lon}`;
    if (currentCache && currentCache.key === key && Date.now() - currentCache.at < 30 * 60 * 1000) return currentCache.data;
    const url = new URL(API_FORECAST);
    url.search = new URLSearchParams({
      latitude: String(place.lat),
      longitude: String(place.lon),
      current: 'temperature_2m,weather_code',
      daily: 'temperature_2m_max,temperature_2m_min',
      forecast_days: '1',
      timezone: 'auto',
    }).toString();
    const data = await fetchJSON(url.toString());
    const c = data && data.current;
    if (!c || !Number.isInteger(c.weather_code)) throw new Error('Unexpected weather data');
    const out = {
      code: c.weather_code,
      temp: isNum(c.temperature_2m, -90, 60) ? c.temperature_2m : null,
      tmax: data.daily?.temperature_2m_max?.[0],
      tmin: data.daily?.temperature_2m_min?.[0],
    };
    currentCache = { key, at: Date.now(), data: out };
    return out;
  }

  async function searchCity(query) {
    const q = query.trim().slice(0, 60);
    if (q.length < 2) return [];
    const url = new URL(API_GEO);
    url.search = new URLSearchParams({ name: q, count: '6', language: 'en', format: 'json' }).toString();
    const data = await fetchJSON(url.toString());
    const results = Array.isArray(data && data.results) ? data.results : [];
    return results
      .map((r) => {
        const parts = [r.name, r.admin1, r.country].filter((x) => typeof x === 'string' && x);
        return cleanPlace({ name: parts.join(', '), lat: r.latitude, lon: r.longitude });
      })
      .filter(Boolean);
  }

  // Fill in weather for recent entries saved while offline (sequential, max 10 per launch).
  async function backfillWeather() {
    const place = state.settings.place;
    if (!place || !navigator.onLine) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - BACKFILL_DAYS);
    const cutoffKey = dateKey(cutoff);
    const missing = Object.values(state.entries).filter((e) => !e.weather && e.date >= cutoffKey).slice(0, 10);
    let filled = 0;
    for (const e of missing) {
      try {
        e.weather = await fetchDayWeather(e.date, place);
        filled++;
      } catch { break; }
    }
    if (filled) { persist(); render(); }
  }

  // ---------- Navigation ----------
  let currentView = 'today';
  let editingDate = todayKey();
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth();

  function showView(name) {
    currentView = name;
    for (const v of ['today', 'calendar', 'insights', 'settings']) {
      $(`#view-${v}`).hidden = v !== name;
    }
    for (const b of document.querySelectorAll('nav.tabs button')) {
      if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    if (currentView === 'today') renderToday();
    else if (currentView === 'calendar') renderCalendar();
    else if (currentView === 'insights') renderInsights();
    else renderSettings();
  }

  function setSky(kind) {
    document.body.classList.remove('sky-sunny', 'sky-rain', 'sky-snow', 'sky-storm', 'sky-fog');
    if (['sunny', 'rain', 'snow', 'storm', 'fog'].includes(kind)) document.body.classList.add(`sky-${kind}`);
  }

  // ---------- Today / entry editor ----------
  function renderToday() {
    const root = $('#view-today');
    root.replaceChildren();
    const isToday = editingDate === todayKey();
    const existing = state.entries[editingDate] || null;
    const draft = {
      mood: existing ? existing.mood : null,
      tags: new Set(existing ? existing.tags : []),
      note: existing ? existing.note : '',
    };

    // Heading
    root.append(el('h2', { text: isToday ? 'How do you feel today?' : prettyDate(editingDate) }));
    if (!isToday) {
      root.append(el('button', { type: 'button', class: 'btn link', text: '← Back to today', onclick: () => { editingDate = todayKey(); render(); } }));
    }

    // Gentle reminder nudge (no guilt)
    if (isToday && !existing) {
      const now = new Date();
      const [h, m] = state.settings.reminderTime.split(':').map(Number);
      if (now.getHours() * 60 + now.getMinutes() >= h * 60 + m) {
        root.append(el('div', { class: 'banner', text: '🌙 Your daily check-in is waiting. It takes ten seconds.' }));
      }
    }

    // Weather card
    root.append(weatherCard(existing, isToday));

    // Mood picker
    const moodButtons = MOODS.map((m) => el('button', {
      type: 'button', class: 'mood', 'aria-pressed': String(draft.mood === m.v), 'aria-label': m.label,
      onclick: (ev) => {
        draft.mood = m.v;
        for (const b of moodButtons) b.setAttribute('aria-pressed', String(b === ev.currentTarget));
        saveBtn.disabled = false;
      },
    }, m.emoji, el('span', { text: m.label })));
    root.append(el('div', { class: 'card' }, el('h3', { text: 'Mood' }), el('div', { class: 'moods' }, moodButtons)));

    // Tags
    const chips = TAGS.map((t) => el('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(draft.tags.has(t)), text: t,
      onclick: (ev) => {
        if (draft.tags.has(t)) draft.tags.delete(t); else draft.tags.add(t);
        ev.currentTarget.setAttribute('aria-pressed', String(draft.tags.has(t)));
      },
    }));
    root.append(el('div', { class: 'card' }, el('h3', { text: "What's going on? (optional)" }), el('div', { class: 'chips' }, chips)));

    // Note
    const counter = el('div', { class: 'counter', text: `${draft.note.length}/${NOTE_MAX}` });
    const note = el('textarea', { id: 'note', maxlength: NOTE_MAX, placeholder: 'A line about your day (stays on this phone)', 'aria-label': 'Note' });
    note.value = draft.note;
    note.addEventListener('input', () => {
      if (note.value.length > NOTE_MAX) note.value = note.value.slice(0, NOTE_MAX);
      draft.note = note.value;
      counter.textContent = `${note.value.length}/${NOTE_MAX}`;
    });
    root.append(el('div', { class: 'card' }, el('h3', { text: 'Note (optional)' }), note, counter));

    // Save
    const saveBtn = el('button', { type: 'button', class: 'btn block', text: existing ? 'Update entry' : 'Save entry' });
    saveBtn.disabled = draft.mood === null;
    saveBtn.addEventListener('click', () => saveEntry(draft, existing, saveBtn));
    root.append(saveBtn);

    if (existing) {
      root.append(el('div', { class: 'row', style: null },
        el('button', {
          type: 'button', class: 'btn link', text: 'Delete this entry',
          onclick: () => {
            if (!confirm('Delete the entry for this day? This cannot be undone.')) return;
            delete state.entries[editingDate];
            persist();
            toast('Entry deleted');
            render();
          },
        })));
    }
  }

  function weatherCard(existing, isToday) {
    const place = state.settings.place;
    const card = el('div', { class: 'card' });

    if (existing && existing.weather) {
      const w = existing.weather;
      const info = weatherInfo(w.code);
      setSky(info.kind);
      card.append(el('div', { class: 'weather' },
        el('div', { class: 'big', 'aria-hidden': 'true', text: info.emoji }),
        el('div', null,
          el('div', { class: 'temp', text: w.tmax !== null ? `${Math.round(w.tmax)}° / ${Math.round(w.tmin ?? w.tmax)}°` : info.label }),
          el('div', { class: 'muted', text: `${info.label}${w.place ? ' · ' + w.place : ''}` }))));
      return card;
    }

    if (!place) {
      setSky(null);
      card.append(
        el('div', { class: 'weather' },
          el('div', { class: 'big', 'aria-hidden': 'true', text: '🌍' }),
          el('div', null,
            el('div', { text: 'Add a location to attach the weather automatically.' }),
            el('button', { type: 'button', class: 'btn link', text: 'Set location →', onclick: () => showView('settings') }))));
      return card;
    }

    if (!isToday) {
      card.append(el('div', { class: 'muted', text: `Weather for ${place.name} will be attached when you save.` }));
      return card;
    }

    const line = el('div', { class: 'muted', text: `Checking the sky over ${place.name}…` });
    card.append(line);
    fetchCurrentWeather(place).then((c) => {
      if (!card.isConnected) return;
      const info = weatherInfo(c.code);
      setSky(info.kind);
      card.replaceChildren(el('div', { class: 'weather' },
        el('div', { class: 'big', 'aria-hidden': 'true', text: info.emoji }),
        el('div', null,
          el('div', { class: 'temp', text: c.temp !== null ? `${Math.round(c.temp)}°C` : info.label }),
          el('div', { class: 'muted', text: `${info.label} · ${place.name}` }))));
    }).catch(() => {
      if (card.isConnected) line.textContent = 'Weather unavailable right now. It will be attached later.';
    });
    return card;
  }

  async function saveEntry(draft, existing, btn) {
    if (draft.mood === null) return;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    const date = editingDate;
    let weather = existing ? existing.weather : null;
    let weatherNote = '';
    const place = state.settings.place;
    if (!weather && place) {
      try { weather = await fetchDayWeather(date, place); weatherNote = ' with the weather'; }
      catch { weatherNote = ' (weather will be added later)'; }
    }
    const entry = cleanEntry({
      date, mood: draft.mood, tags: [...draft.tags], note: draft.note, weather, updatedAt: Date.now(),
    });
    if (!entry) { toast('Could not save this entry.'); btn.disabled = false; return; }
    state.entries[date] = entry;
    if (persist()) {
      try { navigator.vibrate?.(15); } catch { /* not supported */ }
      toast(`Saved${weatherNote} ✓`);
    }
    render();
    const picked = document.querySelector('.mood[aria-pressed="true"]');
    if (picked) picked.classList.add('pop');
  }

  // ---------- Calendar ----------
  function streak() {
    let count = 0;
    const d = new Date();
    if (!state.entries[dateKey(d)]) d.setDate(d.getDate() - 1); // today not logged yet doesn't break it
    while (state.entries[dateKey(d)]) { count++; d.setDate(d.getDate() - 1); }
    return count;
  }

  function renderCalendar() {
    setSky(null);
    const root = $('#view-calendar');
    root.replaceChildren();
    const now = new Date();
    const isCurrentMonth = calYear === now.getFullYear() && calMonth === now.getMonth();

    const s = streak();
    root.append(el('h2', { text: 'Your mood calendar' }));
    root.append(el('p', { class: 'muted', text: s > 0 ? `🔥 ${s}-day streak` : 'Log today to start a streak.' }));

    const card = el('div', { class: 'card' });
    card.append(el('div', { class: 'cal-head' },
      el('button', { type: 'button', 'aria-label': 'Previous month', text: '‹', onclick: () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } render(); } }),
      el('div', { class: 'title', text: `${MONTHS[calMonth]} ${calYear}` }),
      el('button', { type: 'button', 'aria-label': 'Next month', text: '›', disabled: isCurrentMonth, onclick: () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } render(); } })));

    const grid = el('div', { class: 'grid' });
    for (const w of WEEKDAYS) grid.append(el('div', { class: 'dow', text: w }));
    const first = new Date(calYear, calMonth, 1);
    const offset = (first.getDay() + 6) % 7;
    for (let i = 0; i < offset; i++) grid.append(el('div', { class: 'day pad', 'aria-hidden': 'true' }));
    const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    const tKey = todayKey();
    for (let day = 1; day <= daysInMonth; day++) {
      const key = dateKey(new Date(calYear, calMonth, day));
      const e = state.entries[key];
      const future = key > tKey;
      const classes = ['day'];
      if (e) classes.push(`m${e.mood}`);
      if (key === tKey) classes.push('is-today');
      const label = `${prettyDate(key)}${e ? ', mood ' + MOODS[e.mood - 1].label : ', no entry'}`;
      grid.append(el('button', {
        type: 'button', class: classes.join(' '), disabled: future, 'aria-label': label,
        onclick: () => { editingDate = key; showView('today'); },
      }, el('span', { text: String(day) }), e && e.weather ? el('span', { class: 'w', 'aria-hidden': 'true', text: weatherInfo(e.weather.code).emoji }) : null));
    }
    card.append(grid);
    card.append(el('div', { class: 'legend' },
      MOODS.map((m) => el('span', null, el('span', { class: `dot m${m.v}`, 'aria-hidden': 'true' }), m.label))));
    root.append(card);
    root.append(el('p', { class: 'muted small', text: 'Tap any past day to add or edit its entry.' }));
  }

  // ---------- Insights ----------
  function avg(list) { return list.reduce((a, b) => a + b, 0) / list.length; }

  function groupAvg(entries, keyFn) {
    const groups = new Map();
    for (const e of entries) {
      const k = keyFn(e);
      if (k === null) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e.mood);
    }
    return [...groups.entries()].map(([k, moods]) => ({ key: k, avg: avg(moods), n: moods.length }));
  }

  function barSection(title, rows, labelFn) {
    const card = el('div', { class: 'card' }, el('h3', { text: title }));
    if (!rows.length) { card.append(el('div', { class: 'muted', text: 'Not enough data yet.' })); return card; }
    for (const r of rows) {
      const bar = el('div', { class: 'bar' });
      bar.style.width = `${Math.max(4, (r.avg / 5) * 100)}%`; // CSSOM: allowed by the strict CSP
      bar.classList.add(`m${Math.min(5, Math.max(1, Math.round(r.avg)))}`);
      card.append(el('div', { class: 'bar-row' },
        el('div', { text: labelFn(r.key) }),
        el('div', { class: 'bar-track', role: 'img', 'aria-label': `${labelFn(r.key)}: average ${r.avg.toFixed(1)} of 5 over ${r.n} days` }, bar),
        el('div', { class: 'bar-val', text: `${r.avg.toFixed(1)} · ${r.n}d` })));
    }
    return card;
  }

  function friendlyLine(byKind) {
    const usable = byKind.filter((r) => r.n >= 2).sort((a, b) => b.avg - a.avg);
    if (usable.length < 2) return null;
    const best = usable[0];
    const worst = usable[usable.length - 1];
    if (best.avg - worst.avg < 0.3) return 'The weather barely moves your mood. Steady as a rock. 🪨';
    const pct = Math.round(((best.avg - worst.avg) / worst.avg) * 100);
    return `You're ${pct}% brighter on ${KIND_LABELS[best.key].split(' ')[1].toLowerCase()} days than on ${KIND_LABELS[worst.key].split(' ')[1].toLowerCase()} ones.`;
  }

  function tempBand(t) {
    if (t === null) return null;
    if (t < 5) return 'a';
    if (t < 15) return 'b';
    if (t < 25) return 'c';
    return 'd';
  }
  const BAND_LABELS = { a: 'Below 5°C', b: '5–15°C', c: '15–25°C', d: '25°C and up' };

  function renderInsights() {
    setSky(null);
    const root = $('#view-insights');
    root.replaceChildren();
    root.append(el('h2', { text: 'Your patterns' }));
    const entries = Object.values(state.entries);
    if (entries.length < 3) {
      root.append(el('div', { class: 'card' },
        el('p', { text: '🌱 Log at least 3 days and your first patterns will appear here.' }),
        el('p', { class: 'muted', text: `You have ${entries.length} so far.` })));
      return;
    }
    const mean = avg(entries.map((e) => e.mood));
    root.append(el('div', { class: 'card stats' },
      el('div', null, el('div', { class: 'n', text: String(entries.length) }), el('div', { class: 'l', text: 'days logged' })),
      el('div', null, el('div', { class: 'n', text: MOODS[Math.round(mean) - 1].emoji }), el('div', { class: 'l', text: `avg ${mean.toFixed(1)} / 5` })),
      el('div', null, el('div', { class: 'n', text: String(streak()) }), el('div', { class: 'l', text: 'day streak' }))));

    const withWeather = entries.filter((e) => e.weather);
    const byKind = groupAvg(withWeather, (e) => weatherInfo(e.weather.code).kind).sort((a, b) => b.avg - a.avg);
    const line = friendlyLine(byKind);
    if (line) root.append(el('div', { class: 'card' }, el('div', { class: 'insight-line', text: line })));

    root.append(barSection('Mood by weather', byKind, (k) => KIND_LABELS[k]));
    const byTemp = groupAvg(withWeather, (e) => tempBand(e.weather.tmax)).sort((a, b) => a.key.localeCompare(b.key));
    root.append(barSection('Mood by temperature (daily high)', byTemp, (k) => BAND_LABELS[k]));
    const byDay = groupAvg(entries, (e) => weekdayIndex(e.date)).sort((a, b) => a.key - b.key);
    root.append(barSection('Mood by weekday', byDay, (k) => WEEKDAYS[k]));
    root.append(el('p', { class: 'muted small', text: 'Patterns are just for curiosity, not medical advice. They get more reliable after a few weeks.' }));
  }

  // ---------- Settings ----------
  function renderSettings() {
    setSky(null);
    const root = $('#view-settings');
    root.replaceChildren();
    root.append(el('h2', { text: 'Settings' }));

    // Location
    const place = state.settings.place;
    const results = el('div', { class: 'results' });
    const search = el('input', { type: 'search', maxlength: 60, placeholder: 'Search a city, e.g. Milan', 'aria-label': 'City name', autocomplete: 'off' });
    const doSearch = async () => {
      results.replaceChildren(el('div', { class: 'muted', text: 'Searching…' }));
      try {
        const found = await searchCity(search.value);
        results.replaceChildren();
        if (!found.length) { results.append(el('div', { class: 'muted', text: 'No places found.' })); return; }
        for (const p of found) {
          results.append(el('button', { type: 'button', text: p.name, onclick: () => setPlace(p) }));
        }
      } catch {
        results.replaceChildren(el('div', { class: 'muted', text: 'Search is unavailable right now. Check your connection.' }));
      }
    };
    search.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') doSearch(); });

    root.append(el('div', { class: 'card stack' },
      el('h3', { text: 'Location for weather' }),
      el('div', { text: place ? `📍 ${place.name}` : 'No location set.' }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn secondary', text: '📡 Use my location', onclick: useMyLocation }),
        place ? el('button', { type: 'button', class: 'btn danger', text: 'Remove', onclick: () => { state.settings.place = null; currentCache = null; persist(); render(); } }) : null),
      el('div', { class: 'row' },
        el('div', { class: 'grow' }, search),
        el('button', { type: 'button', class: 'btn secondary', text: 'Search', onclick: doSearch })),
      results,
      el('p', { class: 'muted small', text: 'Only an approximate position (rounded to about 1 km) or the city you pick is sent to Open-Meteo to get the weather. Your moods and notes are never sent anywhere.' })));

    // Reminder
    const time = el('input', { type: 'time', 'aria-label': 'Reminder time' });
    time.value = state.settings.reminderTime;
    time.addEventListener('change', () => {
      if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time.value)) { state.settings.reminderTime = time.value; persist(); toast('Reminder time saved'); }
    });
    root.append(el('div', { class: 'card stack' },
      el('h3', { text: 'Daily reminder' }),
      el('div', { class: 'row' }, el('label', { text: 'Remind me at' }), time),
      el('button', { type: 'button', class: 'btn secondary block', text: '📅 Add daily reminder to my calendar', onclick: downloadReminder }),
      el('p', { class: 'muted small', text: "This creates a repeating event in your phone's own calendar app, so no reminder server is needed. The app also shows a gentle nudge after this time if you haven't logged yet." })));

    // Data
    const fileInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    fileInput.addEventListener('change', () => { if (fileInput.files[0]) importFile(fileInput.files[0]); fileInput.value = ''; });
    const count = Object.keys(state.entries).length;
    root.append(el('div', { class: 'card stack' },
      el('h3', { text: 'Your data' }),
      el('div', { class: 'muted', text: `${count} ${count === 1 ? 'entry' : 'entries'} stored on this device only.` }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn secondary', text: 'Export JSON', onclick: exportJSON, disabled: count === 0 }),
        el('button', { type: 'button', class: 'btn secondary', text: 'Export CSV', onclick: exportCSV, disabled: count === 0 }),
        el('button', { type: 'button', class: 'btn secondary', text: 'Import backup', onclick: () => fileInput.click() })),
      fileInput,
      el('button', { type: 'button', class: 'btn danger block', text: '🗑️ Delete all my data', onclick: deleteAll }),
      el('p', { class: 'muted small', text: 'Tip: export a backup now and then. Clearing your browser data or uninstalling the app erases your entries, and nobody else has a copy.' })));

    // Install + privacy
    root.append(el('div', { class: 'card stack' },
      el('h3', { text: 'Install on your phone' }),
      el('p', { class: 'muted', text: 'Android (Chrome): menu ⋮ → "Add to Home screen" or "Install app". iPhone (Safari): Share → "Add to Home Screen".' })));

    root.append(el('div', { class: 'card stack' },
      el('h3', { text: 'Privacy' }),
      el('ul', { class: 'plain' },
        el('li', { text: '🔒 No account, no server, no analytics, no ads.' }),
        el('li', { text: '📱 Entries are stored only in this browser on this device.' }),
        el('li', { text: '🌍 The weather service sees an approximate location and your IP address, as any website would. It never sees your mood or notes.' })),
      el('a', { href: 'privacy.html', text: 'Read the full privacy policy' }),
      el('p', { class: 'muted small' },
        'Weather data by ',
        el('a', { href: 'https://open-meteo.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Open-Meteo.com' }),
        ' (CC BY 4.0). Skyfeel is a personal journal, not a medical tool. Version ' + APP_VERSION + '.')));
  }

  function setPlace(p) {
    state.settings.place = cleanPlace(p);
    currentCache = null;
    persist();
    toast(`Location set: ${state.settings.place.name}`);
    render();
    backfillWeather();
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) { toast('Location is not available on this device.'); return; }
    toast('Asking for your approximate location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => setPlace({ name: 'Near you (≈1 km)', lat: round2(pos.coords.latitude), lon: round2(pos.coords.longitude) }),
      () => toast('Location not shared. You can search for your city instead.'),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 60 * 60 * 1000 },
    );
  }

  // ---------- Files: export / import / reminder ----------
  function download(filename, mime, text) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function sortedEntries() { return Object.values(state.entries).sort((a, b) => a.date.localeCompare(b.date)); }

  function exportJSON() {
    const data = { app: 'skyfeel', version: 1, exportedAt: new Date().toISOString(), entries: sortedEntries() };
    download(`skyfeel-backup-${todayKey()}.json`, 'application/json', JSON.stringify(data, null, 2));
  }

  /** CSV cell; text cells are protected against spreadsheet formula injection. */
  function csvCell(v, isText) {
    let s = v === null || v === undefined ? '' : String(v);
    if (isText && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  function exportCSV() {
    const lines = [['date', 'mood', 'mood_label', 'tags', 'note', 'weather', 'temp_max_c', 'temp_min_c', 'daylight_h', 'place'].join(',')];
    for (const e of sortedEntries()) {
      const w = e.weather;
      lines.push([
        csvCell(e.date), csvCell(e.mood), csvCell(MOODS[e.mood - 1].label, true), csvCell(e.tags.join('; '), true),
        csvCell(e.note, true), csvCell(w ? weatherInfo(w.code).label : '', true), csvCell(w ? w.tmax : ''),
        csvCell(w ? w.tmin : ''), csvCell(w ? w.daylightH : ''), csvCell(w ? w.place : '', true),
      ].join(','));
    }
    download(`skyfeel-${todayKey()}.csv`, 'text/csv', '﻿' + lines.join('\r\n'));
  }

  function importFile(file) {
    if (file.size > IMPORT_MAX_BYTES) { toast('That file is too large to be a Skyfeel backup.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let parsed;
      try { parsed = JSON.parse(String(reader.result)); } catch { toast('That file is not a valid backup.'); return; }
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
      if (!list) { toast('That file is not a Skyfeel backup.'); return; }
      const clean = list.map(cleanEntry).filter(Boolean);
      if (!clean.length) { toast('No valid entries found in that file.'); return; }
      const skipped = list.length - clean.length;
      if (!confirm(`Import ${clean.length} entries${skipped ? ` (${skipped} invalid ones skipped)` : ''}? Days that already have an entry will be replaced.`)) return;
      for (const e of clean) state.entries[e.date] = e;
      if (persist()) toast(`Imported ${clean.length} entries ✓`);
      render();
    };
    reader.onerror = () => toast('Could not read that file.');
    reader.readAsText(file);
  }

  function deleteAll() {
    if (!confirm('Delete ALL entries, your location and settings from this device? This cannot be undone.')) return;
    if (!confirm('Are you sure? Consider exporting a backup first.')) return;
    try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
    const fresh = freshState();
    fresh.settings.onboarded = true;
    state.entries = fresh.entries;
    state.settings = fresh.settings;
    currentCache = null;
    persist();
    toast('All data deleted');
    render();
  }

  function downloadReminder() {
    const [h, m] = state.settings.reminderTime.split(':');
    const start = new Date();
    const ymd = `${start.getFullYear()}${pad2(start.getMonth() + 1)}${pad2(start.getDate())}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const uid = `skyfeel-reminder-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@skyfeel.app`;
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Skyfeel//Reminder//EN', 'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:${uid}`, `DTSTAMP:${stamp}`,
      `DTSTART:${ymd}T${h}${m}00`, 'DURATION:PT5M', 'RRULE:FREQ=DAILY',
      "SUMMARY:How's the sky inside you today? ☁️",
      'DESCRIPTION:Open Skyfeel and log your mood.',
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Log your mood in Skyfeel', 'TRIGGER:PT0M', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n');
    download('skyfeel-daily-reminder.ics', 'text/calendar', ics);
    toast('Open the downloaded file to add it to your calendar');
  }

  // ---------- Start ----------
  for (const b of document.querySelectorAll('nav.tabs button')) {
    b.addEventListener('click', () => {
      if (b.dataset.view === 'today') editingDate = todayKey();
      showView(b.dataset.view);
    });
  }

  const welcome = $('#welcome');
  $('#welcome-ok').addEventListener('click', () => {
    state.settings.onboarded = true;
    persist();
    welcome.close();
  });
  if (!state.settings.onboarded && typeof welcome.showModal === 'function') welcome.showModal();

  render();
  backfillWeather();
  window.addEventListener('online', backfillWeather);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support unavailable, app still works */ });
  }
})();
