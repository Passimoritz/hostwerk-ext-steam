'use strict';
/*
 * Spielzeit-Statistik ohne Steam-Konto: Steam schreibt die Gesamtspielzeit je Spiel in localconfig.vdf (Minuten).
 * Hostwerk merkt sich den letzten Stand und bucht jede Zunahme auf den heutigen Tag – daraus entstehen Wochen und
 * Lieblingsspiele. Sitzungen (Start/Ende) kommen dazu, wenn Hostwerk beim Spielen läuft (RunningAppID).
 * Gespeichert: höchstens 400 Tage und 300 Sitzungen. Der erste Stand bucht nichts (sonst stünde alles auf „heute“).
 */
const DAY = 24 * 3600e3;
const MAX_DAYS = 400;
const MAX_SESSIONS = 300;

const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Montag der Woche (lokale Zeit) als Tagesschlüssel */
function weekKey(t) {
  const d = new Date(t);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dayKey(d.getTime());
}

/**
 * Neuer Stand der Spielzeiten → Zunahmen auf heute buchen. state = { last, days, user, sessions } (wird verändert)
 * Konto gewechselt → neu anfangen (keine falschen Zunahmen).
 */
function record(state, totals, { now = Date.now(), user = null } = {}) {
  const s = state;
  s.days = s.days || {};
  s.sessions = s.sessions || [];
  if (!s.last || s.user !== user) { s.last = { ...totals }; s.user = user; return 0; }
  const today = dayKey(now);
  let added = 0;
  for (const [id, min] of Object.entries(totals)) {
    const before = s.last[id] || 0;
    const delta = min - before;
    if (delta > 0 && delta < 24 * 60) { // mehr als ein Tag auf einmal = Import/Abgleich, nicht heute gespielt
      const d = s.days[today] || (s.days[today] = {});
      d[id] = (d[id] || 0) + delta;
      added += delta;
    }
  }
  s.last = { ...s.last, ...totals };
  const keys = Object.keys(s.days).sort();
  if (keys.length > MAX_DAYS) for (const k of keys.slice(0, keys.length - MAX_DAYS)) delete s.days[k];
  return added;
}

/** Sitzung merken (Spiel gestartet/beendet) */
function session(state, { appid, start, end }) {
  state.sessions = state.sessions || [];
  if (!appid || !start || !end || end <= start) return;
  state.sessions.push({ appid: Number(appid), start, end });
  if (state.sessions.length > MAX_SESSIONS) state.sessions.splice(0, state.sessions.length - MAX_SESSIONS);
}

/** Auswertung: Wochen (letzte n), Lieblingsspiele (Zeitraum), Tage dieser Woche, Serie */
function summary(state, { now = Date.now(), weeks = 12, topDays = 30 } = {}) {
  const days = state.days || {};
  const wk = new Map();
  for (let i = weeks - 1; i >= 0; i--) wk.set(weekKey(now - i * 7 * DAY), 0);
  const top = {};
  const from = dayKey(now - (topDays - 1) * DAY);
  for (const [k, apps] of Object.entries(days)) {
    const w = weekKey(new Date(`${k}T12:00:00`).getTime());
    const sum = Object.values(apps).reduce((a, b) => a + b, 0);
    if (wk.has(w)) wk.set(w, wk.get(w) + sum);
    if (k >= from) for (const [id, m] of Object.entries(apps)) top[id] = (top[id] || 0) + m;
  }
  // Tage in Folge mit Spielzeit (bis heute oder gestern)
  let streak = 0;
  for (let i = 0; i < 400; i++) {
    const k = dayKey(now - i * DAY);
    const has = days[k] && Object.values(days[k]).some((m) => m > 0);
    if (has) streak++;
    else if (i > 0) break;
  }
  const thisWeek = [];
  const monday = new Date(`${weekKey(now)}T12:00:00`).getTime();
  for (let i = 0; i < 7; i++) { const k = dayKey(monday + i * DAY); thisWeek.push({ day: k, minutes: days[k] ? Object.values(days[k]).reduce((a, b) => a + b, 0) : 0 }); }
  return {
    since: Object.keys(days).sort()[0] || null,
    weeks: [...wk.entries()].map(([week, minutes]) => ({ week, minutes })),
    thisWeek,
    top: Object.entries(top).map(([appid, minutes]) => ({ appid: Number(appid), minutes })).sort((a, b) => b.minutes - a.minutes).slice(0, 8),
    streak,
    sessions: (state.sessions || []).slice(-20).reverse(),
  };
}

module.exports = { record, session, summary, dayKey, weekKey };
