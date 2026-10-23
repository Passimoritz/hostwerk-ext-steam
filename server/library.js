'use strict';
/*
 * Die Steam-Bibliothek lesen – nur Dateien, die Steam selbst schreibt, ohne Anmeldung und ohne Netz:
 *
 *   steamapps/libraryfolders.vdf        Bibliotheksordner (alle Laufwerke) – neues und altes Format
 *   <bibliothek>/steamapps/appmanifest_<id>.acf   je installiertes Spiel: Name, Ordner, Größe, Build, Zustand, Download
 *   config/loginusers.vdf + userdata/<konto>/config/localconfig.vdf   Spielzeit (Minuten) und „zuletzt gespielt“ je Konto
 *   appcache/librarycache/<id>[/<hash>]/library_600x900.jpg …        Steams eigene Bilder (alt: <id>_library_600x900.jpg)
 *   userdata/<konto>/760/remote/<id>/screenshots                      Screenshots
 *
 * Werkzeuge ohne Spiel (Proton, Steam Linux Runtime, Steamworks Common Redistributables) werden als „tool“ markiert und
 * zählen nicht als Spiel. Kontonamen verlassen den Rechner nie; die Oberfläche zeigt nur den Anzeigenamen zur Auswahl.
 */
const fs = require('fs');
const path = require('path');
const VDF = require('./vdf');

const STEAM64_BASE = 76561197960265728n;

/** StateFlags eines appmanifest (EAppState) → lesbare Zustände */
const STATE = {
  updateRequired: 2, fullyInstalled: 4, filesMissing: 32, running: 64, filesCorrupt: 128, updateRunning: 256, updatePaused: 512,
  updateStarted: 1024, uninstalling: 2048, validating: 131072, downloading: 1048576, staging: 2097152, committing: 4194304,
};
function decodeState(flags) {
  const f = Number(flags) || 0;
  const has = (k) => (f & STATE[k]) !== 0;
  const busy = has('updateRunning') || has('updateStarted') || has('downloading') || has('staging') || has('committing') || has('validating');
  return {
    installed: has('fullyInstalled'),
    updateRequired: has('updateRequired'),
    busy,
    paused: has('updatePaused'),
    broken: has('filesMissing') || has('filesCorrupt'),
    uninstalling: has('uninstalling'),
    validating: has('validating'),
  };
}

/** Programme, die Steam als „App“ führt, die aber keine Spiele sind (Laufzeiten, Proton, Redistributables). */
const TOOL_IDS = new Set([228980, 1070560, 1391110, 1628350, 1493710, 2180100, 1826330, 1887720, 2348590, 2805730, 3658110, 961940, 1420170, 1580130, 1245040, 858280, 930400, 1054830, 1113280, 1161040, 250820]);
const isTool = (id, name) => TOOL_IDS.has(Number(id)) || /^(proton( |$)|steam linux runtime|steamworks common redistributables|steamvr$)/i.test(String(name || ''));

/** libraryfolders.vdf → [{ path, label, apps: { appid: bytes } }] (neues Format mit "path", altes mit "1" "D:\\SteamLibrary"). */
function parseLibraryFolders(text, root) {
  const doc = VDF.parse(text);
  const lf = VDF.get(doc, 'libraryfolders') || VDF.get(doc, 'LibraryFolders') || {};
  const out = [];
  const seen = new Set();
  const key = (p) => String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
  const add = (p, label = '', apps = {}) => {
    if (!p) return;
    const k = key(p);
    if (seen.has(k)) {
      // Steam-Ordner selbst steht oft auch in der Liste – dann nur Bezeichnung und Größen nachtragen
      const had = out.find((x) => key(x.path) === k);
      if (had && !Object.keys(had.apps).length) had.apps = apps;
      if (had && !had.label) had.label = label;
      return;
    }
    seen.add(k);
    out.push({ path: p, label, apps });
  };
  if (root) add(root);
  for (const [k, v] of Object.entries(lf)) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === 'string') add(v);
    else if (v && typeof v === 'object') {
      const apps = {};
      for (const [id, size] of Object.entries(VDF.get(v, 'apps') || {})) apps[id] = VDF.num(size);
      add(VDF.get(v, 'path'), VDF.get(v, 'label') || '', apps);
    }
  }
  return out;
}

