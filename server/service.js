'use strict';
/*
 * Steam & Spiele – Server-Teil (native Erweiterung). Liest Steams Dateien, schreibt nur in den eigenen Datenordner.
 *
 *   GET  /steam                      Bibliothek, Laufwerke, Zustand von Steam, Summen, Server-Treffer (aus dem Zwischenstand)
 *   POST /steam/rescan               sofort neu lesen (auch Laufwerke und Reste)
 *   PUT  /steam/user                 { accountId } – welches Steam-Konto die Spielzeit liefert
 *   GET  /steam/art/:appid?kind=     Bild: zuerst Steams eigener Bild-Zwischenspeicher, sonst Steams CDN über Hostwerks Bildspeicher
 *   GET  /steam/doctor               Speicher-Doktor
 *   GET  /steam/saves                Spielstände je Spiel (Ludusavi) · GET /steam/saves/:appid (Orte + Stände)
 *   POST /steam/saves/:appid/backup  jetzt sichern · POST /steam/saves/restore { id } · DELETE /steam/saves/:id
 *   POST /steam/saves/manifest       Ludusavi-Verzeichnis jetzt laden
 *   GET  /steam/shop                 Merkliste mit Preisen · POST/DELETE /steam/shop/watch · GET /steam/shop/search?q=
 *   POST /steam/shop/wishlist        öffentliche Wunschliste des gewählten Kontos übernehmen · POST /steam/shop/refresh
 *   GET  /steam/stats · GET /steam/picks?mood=&seed= · GET /steam/screenshots · GET /steam/screenshot/:appid/:file
 *   POST /steam/open { action, appid } (steam://) · POST /steam/folder { kind, id } (Ordner im Explorer)
 *
 * Hintergrund: alle 15 s „läuft Steam / welches Spiel“ (Registry bzw. registry.vdf) – endet eine Spielsitzung, sichert
 * Hostwerk die Spielstände (falls eingeschaltet) und bucht die Spielzeit. Alle 6 h: Laufwerke, Reste, Ludusavi-Verzeichnis,
 * Preise (Merkliste + Bibliothekswert), Genres. Offline-Modus: keine Abfragen ins Netz, alles Lokale läuft weiter.
 */
const fs = require('fs');
const path = require('path');
const locate = require('./locate');
const L = require('./library');
const drives = require('./drives');
const { diagnose } = require('./doctor');
const lud = require('./ludusavi');
const { SaveStore } = require('./saves');
const { Shop, libraryValue, COUNTRIES } = require('./store');
const stats = require('./stats');
const { suggest } = require('./picks');
const servers = require('./servers');
const links = require('./links');

const STEAM_CDN = ['https://shared.akamai.steamstatic.com/store_item_assets/steam/apps', 'https://cdn.cloudflare.steamstatic.com/steam/apps'];
const CDN_FILE = { portrait: 'library_600x900.jpg', header: 'header.jpg', hero: 'library_hero.jpg', logo: 'logo.png' };
const SCAN_AGE = 12e3;
const SLOW_EVERY = 6 * 3600e3;
const DEFAULTS = { autoBackup: true, includeConfig: false, keep: 15, notifyDeals: true, country: 'DE', dormantDays: 180, steamPath: '' };

const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(`${f}.tmp`, JSON.stringify(v)); fs.renameSync(`${f}.tmp`, f); };

