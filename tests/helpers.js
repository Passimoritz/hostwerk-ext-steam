'use strict';
// Attrappen für die Tests: eine erfundene Steam-Installation im Temp-Ordner (keine echten Daten), fetch und Uhr
const fs = require('fs');
const os = require('os');
const path = require('path');

const temp = [];
function tmpDir(tag = 'st') { const d = fs.mkdtempSync(path.join(os.tmpdir(), `hw-${tag}-`)); temp.push(d); return d; }
function cleanup() { for (const d of temp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); }
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const DAY = 24 * 3600e3;

/** ACF-Text eines Spiels */
function acf({ appid, name, dir, flags = 4, size = 1e9, lastUpdated = 0, lastPlayed = 0, build = '100', target = '0', toDl = 0, dl = 0 }) {
  return `"AppState"
{
\t"appid"\t\t"${appid}"
\t"Universe"\t\t"1"
\t"name"\t\t"${name}"
\t"StateFlags"\t\t"${flags}"
\t"installdir"\t\t"${dir}"
\t"LastUpdated"\t\t"${Math.floor(lastUpdated / 1000)}"
\t"LastPlayed"\t\t"${Math.floor(lastPlayed / 1000)}"
\t"SizeOnDisk"\t\t"${size}"
\t"buildid"\t\t"${build}"
\t"BytesToDownload"\t\t"${toDl}"
\t"BytesDownloaded"\t\t"${dl}"
\t"TargetBuildID"\t\t"${target}"
\t"InstalledDepots"
\t{
\t\t"${appid + 1}"
\t\t{
\t\t\t"manifest"\t\t"123"
\t\t\t"size"\t\t"${size}"
\t\t}
\t}
}
`;
}

/**
 * Erfundene Steam-Installation: zwei Bibliotheken, vier Spiele + ein Werkzeug, ein Konto mit Spielzeit, Bilder, Screenshots.
 * → { root, lib2, account, steamId, now }
 */
function fakeSteam({ now = Date.parse('2026-10-20T12:00:00Z') } = {}) {
  const base = tmpDir('steam');
  const root = path.join(base, 'Steam');
  const lib2 = path.join(base, 'Games', 'SteamLibrary');
  const account = '12345678';
  const steamId = String(76561197960265728n + 12345678n);
  const esc = (p) => p.replace(/\\/g, '\\\\');
  write(path.join(root, 'steamapps', 'libraryfolders.vdf'), `"libraryfolders"
{
\t"0"
\t{
\t\t"path"\t\t"${esc(root)}"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
\t\t\t"10"\t\t"500000000"
\t\t\t"228980"\t\t"1000"
\t\t}
\t}
\t"1"
\t{
\t\t"path"\t\t"${esc(lib2)}"
\t\t"label"\t\t"Games"
\t\t"apps"
\t\t{
\t\t\t"20"\t\t"20000000000"
\t\t\t"30"\t\t"8000000000"
\t\t\t"40"\t\t"2000000000"
\t\t}
\t}
}
`);
  const sa = path.join(root, 'steamapps');
  const sb = path.join(lib2, 'steamapps');
  write(path.join(sa, 'appmanifest_10.acf'), acf({ appid: 10, name: 'Cube Runner', dir: 'Cube Runner', size: 500000000, lastUpdated: now - 400 * DAY, lastPlayed: now - 2 * DAY }));
  write(path.join(sa, 'appmanifest_228980.acf'), acf({ appid: 228980, name: 'Steamworks Common Redistributables', dir: 'Steamworks Shared', size: 1000 }));
  write(path.join(sb, 'appmanifest_20.acf'), acf({ appid: 20, name: 'Big Quest', dir: 'Big Quest', size: 20e9, lastUpdated: now - 500 * DAY, build: '7', target: '9', flags: 6 }));
  write(path.join(sb, 'appmanifest_30.acf'), acf({ appid: 30, name: 'Never Played', dir: 'NeverPlayed', size: 8e9, lastUpdated: now - 90 * DAY }));
  write(path.join(sb, 'appmanifest_40.acf'), acf({ appid: 40, name: 'Updating Game', dir: 'Updating', size: 2e9, lastUpdated: now - 5 * DAY, flags: 4 | 1024 | 1048576, toDl: 1000, dl: 250 }));
  for (const [lib, dir] of [[sa, 'Cube Runner'], [sb, 'Big Quest'], [sb, 'NeverPlayed'], [sb, 'Updating']]) fs.mkdirSync(path.join(lib, 'common', dir), { recursive: true });
  // Reste eines entfernten Spiels (99)
  write(path.join(sb, 'workshop', 'content', '99', 'item', 'map.bin'), Buffer.alloc(2048));
  write(path.join(root, 'config', 'loginusers.vdf'), `"users"
{
\t"${steamId}"
\t{
\t\t"AccountName"\t\t"secret_login_name"
\t\t"PersonaName"\t\t"Tester"
\t\t"MostRecent"\t\t"1"
\t\t"Timestamp"\t\t"${Math.floor(now / 1000)}"
\t}
}
`);
  write(path.join(root, 'userdata', account, 'config', 'localconfig.vdf'), `"UserLocalConfigStore"
{
\t"Software"
\t{
\t\t"Valve"
\t\t{
\t\t\t"Steam"
\t\t\t{
\t\t\t\t"Apps"
\t\t\t\t{
\t\t\t\t\t"10"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"${Math.floor((now - 2 * DAY) / 1000)}"
\t\t\t\t\t\t"Playtime"\t\t"300"
\t\t\t\t\t\t"Playtime2wks"\t\t"60"
\t\t\t\t\t}
\t\t\t\t\t"20"
\t\t\t\t\t{
\t\t\t\t\t\t"LastPlayed"\t\t"${Math.floor((now - 300 * DAY) / 1000)}"
\t\t\t\t\t\t"Playtime"\t\t"4000"
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}
`);
  // Bilder: neues Format (Unterordner mit Prüfsumme) für 10, altes flaches Format für 20
  write(path.join(root, 'appcache', 'librarycache', '10', 'abc123', 'library_600x900.jpg'), 'jpg');
  write(path.join(root, 'appcache', 'librarycache', '10', 'def456', 'logo.png'), 'png');
  write(path.join(root, 'appcache', 'librarycache', '20_library_600x900.jpg'), 'jpg');
  // Screenshots
  write(path.join(root, 'userdata', account, '760', 'remote', '10', 'screenshots', '20261001_1.jpg'), 'shot');
  write(path.join(root, 'userdata', account, '760', 'remote', '10', 'screenshots', 'thumbnails', '20261001_1.jpg'), 'thumb');
  return { base, root, lib2, account, steamId, now };
}

/** fetch-Attrappe: route(url, opts) → { status, body, headers } oder Body direkt; jede Abfrage landet in calls. */
function fakeFetch(route) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    let r = await route(url, opts);
    if (r instanceof Error) throw r;
    if (!r || r.status === undefined) r = { status: 200, body: r };
    const headers = r.headers || {};
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => r.body, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), body: null };
  };
  fn.calls = calls;
  return fn;
}

module.exports = { tmpDir, cleanup, write, fakeSteam, fakeFetch, acf, DAY };