/** appmanifest_<id>.acf → Eintrag (oder null) */
function parseAppManifest(text) {
  const doc = VDF.parse(text);
  const a = VDF.get(doc, 'AppState');
  if (!a || typeof a !== 'object') return null;
  const appid = VDF.num(VDF.get(a, 'appid'), 0);
  if (!appid) return null;
  const flags = VDF.num(VDF.get(a, 'StateFlags'), 0);
  const toDl = VDF.num(VDF.get(a, 'BytesToDownload'), 0);
  const dl = VDF.num(VDF.get(a, 'BytesDownloaded'), 0);
  const toStage = VDF.num(VDF.get(a, 'BytesToStage'), 0);
  const staged = VDF.num(VDF.get(a, 'BytesStaged'), 0);
  const state = decodeState(flags);
  const buildid = String(VDF.get(a, 'buildid') || '');
  const target = String(VDF.get(a, 'TargetBuildID') || '');
  // Ein Update „steht an“, wenn Steam es selbst so markiert oder eine neuere Build-ID schon bekannt ist
  const updatePending = state.updateRequired || (!!target && target !== '0' && !!buildid && target !== buildid);
  let download = null;
  if (state.busy || state.paused || (toDl > 0 && dl > 0 && dl < toDl)) {
    const total = toDl + toStage;
    const done = dl + staged;
    download = { bytesTotal: toDl, bytesDone: dl, pct: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null, paused: state.paused && !state.busy };
  }
  return {
    appid,
    name: String(VDF.get(a, 'name') || `App ${appid}`),
    installdir: String(VDF.get(a, 'installdir') || ''),
    flags,
    state,
    sizeOnDisk: VDF.num(VDF.get(a, 'SizeOnDisk'), 0),
    lastUpdated: VDF.num(VDF.get(a, 'LastUpdated'), 0) * 1000 || null,
    lastPlayedAcf: VDF.num(VDF.get(a, 'LastPlayed'), 0) * 1000 || null,
    buildid,
    updatePending,
    bytesToDownload: toDl,
    autoUpdate: VDF.num(VDF.get(a, 'AutoUpdateBehavior'), 0), // 0 = immer, 1 = nur beim Start, 2 = hohe Priorität
    scheduledUpdate: VDF.num(VDF.get(a, 'ScheduledAutoUpdate'), 0) * 1000 || null,
    download,
  };
}

/** loginusers.vdf → [{ accountId, steamId, persona, mostRecent }] (Kontoname bleibt außen vor) */
function parseLoginUsers(text) {
  const doc = VDF.parse(text);
  const users = VDF.get(doc, 'users') || {};
  const out = [];
  for (const [sid, u] of Object.entries(users)) {
    if (!/^\d{17}$/.test(sid) || !u || typeof u !== 'object') continue;
    let accountId = null;
    try { accountId = String(BigInt(sid) - STEAM64_BASE); } catch { continue; }
    out.push({ accountId, steamId: sid, persona: String(VDF.get(u, 'PersonaName') || ''), mostRecent: VDF.get(u, 'MostRecent') === '1', timestamp: VDF.num(VDF.get(u, 'Timestamp'), 0) * 1000 || null });
  }
  return out;
}

/** localconfig.vdf → { appid: { playtime (Minuten), lastPlayed (ms), playtime2wks } } */
function parseLocalConfig(text) {
  const doc = VDF.parse(text);
  const apps = VDF.get(doc, 'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps') || {};
  const out = {};
  for (const [id, v] of Object.entries(apps)) {
    if (!/^\d+$/.test(id) || !v || typeof v !== 'object') continue;
    const playtime = VDF.num(VDF.get(v, 'Playtime'), 0);
    const lastPlayed = VDF.num(VDF.get(v, 'LastPlayed'), 0) * 1000 || null;
    if (!playtime && !lastPlayed) continue;
    out[id] = { playtime, lastPlayed, playtime2wks: VDF.num(VDF.get(v, 'Playtime2wks'), 0) };
  }
  return out;
}

const readText = (fsx, f) => { try { return fsx.readFileSync(f, 'utf8'); } catch { return null; } };

/** Steams eigene Bilder eines Spiels (lokal, ohne Netz): { portrait, header, hero, logo } – absolute Pfade oder null */
function localArt(root, appid, fsx = fs) {
  const base = path.join(root, 'appcache', 'librarycache');
  const want = { portrait: ['library_600x900.jpg', 'library_capsule.jpg', 'library_600x900_2x.jpg'], header: ['library_header.jpg', 'header.jpg'], hero: ['library_hero.jpg'], logo: ['logo.png'] };
  const found = {};
  const dir = path.join(base, String(appid));
  const files = [];
  try {
    for (const e of fsx.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) files.push(path.join(dir, e.name));
      else if (e.isDirectory()) { try { for (const f of fsx.readdirSync(path.join(dir, e.name))) files.push(path.join(dir, e.name, f)); } catch { /* weiter */ } }
    }
  } catch { /* altes Format unten */ }
  for (const [k, names] of Object.entries(want)) {
    let hit = null;
    for (const nm of names) {
      hit = files.find((f) => path.basename(f) === nm) || null;
      if (!hit) { const old = path.join(base, `${appid}_${nm}`); try { if (fsx.statSync(old).isFile()) hit = old; } catch { /* fehlt */ } }
      if (hit) break;
    }
    found[k] = hit;
  }
  return found;
}