/** io (Tests): { find, scan, runState, describe, fetch, now, offline, platform, open, games, imageCache, dataDir } */
function createService(host, io = {}) {
  const ctx = host.ctx || {};
  const now = io.now || (() => Date.now());
  const platform = io.platform || process.platform;
  const dataDir = io.dataDir || path.join(ctx.paths.data, 'steam');
  const can = (name) => { try { return typeof host.supports === 'function' && host.supports(name) === true; } catch { return false; } };
  const offline = io.offline || (() => { try { return can('net.offline') ? host.net.offline() === true : host.core('download').isOffline(); } catch { return false; } });
  const T = (s, v) => (typeof host.t === 'function' ? host.t(s, v) : s);
  const settings = () => {
    let s = {};
    try { s = (ctx.extMarket && ctx.extMarket.settingsFor(host.id)) || {}; } catch { /* Standard */ }
    const out = { ...DEFAULTS, ...s };
    out.country = COUNTRIES.includes(String(out.country)) ? String(out.country) : 'DE';
    out.keep = Math.max(3, Math.min(100, Number(out.keep) || 15));
    out.dormantDays = Math.max(30, Math.min(2000, Number(out.dormantDays) || 180));
    return out;
  };
  const prefsFile = path.join(dataDir, 'prefs.json');
  const prefs = () => readJson(prefsFile, {});
  const playFile = path.join(dataDir, 'playtime.json');
  const play = readJson(playFile, {});
  const shop = new Shop({ dataDir, fetch: io.fetch, offline, now, sleep: io.sleep });
  const manifest = new lud.Manifest({ dataDir, fetch: io.fetch, offline, now });
  const store = new SaveStore({ dir: path.join(dataDir, 'saves'), now, keep: settings().keep });
  const st = { install: null, installKey: null, lib: null, scanAt: 0, run: { running: false, appId: 0 }, drives: [], driveCache: {}, leftovers: {}, slowAt: 0, value: null, error: null, session: null, lastBackup: {}, saveInfo: new Map() };
  let ownEvent = false;
  try { if (host.notifications && typeof host.notifications.register === 'function') { host.notifications.register('deals', { de: 'Angebote auf deiner Steam-Merkliste', en: 'Deals on your Steam watchlist' }, { on: true }); ownEvent = true; } } catch { /* ältere Hostwerk-Version */ }

  const broadcast = (extra = {}) => { try { host.broadcast({ type: 'steam', ...extra }); } catch { /* egal */ } };

  /* ---------- Bibliothek ---------- */
  async function scan({ force = false } = {}) {
    if (!force && st.lib && now() - st.scanAt < SCAN_AGE) return st.lib;
    const s = settings();
    const key = `${s.steamPath}`;
    if (!st.install || st.installKey !== key || force) {
      st.install = io.find ? await io.find({ custom: s.steamPath }) : await locate.findSteam({ custom: s.steamPath, platform });
      st.installKey = key;
    }
    if (!st.install) { st.lib = null; st.scanAt = now(); return null; }
    try {
      const lib = io.scan ? io.scan(st.install.root, { user: prefs().user }) : L.scanLibrary(st.install.root, { user: prefs().user });
      const before = st.lib ? sig(st.lib) : null;
      st.lib = lib;
      st.error = null;
      // Spielzeit buchen (Konto gewechselt → neu beginnen)
      const totals = {};
      for (const [id, v] of Object.entries(lib.playAll || {})) if (v.playtime) totals[id] = v.playtime;
      if (stats.record(play, totals, { now: now(), user: lib.user }) > 0 || !play.last) writeJson(playFile, play);
      else if (play.user !== lib.user) writeJson(playFile, play);
      if (before !== null && before !== sig(lib)) broadcast();
    } catch (e) { st.error = e.message; }
    st.scanAt = now();
    return st.lib;
  }
  const sig = (lib) => lib.games.map((g) => `${g.appid}:${g.flags}:${g.download ? g.download.pct : ''}:${g.playtime}`).join(',');

  /** Laufwerke und Reste (teuer – im langsamen Takt oder auf Knopfdruck) */
  async function measure() {
    const lib = st.lib;
    if (!lib) return;
    const paths = lib.libraries.filter((x) => x.online).map((x) => x.path);
    st.drives = io.describe ? await io.describe(paths) : await drives.describe(paths, { platform, cache: st.driveCache, now });
    const installed = new Set(lib.games.map((g) => String(g.appid)));
    const left = { workshop: {}, shader: {}, compat: {}, downloading: {} };
    const where = { workshop: ['workshop', 'content'], shader: ['shadercache'], compat: ['compatdata'], downloading: ['downloading'] };
    for (const l of lib.libraries.filter((x) => x.online)) {
      for (const [what, rel] of Object.entries(where)) {
        const base = path.join(l.path, 'steamapps', ...rel);
        let ids = [];
        try { ids = fs.readdirSync(base).filter((d) => /^\d+$/.test(d) && !installed.has(d) && d !== '0'); } catch { continue; }
        for (const id of ids.slice(0, 200)) {
          const dir = path.join(base, id);
          const bytes = drives.dirSize(dir, { max: 50000 });
          if (bytes > 0) left[what][id] = { bytes: (left[what][id] ? left[what][id].bytes : 0) + bytes, dir };
        }
      }
    }
    st.leftovers = left;
  }

  function slimGame(g, matches) {
    const d = shop.details(g.appid);
    const p = shop.load().prices[g.appid];
    const drive = st.drives.find((x) => x.paths.includes(g.library));
    const m = matches.get(g.appid);
    return {
      appid: g.appid, name: g.name, size: g.sizeOnDisk, library: g.library, drive: drive ? drive.label : null, media: drive ? drive.media : null,
      lastPlayed: g.lastPlayed, playtime: g.playtime, playtime2wks: g.playtime2wks, lastUpdated: g.lastUpdated, buildid: g.buildid,
      installed: g.state.installed, updatePending: g.updatePending, busy: g.state.busy, paused: g.state.paused, broken: g.state.broken,
      download: g.download, scheduledUpdate: g.scheduledUpdate, autoUpdate: g.autoUpdate, tool: g.tool,
      running: st.run.appId === g.appid,
      genres: d && d.genres ? d.genres : [], price: p && !p.free && !p.unavailable ? { final: p.final, initial: p.initial, discount: p.discount, currency: p.currency, formatted: p.formatted } : null,
      server: m ? { tool: m.tool, servers: m.servers } : null,
      lastBackup: st.lastBackup[g.appid] || null,
    };
  }

  function lastBackups() {
    const map = {};
    for (const s of store.list()) if (!map[s.appid] || map[s.appid] < s.t) map[s.appid] = s.t;
    st.lastBackup = map;
  }

  async function view() {
    const lib = await scan();
    const s = settings();
    const games = servers.gamesApi(io.games !== undefined ? { games: io.games } : ctx);
    if (!lib) return { found: false, platform, error: st.error, run: st.run, serversAvailable: !!games, settings: s };
    const matches = servers.match(lib, games);
    const list = lib.games.map((g) => slimGame(g, matches));
    const real = list.filter((g) => !g.tool);
    return {
      found: true, platform, install: { root: st.install.root, source: st.install.source }, run: st.run, user: lib.user, users: lib.users,
      libraries: lib.libraries.map((l) => ({ path: l.path, label: l.label, online: l.online, count: l.count, bytes: l.bytes })),
      drives: st.drives,
      games: list,
      totals: {
        games: real.length, bytes: real.reduce((a, g) => a + (g.size || 0), 0), updates: real.filter((g) => g.updatePending && !g.busy).length,
        downloads: list.filter((g) => g.busy || g.download).length, playtime: real.reduce((a, g) => a + (g.playtime || 0), 0),
        servers: real.filter((g) => g.server).length,
      },
      value: st.value, serversAvailable: !!games, offline: offline(), scanAt: st.scanAt, settings: { country: s.country, autoBackup: s.autoBackup },
    };
  }

  /* ---------- Spielstände ---------- */
  function contextFor(g) {
    const lib = st.lib;
    const accounts = lib ? lib.users.filter((u) => u.hasData).map((u) => u.accountId) : [];
    const pfx = path.join(g.library, 'steamapps', 'compatdata', String(g.appid), 'pfx', 'drive_c');
    return { platform, env: process.env, root: g.library, installDir: g.installdir, appid: g.appid, accounts: lib && lib.user ? [lib.user] : accounts, prefix: platform === 'linux' && fs.existsSync(pfx) ? pfx : null };
  }
  async function saveInfoFor(g, entry, { fresh = false } = {}) {
    const hit = st.saveInfo.get(g.appid);
    if (!fresh && hit && now() - hit.at < 5 * 60e3) return hit;
    const { patterns, registry, cloud } = lud.savePatterns(entry, contextFor(g), { includeConfig: settings().includeConfig });
    const files = [];
    const seen = new Set();
    for (const p of patterns) for (const f of lud.resolveFiles(p.pattern)) { const k = platform === 'win32' ? f.file.toLowerCase() : f.file; if (!seen.has(k)) { seen.add(k); files.push(f); } }
    const info = { at: now(), patterns, registry, cloud, files };
    st.saveInfo.set(g.appid, info);
    return info;
  }
  async function entries() {
    const lib = await scan();
    if (!lib) return { lib: null, map: new Map() };
    const ids = lib.games.filter((g) => !g.tool).map((g) => g.appid);
    return { lib, map: await manifest.lookup(ids) };
  }
  async function savesView() {
    const { lib, map } = await entries();
    lastBackups();
    const list = [];
    if (lib) {
      const counts = {};
      for (const s of store.list()) counts[s.appid] = (counts[s.appid] || 0) + 1;
      for (const g of lib.games.filter((x) => !x.tool)) {
        const e = map.get(g.appid);
        let info = null;
        if (e) info = await saveInfoFor(g, e.entry);
        list.push({
          appid: g.appid, name: g.name, known: !!e, cloud: info ? info.cloud : null, places: info ? info.patterns.length : 0, registry: info ? info.registry.length : 0,
          files: info ? info.files.length : 0, bytes: info ? info.files.reduce((a, f) => a + f.size, 0) : 0, backups: counts[g.appid] || 0, lastBackup: st.lastBackup[g.appid] || null,
          lastPlayed: g.lastPlayed, running: st.run.appId === g.appid,
        });
      }
    }
    const usage = [...new Set(store.list().map((s) => s.appid))].reduce((a, id) => a + store.usage(id), 0);
    return { manifest: manifest.state(), games: list, usage, autoBackup: settings().autoBackup, offline: offline() };
  }
  async function saveDetail(appid) {
    const { lib, map } = await entries();
    const g = lib && lib.games.find((x) => x.appid === Number(appid));
    if (!g) throw host.error(404, 'Game not found');
    const e = map.get(g.appid);
    const info = e ? await saveInfoFor(g, e.entry, { fresh: true }) : null;
    return {
      appid: g.appid, name: g.name, known: !!e, cloud: info ? info.cloud : null,
      places: info ? info.patterns.map((p) => ({ pattern: p.pattern, proton: p.proton, files: info.files.filter((f) => f.file.toLowerCase().startsWith(p.pattern.split(/[*?[]/)[0].toLowerCase())).length })) : [],
      registry: info ? info.registry : [],
      files: info ? info.files.length : 0, bytes: info ? info.files.reduce((a, f) => a + f.size, 0) : 0,
      snapshots: store.list(g.appid),
    };
  }
  async function backupGame(appid, reason = 'manual') {
    const { lib, map } = await entries();
    const g = lib && lib.games.find((x) => x.appid === Number(appid));
    if (!g) throw host.error(404, 'Game not found');
    const e = map.get(g.appid);
    if (!e) throw host.error(404, 'Hostwerk does not know where this game keeps its saves.');
    store.keep = settings().keep;
    const info = await saveInfoFor(g, e.entry, { fresh: true });
    const r = store.create({ appid: g.appid, name: g.name, files: info.files, reason });
    lastBackups();
    if (r.created) broadcast({ saves: g.appid });
    return r;
  }
  function restore(id) {
    const { appid } = store.read(id);
    const g = st.lib && st.lib.games.find((x) => x.appid === appid);
    return store.restore(id, {
      isRunning: (a) => st.run.appId === a,
      current: () => { const info = g && st.saveInfo.get(appid); return info ? info.files : []; },
    });
  }

  /** Quelle für Hostwerks Sicherungs-Zentrale (SDK 2.10: host.backups.register) */
  const backupSource = {
    label: { de: 'Spielstände (Steam)', en: 'Game saves (Steam)' },
    list: () => store.list().map((s) => ({ id: s.id, label: `${s.name} – ${s.reason === 'session' ? T('after playing') : s.reason === 'before-restore' ? T('before restoring') : T('manual')}`, t: s.t, size: s.bytes, auto: s.reason !== 'manual', svc: String(s.appid), svcName: s.name, href: '#/ext/steam/saves' })),
    restore: async (id) => { await scan(); const g = st.lib && st.lib.games.find((x) => x.appid === store.read(id).appid); if (g) { const { map } = await entries(); const e = map.get(g.appid); if (e) await saveInfoFor(g, e.entry, { fresh: true }); } return restore(id); },
    remove: (id) => store.remove(id),
    offsite: async ({ dir, job }) => {
      const out = [];
      const newest = new Map();
      for (const s of store.list()) if (!newest.has(s.appid)) newest.set(s.appid, s);
      for (const s of newest.values()) {
        const tmp = path.join(dir, `steam-saves-${s.appid}`);
        try {
          store.materialize(s.id, tmp);
          const util = host.core('util');
          if (util && typeof util.zipDir === 'function') { await util.zipDir(tmp, `${tmp}.zip`); fs.rmSync(tmp, { recursive: true, force: true }); out.push(`${tmp}.zip`); } else out.push(tmp);
        } catch (e) { if (job && job.log) job.log(`${s.name}: ${e.message}`); }
      }
      return out;
    },
  };

  /* ---------- Steam-Zustand und Sitzungen ---------- */
  async function tick() {
    if (!st.install) return;
    let r;
    try { r = io.runState ? await io.runState() : await locate.runState({ platform }); } catch { return; }
    const prev = st.run;
    st.run = r;
    if (prev.appId !== r.appId) {
      if (prev.appId) {
        const ended = prev.appId;
        const start = st.session && st.session.appid === ended ? st.session.start : null;
        if (start) { stats.session(play, { appid: ended, start, end: now() }); writeJson(playFile, play); }
        st.session = null;
        // Etwas warten, bis das Spiel seine Dateien geschrieben hat und Steam die Spielzeit
        setTimeout(() => afterSession(ended).catch(() => {}), io.afterDelay != null ? io.afterDelay : 15000);
      }
      if (r.appId) st.session = { appid: r.appId, start: now() };
      broadcast({ run: r });
    } else if (prev.running !== r.running) broadcast({ run: r });
  }
  async function afterSession(appid) {
    await scan({ force: true });
    if (!settings().autoBackup) return null;
    try { return await backupGame(appid, 'session'); } catch { return null; }
  }

  /* ---------- langsamer Takt ---------- */
  async function slow({ force = false } = {}) {
    if (!force && now() - st.slowAt < SLOW_EVERY) return;
    st.slowAt = now();
    const lib = await scan({ force: true });
    if (!lib) return;
    try { await measure(); } catch { /* weiter */ }
    try { await manifest.refresh(); } catch { /* weiter */ }
    const s = settings();
    const ids = lib.games.filter((g) => !g.tool).map((g) => g.appid);
    try {
      await shop.refreshPrices([...shop.watchlist().map((w) => w.appid), ...ids], { cc: s.country });
      st.value = libraryValue(ids, shop.load().prices);
      const alerts = shop.alerts();
      if (alerts.length && s.notifyDeals) notifyDeals(alerts);
      await shop.refreshDetails([...ids, ...shop.watchlist().map((w) => w.appid)], { lang: host.lang && host.lang() === 'de' ? 'german' : 'english' });
    } catch { /* weiter */ }
    broadcast();
  }
  function notifyDeals(alerts) {
    const title = alerts.length === 1 ? T('{name} is on sale', { name: alerts[0].name }) : T('{n} games on your watchlist are on sale', { n: alerts.length });
    const text = alerts.slice(0, 6).map((a) => `• ${a.name}: ${a.formatted || ''}${a.discount ? ` (−${a.discount} %)` : ''}${a.why === 'lowest' ? ` – ${T('lowest price so far')}` : a.why === 'target' ? ` – ${T('your target price')}` : ''}`).join('\n');
    try { if (ownEvent) host.notifications.notify('deals', { title, text, kind: 'info', url: '/ext/steam/deals' }); } catch { /* optional */ }
  }

  /* ---------- Bilder ---------- */
  async function art(appid, kind) {
    const id = Number(appid);
    if (!Number.isInteger(id) || id <= 0) return null;
    const k = CDN_FILE[kind] ? kind : 'portrait';
    if (st.install) {
      const local = L.localArt(st.install.root, id);
      if (local[k]) return { file: local[k], type: /\.png$/i.test(local[k]) ? 'image/png' : 'image/jpeg' };
    }
    const cache = io.imageCache !== undefined ? io.imageCache : ctx.imageCache;
    if (!cache || typeof cache.get !== 'function' || offline()) return null;
    for (const h of STEAM_CDN) {
      const hit = await cache.get(`${h}/${id}/${CDN_FILE[k]}`).catch(() => null);
      if (hit) return hit;
    }
    return null;
  }

  /* ---------- Ordner ---------- */
  function folderFor(kind, id) {
    const lib = st.lib;
    if (!lib || !st.install) return null;
    if (kind === 'game') { const g = lib.games.find((x) => x.appid === Number(id)); return g && g.dir && fs.existsSync(g.dir) ? g.dir : null; }
    if (kind === 'library') { const l = lib.libraries.find((x) => x.path === id); return l ? path.join(l.path, 'steamapps') : null; }
    if (kind === 'leftover') { const [what, appid] = String(id).split(':'); const e = st.leftovers[what] && st.leftovers[what][appid]; return e ? e.dir : null; }
    if (kind === 'screenshots') { const dir = path.join(st.install.root, 'userdata', String(lib.user || ''), '760', 'remote', String(Number(id)), 'screenshots'); return lib.user && fs.existsSync(dir) ? dir : null; }
    if (kind === 'saves') { const info = st.saveInfo.get(Number(id)); const f = info && info.files[0]; return f ? path.dirname(f.file) : null; }
    return null;
  }

  return {
    scan, measure, view, slow, tick, art, savesView, saveDetail, backupGame, restore, backupSource, afterSession, folderFor, settings, prefsFile,
    doctor: async () => { await scan(); const s = settings(); return { ...diagnose({ lib: st.lib, drives: st.drives, leftovers: st.leftovers, now: now(), opts: { dormantDays: s.dormantDays } }), measured: st.drives.length > 0 }; },
    stats: async () => { await scan(); const names = {}; for (const g of (st.lib ? st.lib.games : [])) names[g.appid] = g.name; return { ...stats.summary(play, { now: now() }), names, total: st.lib ? st.lib.games.filter((g) => !g.tool).reduce((a, g) => a + (g.playtime || 0), 0) : 0 }; },
    picks: async (mood, seed) => {
      const lib = await scan();
      const games = servers.gamesApi(io.games !== undefined ? { games: io.games } : ctx);
      const m = servers.match(lib, games);
      return suggest({ games: lib ? lib.games : [], details: (id) => shop.details(id), mood, seed, now: now(), servers: new Set(m.keys()) });
    },
    screenshots: async () => {
      const lib = await scan();
      if (!lib || !lib.user) return { items: [], names: {} };
      const names = {};
      for (const g of lib.games) names[g.appid] = g.name;
      for (const w of shop.watchlist()) if (!names[w.appid]) names[w.appid] = w.name;
      return { items: L.listScreenshots(st.install.root, lib.user), names };
    },
    screenshotFile: (appid, file, thumb) => (st.install && st.lib && st.lib.user ? L.screenshotPath(st.install.root, st.lib.user, appid, file, thumb) : null),
    setUser: (accountId) => { const p = prefs(); p.user = /^\d+$/.test(String(accountId || '')) ? String(accountId) : null; writeJson(prefsFile, p); st.scanAt = 0; st.saveInfo.clear(); },
    shop, manifest, store, state: st, play,
    shopView: () => ({ ...shop.view(), country: settings().country, offline: offline(), notify: settings().notifyDeals }),
    steamIdOfUser: () => {
      if (!st.install || !st.lib || !st.lib.user) return null;
      const u = L.parseLoginUsers(fs.existsSync(path.join(st.install.root, 'config', 'loginusers.vdf')) ? fs.readFileSync(path.join(st.install.root, 'config', 'loginusers.vdf'), 'utf8') : '');
      const hit = u.find((x) => x.accountId === st.lib.user);
      return hit ? hit.steamId : null;
    },
    open: (target) => (io.open ? io.open(target) : links.open(target, { platform })),
  };
}

module.exports = { createService, DEFAULTS, STEAM_CDN };
