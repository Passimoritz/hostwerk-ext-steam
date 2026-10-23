'use strict';
/*
 * Speicher-Doktor: Was frisst Platz, und was ließe sich zurückholen? Reine Regeln über die gelesene Bibliothek – ohne Netz,
 * ohne Liste von Spielen. Hostwerk löscht dabei NICHTS selbst: Deinstallieren und Verschieben macht Steam (steam://-Link
 * öffnet Steams eigenen Dialog), Reste öffnet Hostwerk nur im Explorer bzw. Dateimanager.
 *
 * Befund: { id, kind, appid?, name?, bytes, drive?, days?, to?, actions: [...] } – Texte baut die Oberfläche (Deutsch/Englisch).
 *   never-played   installiert, nie gestartet, seit ≥ 30 Tagen da, ≥ 1 GB          → in Steam deinstallieren
 *   dormant        lange nicht gespielt (Standard 180 Tage), ≥ 5 GB                 → deinstallieren (Spielstände vorher sichern)
 *   slow-drive     oft gespielt, liegt auf einer HDD, SSD-Bibliothek mit Platz da   → in Steam verschieben
 *   drive-low      Laufwerk mit Bibliothek fast voll (< 10 % oder < 20 GB frei)     → Hinweis mit den größten Kandidaten
 *   leftover       Workshop-, Shader-, Proton- oder Download-Reste von Spielen, die nicht mehr installiert sind
 */
const DAY = 24 * 3600e3;
const GB = 1024 ** 3;
const MB = 1024 ** 2;

const DEFAULTS = { dormantDays: 180, neverDays: 30, minNever: 1 * GB, minDormant: 5 * GB, minLeftover: 50 * MB, lowPct: 0.1, lowBytes: 20 * GB };

/**
 * lib = { games, libraries } (library.js) · drives = [{ key, label, paths, free, total, media }] (drives.js)
 * leftovers = { workshop: { appid: bytes }, shader: {…}, compat: {…}, downloading: {…} } – je Bibliothek zusammengefasst
 */
function diagnose({ lib, drives = [], leftovers = {}, now = Date.now(), opts = {} }) {
  const o = { ...DEFAULTS, ...opts };
  const games = (lib && lib.games ? lib.games : []).filter((g) => !g.tool && g.state && !g.state.uninstalling);
  const installed = new Set((lib && lib.games ? lib.games : []).map((g) => String(g.appid)));
  const driveOf = (p) => drives.find((d) => d.paths.includes(p)) || null;
  const out = [];

  for (const g of games) {
    const size = g.sizeOnDisk || 0;
    const age = g.lastUpdated ? (now - g.lastUpdated) / DAY : null;
    const idle = g.lastPlayed ? (now - g.lastPlayed) / DAY : null;
    const d = driveOf(g.library);
    if (!g.lastPlayed && !g.playtime && size >= o.minNever && age !== null && age >= o.neverDays) {
      out.push({ id: `never-${g.appid}`, kind: 'never-played', appid: g.appid, name: g.name, bytes: size, days: Math.floor(age), drive: d && d.label, actions: ['uninstall', 'details'] });
    } else if (idle !== null && idle >= o.dormantDays && size >= o.minDormant) {
      out.push({ id: `dormant-${g.appid}`, kind: 'dormant', appid: g.appid, name: g.name, bytes: size, days: Math.floor(idle), drive: d && d.label, actions: ['backup', 'uninstall', 'details'] });
    }
    // Oft gespielt auf drehender Platte, obwohl eine SSD-Bibliothek Platz hätte
    const hot = (g.playtime2wks || 0) > 0 || (idle !== null && idle <= 30 && (g.playtime || 0) >= 120);
    if (hot && d && d.media === 'hdd') {
      const ssd = drives.find((x) => x.media === 'ssd' && x.free != null && x.free > size * 1.1 + o.lowBytes);
      if (ssd) out.push({ id: `slow-${g.appid}`, kind: 'slow-drive', appid: g.appid, name: g.name, bytes: 0, size, drive: d.label, to: ssd.label, actions: ['move', 'details'] });
    }
  }

  // Volle Laufwerke: größte selten gespielte Spiele darauf nennen
  for (const d of drives) {
    if (d.free == null || !d.total) continue;
    if (d.free / d.total >= o.lowPct && d.free >= o.lowBytes) continue;
    const on = games.filter((g) => d.paths.includes(g.library)).sort((a, b) => score(b, now) - score(a, now)).slice(0, 3).map((g) => ({ appid: g.appid, name: g.name, bytes: g.sizeOnDisk }));
    out.push({ id: `low-${d.key}`, kind: 'drive-low', drive: d.label, free: d.free, total: d.total, bytes: 0, top: on, actions: [] });
  }

  // Reste von Spielen, die nicht mehr installiert sind
  for (const [what, map] of Object.entries(leftovers || {})) {
    for (const [appid, info] of Object.entries(map || {})) {
      const bytes = typeof info === 'number' ? info : (info && info.bytes) || 0;
      if (installed.has(String(appid)) || bytes < o.minLeftover) continue;
      out.push({ id: `left-${what}-${appid}`, kind: 'leftover', what, appid: Number(appid), name: (info && info.name) || null, bytes, dir: info && info.dir, actions: ['open-folder'] });
    }
  }

  const order = { 'drive-low': 0, leftover: 1, 'never-played': 2, dormant: 3, 'slow-drive': 4 };
  out.sort((a, b) => (order[a.kind] - order[b.kind]) || (b.bytes - a.bytes));
  const reclaim = out.filter((f) => f.kind !== 'slow-drive' && f.kind !== 'drive-low').reduce((s, f) => s + f.bytes, 0);
  return { findings: out, reclaim, counts: out.reduce((m, f) => { m[f.kind] = (m[f.kind] || 0) + 1; return m; }, {}) };
}

/** Wie sehr lohnt das Entfernen? Groß und lange nicht gespielt zuerst. */
function score(g, now) {
  const idle = g.lastPlayed ? (now - g.lastPlayed) / DAY : 3650;
  return (g.sizeOnDisk || 0) / GB * Math.min(10, 1 + idle / 90);
}

module.exports = { diagnose, score, DEFAULTS, GB, MB, DAY };