/**
 * Ganze Bibliothek lesen → { root, libraries, games, users, user }
 * opts: { fs, user (accountId, sonst „zuletzt angemeldet“), now }
 */
function scanLibrary(root, opts = {}) {
  const fsx = opts.fs || fs;
  const libText = readText(fsx, path.join(root, 'steamapps', 'libraryfolders.vdf')) || readText(fsx, path.join(root, 'config', 'libraryfolders.vdf')) || '';
  const libraries = parseLibraryFolders(libText, root);
  const games = [];
  const seen = new Set();
  for (const lib of libraries) {
    const sa = path.join(lib.path, 'steamapps');
    let files = [];
    try { files = fsx.readdirSync(sa).filter((f) => /^appmanifest_\d+\.acf$/i.test(f)); lib.online = true; } catch { lib.online = false; }
    lib.count = 0;
    lib.bytes = 0;
    for (const f of files) {
      const m = parseAppManifest(readText(fsx, path.join(sa, f)) || '');
      if (!m || seen.has(m.appid)) continue;
      seen.add(m.appid);
      m.library = lib.path;
      m.dir = m.installdir ? path.join(sa, 'common', m.installdir) : null;
      m.tool = isTool(m.appid, m.name);
      if (!m.sizeOnDisk && lib.apps && lib.apps[m.appid]) m.sizeOnDisk = lib.apps[m.appid];
      if (!m.tool) { lib.count++; lib.bytes += m.sizeOnDisk; }
      games.push(m);
    }
  }
  // Konten und Spielzeit
  const users = parseLoginUsers(readText(fsx, path.join(root, 'config', 'loginusers.vdf')) || '');
  let udirs = [];
  try { udirs = fsx.readdirSync(path.join(root, 'userdata')).filter((d) => /^\d+$/.test(d) && d !== '0'); } catch { /* keine */ }
  for (const d of udirs) if (!users.some((u) => u.accountId === d)) users.push({ accountId: d, steamId: null, persona: '', mostRecent: false, timestamp: null });
  for (const u of users) u.hasData = udirs.includes(u.accountId);
  const pick = (opts.user && users.find((u) => u.accountId === String(opts.user))) || users.find((u) => u.mostRecent && u.hasData) || users.filter((u) => u.hasData).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
  const play = pick ? parseLocalConfig(readText(fsx, path.join(root, 'userdata', pick.accountId, 'config', 'localconfig.vdf')) || '') : {};
  for (const g of games) {
    const p = play[g.appid] || {};
    g.playtime = p.playtime || 0;
    g.playtime2wks = p.playtime2wks || 0;
    g.lastPlayed = Math.max(p.lastPlayed || 0, g.lastPlayedAcf || 0) || null;
  }
  return { root, libraries, games, users: users.map(({ accountId, persona, mostRecent, hasData }) => ({ accountId, persona, mostRecent, hasData })), user: pick ? pick.accountId : null, playAll: play };
}

/** Screenshots eines Kontos: [{ appid, file, thumb, t, size }] neueste zuerst, höchstens limit */
function listScreenshots(root, accountId, { fs: fsx = fs, limit = 300 } = {}) {
  if (!/^\d+$/.test(String(accountId || ''))) return [];
  const base = path.join(root, 'userdata', String(accountId), '760', 'remote');
  const out = [];
  let apps = [];
  try { apps = fsx.readdirSync(base).filter((d) => /^\d+$/.test(d)); } catch { return []; }
  for (const a of apps) {
    const dir = path.join(base, a, 'screenshots');
    let files = [];
    try { files = fsx.readdirSync(dir).filter((f) => /\.(jpe?g|png)$/i.test(f)); } catch { continue; }
    for (const f of files) {
      let st = null;
      try { st = fsx.statSync(path.join(dir, f)); } catch { continue; }
      const thumb = path.join(dir, 'thumbnails', f);
      out.push({ appid: Number(a), file: f, t: st.mtimeMs, size: st.size, hasThumb: fsx.existsSync(thumb) });
    }
  }
  return out.sort((x, y) => y.t - x.t).slice(0, limit);
}

/** Pfad eines Screenshots – nur Dateinamen aus dem Screenshot-Ordner, nie ein freier Pfad */
function screenshotPath(root, accountId, appid, file, thumb = false) {
  if (!/^\d+$/.test(String(accountId)) || !/^\d+$/.test(String(appid)) || !/^[\w .()-]{1,120}\.(jpe?g|png)$/i.test(String(file)) || path.basename(file) !== file) return null;
  return path.join(root, 'userdata', String(accountId), '760', 'remote', String(appid), 'screenshots', ...(thumb ? ['thumbnails'] : []), file);
}

module.exports = { scanLibrary, parseLibraryFolders, parseAppManifest, parseLoginUsers, parseLocalConfig, decodeState, localArt, listScreenshots, screenshotPath, isTool, STATE };
