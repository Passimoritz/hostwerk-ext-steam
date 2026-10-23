'use strict';
/*
 * Wo liegen die Spielstände? – aus dem offenen Ludusavi-Verzeichnis (github.com/mtkennerly/ludusavi-manifest, MIT),
 * das die Gemeinschaft aus dem PCGamingWiki täglich neu erzeugt. Hostwerk pflegt KEINE eigene Spieleliste.
 *
 *   Laden:   höchstens einmal am Tag mit If-None-Match (meist 304, null Bytes), sonst ~17 MB als Datenstrom – gepackt
 *            (~2 MB) im Datenordner abgelegt. Offline-Modus oder Netzfehler: der letzte Stand bleibt.
 *   Suchen:  die gepackte Datei zeilenweise lesen, nur Einträge der installierten Spiele (Steam-ID) wirklich parsen.
 *   Auflösen: Platzhalter (<base>, <winAppData>, <xdgData>, <storeUserId> …) → echte Pfade; unter Linux auch im
 *            Proton-Präfix (steamapps/compatdata/<id>/pfx), wenn das Spiel nur für Windows eingetragen ist.
 *   Muster:  * ? und ** in Pfaden – Ordner zählen mit allen Dateien darin.
 * Registry-Einträge (manche ältere Spiele) werden genannt, aber nicht gesichert.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const YAML = require('./yaml');

const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const FILE = 'ludusavi-manifest.yaml.gz';
const META = 'ludusavi-meta.json';
const CHECK_EVERY = 24 * 3600e3;
const MAX_BYTES = 80 * 1024 * 1024;

class Manifest {
  /** { dataDir, fetch, offline: () => bool, now } */
  constructor({ dataDir, fetch = (...a) => globalThis.fetch(...a), offline = () => false, now = () => Date.now() } = {}) {
    Object.assign(this, { dataDir, fetch, offline, now });
    this.memo = null; // { key, map }
  }
  get file() { return path.join(this.dataDir, FILE); }
  meta() { try { return JSON.parse(fs.readFileSync(path.join(this.dataDir, META), 'utf8')); } catch { return {}; } }
  saveMeta(m) { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(path.join(this.dataDir, META), JSON.stringify(m)); }
  state() { const m = this.meta(); return { have: fs.existsSync(this.file), checkedAt: m.checkedAt || null, changedAt: m.changedAt || null, bytes: m.bytes || null, error: m.error || null }; }

  /** Neu laden, wenn fällig (force: sofort). Liefert { changed, skipped, error } */
  async refresh({ force = false } = {}) {
    const m = this.meta();
    if (!force && m.checkedAt && this.now() - m.checkedAt < CHECK_EVERY && fs.existsSync(this.file)) return { skipped: 'fresh' };
    if (this.offline()) return { skipped: 'offline' };
    const headers = { 'User-Agent': 'Hostwerk Steam extension', Accept: 'text/plain' };
    if (m.etag && fs.existsSync(this.file)) headers['If-None-Match'] = m.etag;
    let res;
    try { res = await this.fetch(MANIFEST_URL, { headers, signal: AbortSignal.timeout(120000) }); } catch (e) { this.saveMeta({ ...m, checkedAt: this.now(), error: e.message }); return { error: e.message }; }
    if (res.status === 304) { this.saveMeta({ ...m, checkedAt: this.now(), error: null }); return { changed: false }; }
    if (!res.ok) { const error = `HTTP ${res.status}`; this.saveMeta({ ...m, checkedAt: this.now(), error }); return { error }; }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.part`;
    let bytes = 0;
    try {
      const src = res.body && typeof res.body.getReader === 'function' ? Readable.fromWeb(res.body) : Readable.from([Buffer.from(await res.text())]);
      src.on('data', (c) => { bytes += c.length; if (bytes > MAX_BYTES) src.destroy(new Error('manifest too large')); });
      await pipeline(src, zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* egal */ }
      this.saveMeta({ ...m, checkedAt: this.now(), error: e.message });
      return { error: e.message };
    }
    this.memo = null;
    this.saveMeta({ etag: res.headers.get('etag') || null, checkedAt: this.now(), changedAt: this.now(), bytes, error: null });
    return { changed: true };
  }

  /** Einträge zu Steam-IDs → Map(appid → { name, entry }) – aus der gepackten Datei, gemerkt je Stand und ID-Menge */
  async lookup(ids) {
    const want = new Set([...ids].map(Number).filter(Boolean));
    let mtime = 0;
    try { mtime = fs.statSync(this.file).mtimeMs; } catch { return new Map(); }
    const key = `${mtime}|${[...want].sort((a, b) => a - b).join(',')}`;
    if (this.memo && this.memo.key === key) return this.memo.map;
    const map = await scanStream(fs.createReadStream(this.file).pipe(zlib.createGunzip()), want);
    this.memo = { key, map };
    return map;
  }
}

/** Datenstrom des Verzeichnisses → nur Einträge mit gesuchter Steam-ID parsen (Hauptschlüssel stehen ohne Einrückung). */
async function scanStream(stream, want) {
  const map = new Map();
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let block = [];
  const flush = () => {
    if (!block.length) return;
    const text = block.join('\n');
    block = [];
    const ids = [];
    const m = /\n {2}steam:\n {4}id: (\d+)/.exec(text);
    if (m) ids.push(Number(m[1]));
    const ex = /\n {4}steamExtra:\n((?: {6}- \d+\n?)+)/.exec(text);
    if (ex) for (const x of ex[1].match(/\d+/g) || []) ids.push(Number(x));
    const hit = ids.filter((id) => want.has(id));
    if (!hit.length) return;
    let doc = null;
    try { doc = YAML.parse(text); } catch { return; }
    if (!doc || typeof doc !== 'object') return;
    const name = Object.keys(doc)[0];
    for (const id of hit) if (!map.has(id) || ids[0] === id) map.set(id, { name, entry: doc[name] || {} });
  };
  for await (const line of rl) {
    if (line && line[0] !== ' ' && line[0] !== '#' && line !== '---') flush();
    if (line === '---') continue;
    block.push(line);
  }
  flush();
  return map;
}

/* ---------- Pfade auflösen ---------- */

const OS_NAME = { win32: 'windows', linux: 'linux', darwin: 'mac' };

/**
 * Basis-Ordner für die Platzhalter. Liefert je Platzhalter eine LISTE (z. B. Dokumente lokal und in OneDrive).
 * c = { platform, env, home, root (Bibliothek), installDir, appid, accounts: ['123'], osUser, prefix (Proton drive_c) }
 */
function placeholders(c, { proton = false } = {}) {
  const env = c.env || process.env;
  const home = c.home || os.homedir();
  const J = (...p) => p.join('/').replace(/\\/g, '/').replace(/\/+/g, '/');
  const v = {};
  const root = c.root ? J(c.root) : null;
  v['<root>'] = root ? [root] : [];
  v['<game>'] = c.installDir ? [c.installDir] : [];
  v['<base>'] = root && c.installDir ? [J(root, 'steamapps', 'common', c.installDir)] : [];
  v['<storeUserId>'] = c.accounts && c.accounts.length === 1 ? [c.accounts[0]] : ['*'];
  v['<storeGameId>'] = c.appid ? [String(c.appid)] : [];
  if (proton) {
    const pfx = c.prefix ? J(c.prefix) : null;
    const user = pfx ? J(pfx, 'users', 'steamuser') : null;
    v['<home>'] = user ? [user] : [];
    v['<osUserName>'] = ['steamuser'];
    v['<winAppData>'] = user ? [J(user, 'AppData', 'Roaming')] : [];
    v['<winLocalAppData>'] = user ? [J(user, 'AppData', 'Local')] : [];
    v['<winLocalAppDataLow>'] = user ? [J(user, 'AppData', 'LocalLow')] : [];
    v['<winDocuments>'] = user ? [J(user, 'Documents'), J(user, 'My Documents')] : [];
    v['<winPublic>'] = pfx ? [J(pfx, 'users', 'Public')] : [];
    v['<winProgramData>'] = pfx ? [J(pfx, 'ProgramData')] : [];
    v['<winDir>'] = pfx ? [J(pfx, 'windows')] : [];
    v['<xdgData>'] = [];
    v['<xdgConfig>'] = [];
    return v;
  }
  v['<home>'] = [J(home)];
  v['<osUserName>'] = [c.osUser || safeUser()];
  if (c.platform === 'win32') {
    v['<winAppData>'] = [J(env.APPDATA || `${home}/AppData/Roaming`)];
    v['<winLocalAppData>'] = [J(env.LOCALAPPDATA || `${home}/AppData/Local`)];
    v['<winLocalAppDataLow>'] = [J(home, 'AppData', 'LocalLow')];
    v['<winDocuments>'] = [J(home, 'Documents'), ...(env.OneDrive ? [J(env.OneDrive, 'Documents'), J(env.OneDrive, 'Dokumente')] : [])];
    v['<winPublic>'] = [J(env.PUBLIC || 'C:/Users/Public')];
    v['<winProgramData>'] = [J(env.ProgramData || 'C:/ProgramData')];
    v['<winDir>'] = [J(env.windir || env.SystemRoot || 'C:/Windows')];
    v['<xdgData>'] = [];
    v['<xdgConfig>'] = [];
  } else {
    for (const k of ['<winAppData>', '<winLocalAppData>', '<winLocalAppDataLow>', '<winDocuments>', '<winPublic>', '<winProgramData>', '<winDir>']) v[k] = [];
    v['<xdgData>'] = [J(env.XDG_DATA_HOME || `${home}/.local/share`)];
    v['<xdgConfig>'] = [J(env.XDG_CONFIG_HOME || `${home}/.config`)];
  }
  return v;
}
function safeUser() { try { return os.userInfo().username; } catch { return '*'; } }

/** Muster mit Platzhaltern → Liste konkreter Muster (leer, wenn ein Platzhalter hier nichts bedeutet) */
function expandPlaceholders(pattern, vars) {
  let outs = [String(pattern)];
  for (const [k, vals] of Object.entries(vars)) {
    if (!outs.some((o) => o.includes(k))) continue;
    if (!vals.length) return [];
    outs = outs.flatMap((o) => (o.includes(k) ? vals.map((v) => o.split(k).join(v)) : [o]));
  }
  if (outs.some((o) => /<[a-zA-Z]+>/.test(o))) return []; // unbekannter Platzhalter
  return [...new Set(outs)];
}

/** Gilt eine Bedingung „when“ für dieses System (Laden „steam“)? */
function whenFits(when, osName) {
  if (!Array.isArray(when) || !when.length) return true;
  return when.some((w) => (!w || !w.os || w.os === osName) && (!w || !w.store || w.store === 'steam'));
}

/**
 * Eintrag → zu sichernde Muster: [{ pattern, tags, proton }] und Registry-Hinweise.
 * c wie bei placeholders(); includeConfig = auch Einstellungen (Tag „config“) sichern
 */
function savePatterns(entry, c, { includeConfig = false } = {}) {
  const osName = OS_NAME[c.platform] || 'linux';
  const out = [];
  const files = (entry && entry.files) || {};
  for (const [raw, info] of Object.entries(files)) {
    const tags = (info && Array.isArray(info.tags) ? info.tags : []);
    if (tags.length && !tags.includes('save') && !(includeConfig && tags.includes('config'))) continue;
    const when = info && info.when;
    if (whenFits(when, osName)) for (const p of expandPlaceholders(raw, placeholders(c))) out.push({ pattern: p, tags, proton: false });
    // Linux mit Proton: Windows-Pfade im Präfix des Spiels
    if (c.platform === 'linux' && c.prefix && whenFits(when, 'windows') && /<win|<home>|<osUserName>/.test(raw)) {
      for (const p of expandPlaceholders(raw, placeholders(c, { proton: true }))) out.push({ pattern: p, tags, proton: true });
    }
  }
  const registry = Object.entries((entry && entry.registry) || {}).filter(([, info]) => { const t = info && Array.isArray(info.tags) ? info.tags : []; return !t.length || t.includes('save'); }).map(([k]) => k);
  const seen = new Set();
  return { patterns: out.filter((x) => (seen.has(x.pattern) ? false : seen.add(x.pattern))), registry: c.platform === 'win32' ? registry : [], cloud: !!(entry && entry.cloud && entry.cloud.steam) };
}

/* ---------- Muster → Dateien ---------- */

const GLOB_RE = /[*?[]/;
function segRe(seg, ci) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') { const j = seg.indexOf(']', i); if (j > i) { re += `[${seg.slice(i + 1, j).replace(/\\/g, '\\\\').replace(/^!/, '^')}]`; i = j; } else re += '\\['; } else re += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, ci ? 'i' : '');
}

/**
 * Muster auflösen → [{ file, size, mtime }] (Ordner mit allen Dateien darin). Grenzen gegen Überraschungen:
 * höchstens maxFiles Dateien, Verweise werden nicht verfolgt.
 */
function resolveFiles(pattern, { fs: fsx = fs, ci = process.platform === 'win32', maxFiles = 20000 } = {}) {
  const norm = String(pattern).replace(/\\/g, '/');
  const segs = norm.split('/');
  let start = [];
  let k = 0;
  for (; k < segs.length && !GLOB_RE.test(segs[k]); k++) start.push(segs[k]);
  let base = start.join('/');
  if (base === '' && norm.startsWith('/')) base = '/';
  if (/^[A-Za-z]:$/.test(base)) base += '/';
  const rest = segs.slice(k);
  const matched = [];
  const walk = (dir, i) => {
    if (matched.length >= maxFiles) return;
    if (i >= rest.length) { matched.push(dir); return; }
    const seg = rest[i];
    if (seg === '**') {
      walk(dir, i + 1); // null Ebenen
      let ents = [];
      try { ents = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) if (e.isDirectory() && !e.isSymbolicLink()) walk(path.posix.join(dir, e.name), i);
      return;
    }
    let ents = [];
    try { ents = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const re = segRe(seg, ci);
    for (const e of ents) if (re.test(e.name) && !e.isSymbolicLink()) walk(path.posix.join(dir, e.name), i + 1);
  };
  if (!rest.length) { try { fsx.statSync(base); matched.push(base); } catch { /* fehlt */ } } else walk(base, 0);
  const files = [];
  const seen = new Set();
  const addFile = (f, st) => { const key = ci ? f.toLowerCase() : f; if (seen.has(key) || files.length >= maxFiles) return; seen.add(key); files.push({ file: f, size: st.size, mtime: st.mtimeMs }); };
  for (const m of matched) {
    let st;
    try { st = fsx.lstatSync(m); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isFile()) { addFile(m, st); continue; }
    if (!st.isDirectory()) continue;
    const stack = [m];
    while (stack.length && files.length < maxFiles) {
      const d = stack.pop();
      let ents = [];
      try { ents = fsx.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const p = path.posix.join(d, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) { try { addFile(p, fsx.statSync(p)); } catch { /* weg */ } }
      }
    }
  }
  return files;
}

module.exports = { Manifest, scanStream, placeholders, expandPlaceholders, whenFits, savePatterns, resolveFiles, segRe, MANIFEST_URL, FILE };
