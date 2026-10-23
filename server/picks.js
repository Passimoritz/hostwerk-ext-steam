'use strict';
/*
 * „Was spiele ich heute?“ – Vorschläge aus der EIGENEN Bibliothek, ohne KI und ohne Konto:
 * Spielzeit und „zuletzt gespielt“ (localconfig.vdf) plus Genres/Kategorien aus dem Steam-Shop (store.js, gemerkt).
 *
 * Stimmungen:
 *   any        alles gemischt
 *   unfinished angefangen (1–20 h), seit ≥ 3 Wochen liegen gelassen
 *   forgotten  alte Lieblinge: viel gespielt, seit ≥ 3 Monaten nicht mehr
 *   new        installiert, nie gestartet
 *   short      eher kurze Runden (Casual, Rennen, Sport, Indie – kein RPG/Strategie/MMO)
 *   friends    Koop/Mehrspieler (Steam-Kategorien) – dazu, falls vorhanden, ein eigener Server
 * Zufall mit Gewicht, damit „Würfeln“ jedes Mal etwas anderes bringt; das zuletzt gespielte Spiel ist nie dabei.
 */
const DAY = 24 * 3600e3;
const MOODS = ['any', 'unfinished', 'forgotten', 'new', 'short', 'friends'];
const SHORT_GENRES = /casual|racing|sports|indie|arcade|gelegenheit|rennspiel|sport/i;
const LONG_GENRES = /\brpg\b|strategy|massively|rollenspiel|strategie/i;
const COOP_CATS = new Set([1, 9, 24, 27, 36, 37, 38, 39, 47, 48, 49]);

function reasonFor(g, d, now) {
  const idle = g.lastPlayed ? (now - g.lastPlayed) / DAY : null;
  const h = (g.playtime || 0) / 60;
  if (!g.playtime && !g.lastPlayed) return 'new';
  if (h >= 1 && h <= 20 && idle !== null && idle >= 21) return 'unfinished';
  if (h >= 20 && idle !== null && idle >= 90) return 'forgotten';
  if (d && d.genres && d.genres.some((x) => SHORT_GENRES.test(x)) && !d.genres.some((x) => LONG_GENRES.test(x))) return 'short';
  if (d && d.categories && d.categories.some((c) => COOP_CATS.has(c))) return 'friends';
  return 'any';
}

function fits(mood, g, d, now) {
  if (mood === 'any') return true;
  const idle = g.lastPlayed ? (now - g.lastPlayed) / DAY : null;
  const h = (g.playtime || 0) / 60;
  if (mood === 'new') return !g.playtime && !g.lastPlayed;
  if (mood === 'unfinished') return h >= 1 && h <= 20 && idle !== null && idle >= 21;
  if (mood === 'forgotten') return h >= 20 && idle !== null && idle >= 90;
  if (mood === 'short') return !!(d && d.genres && d.genres.some((x) => SHORT_GENRES.test(x)) && !d.genres.some((x) => LONG_GENRES.test(x)));
  if (mood === 'friends') return !!(d && d.categories && d.categories.some((c) => COOP_CATS.has(c)));
  return true;
}

/** Kleiner Zufallsgenerator mit Startwert (Tests reproduzierbar) */
function rng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * games: Bibliothek (library.js) · details(appid) → Shop-Angaben oder null · servers: Set(appid) mit eigenem Server möglich
 * → [{ appid, name, reason, playtime, lastPlayed, genres, server }]
 */
function suggest({ games, details = () => null, mood = 'any', count = 3, seed = Date.now(), now = Date.now(), servers = new Set(), exclude = [] }) {
  const m = MOODS.includes(mood) ? mood : 'any';
  const pool = (games || []).filter((g) => !g.tool && g.state && g.state.installed && !g.state.busy && !exclude.includes(g.appid));
  const recent = pool.filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
  const cands = pool.filter((g) => (!recent || g.appid !== recent.appid || pool.length <= 1) && fits(m, g, details(g.appid), now));
  const rand = rng(seed);
  const weight = (g) => {
    const idle = g.lastPlayed ? Math.min(365, (now - g.lastPlayed) / DAY) : 120;
    return 1 + idle / 60 + (g.playtime ? Math.min(3, Math.log10(1 + g.playtime / 60)) : 1);
  };
  const out = [];
  const left = [...cands];
  while (out.length < count && left.length) {
    const total = left.reduce((s, g) => s + weight(g), 0);
    let r = rand() * total;
    let i = 0;
    for (; i < left.length - 1; i++) { r -= weight(left[i]); if (r <= 0) break; }
    const g = left.splice(i, 1)[0];
    const d = details(g.appid);
    out.push({ appid: g.appid, name: g.name, reason: m === 'any' ? reasonFor(g, d, now) : m, playtime: g.playtime || 0, lastPlayed: g.lastPlayed || null, genres: d && d.genres ? d.genres.slice(0, 3) : [], short: d && d.short ? d.short : null, server: servers.has(g.appid) });
  }
  return { mood: m, picks: out, pool: cands.length };
}

module.exports = { suggest, fits, reasonFor, rng, MOODS };
