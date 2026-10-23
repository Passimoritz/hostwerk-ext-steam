'use strict';
/*
 * „Server dazu“: Zu welchen installierten Spielen gibt es einen eigenen Server (Steam-Server-Tool über SteamCMD)?
 * Quelle ist die Liste der Erweiterung „Spiele-Server“ (ctx.games.apps – Startprofile mit der Steam-ID des Spiels,
 * auf Wunsch Steams ganze Server-Liste). Ohne diese Erweiterung gibt es keine Treffer – Feature-Erkennung, kein Muss.
 *
 *   1. Server-Tool, dessen Eintrag „game“ die Steam-ID des Spiels nennt (verlässlich)
 *   2. sonst gleicher Name: „Valheim Dedicated Server“ ↔ „Valheim“ (lockerer Vergleich, nie Teilwörter)
 * Dazu: welche Server dieser Art es in Hostwerk schon gibt (läuft/gestoppt).
 */
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const toolBase = (name) => norm(String(name || '').replace(/\(.*?\)/g, ' ').replace(/\b(dedicated server|dedicated|server tool|server files|server|ds)\b/gi, ' '));

/** Zugriff auf die Erweiterung „Spiele-Server“ (oder null) */
function gamesApi(ctx) {
  const g = ctx && ctx.games;
  if (!g || typeof g.list !== 'function') return null;
  return g;
}

/** Alle bekannten Server-Tools (kuratiert + ggf. Steams Liste) */
function tools(games) {
  try {
    if (games && games.apps && typeof games.apps.all === 'function') return games.apps.all() || [];
  } catch { /* ältere Fassung */ }
  return [];
}

/**
 * Treffer je installiertem Spiel → Map(appid → { tool: { appid, name, profile, login }, servers: [{ id, name, running }] })
 */
function match(lib, games) {
  const out = new Map();
  if (!games) return out;
  const list = tools(games);
  if (!list.length) return out;
  const byGame = new Map();
  const byName = new Map();
  for (const t of list) {
    if (t.game) { const k = Number(t.game); if (!byGame.has(k) || (t.profile && !byGame.get(k).profile)) byGame.set(k, t); }
    const b = toolBase(t.name);
    if (b.length >= 3 && !byName.has(b)) byName.set(b, t);
  }
  let servers = [];
  try { servers = games.list() || []; } catch { servers = []; }
  for (const g of (lib && lib.games) || []) {
    if (g.tool) continue;
    const t = byGame.get(g.appid) || byName.get(norm(g.name)) || null;
    if (!t || t.appid === g.appid && !t.game) continue;
    const mine = servers.filter((s) => s && s.kind === 'steam' && Number(s.appid) === Number(t.appid)).map((s) => ({ id: s.id, name: s.name, running: !!s.running }));
    out.set(g.appid, { tool: { appid: t.appid, name: t.name, profile: !!t.profile, login: !!t.login }, servers: mine });
  }
  return out;
}

module.exports = { match, gamesApi, tools, toolBase, norm };
