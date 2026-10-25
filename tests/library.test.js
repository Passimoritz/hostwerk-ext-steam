'use strict';
// VDF/ACF lesen, Steam finden, Bibliothek mit Spielzeit, Bildern und Screenshots – alles mit erfundenen Dateien
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const VDF = require('../server/vdf');
const L = require('../server/library');
const loc = require('../server/locate');
const { fakeSteam, cleanup, tmpDir, write } = require('./helpers');

test.after(cleanup);

test('VDF: verschachtelt, Escapes, Kommentare, Bedingungen, Groß/klein', () => {
  const doc = VDF.parse(`// Kommentar
"Root"
{
  "path"   "C:\\\\Games\\\\Steam"
  "quote"  "sagt \\"hallo\\""
  Bare     Wert
  "Inner" [$WIN32]
  {
    "Apps" { "10" "5" }
  }
  "path" "zweiter Wert wird ignoriert"
}`);
  assert.strictEqual(doc.Root.path, 'C:\\Games\\Steam');
  assert.strictEqual(doc.Root.quote, 'sagt "hallo"');
  assert.strictEqual(doc.Root.Bare, 'Wert');
  assert.strictEqual(VDF.get(doc, 'root', 'inner', 'apps', '10'), '5');
  assert.strictEqual(VDF.num('x', 7), 7);
});

test('VDF: kaputte Datei liefert, was lesbar war, statt zu werfen', () => {
  const doc = VDF.parse('"A" { "b" "1" "c" { "d" "2"');
  assert.strictEqual(doc.A.b, '1');
  assert.strictEqual(doc.A.c.d, '2');
  assert.deepStrictEqual(VDF.parse(''), {});
});

test('ACF: Zustand, Update steht an, Download-Fortschritt', () => {
  const m = L.parseAppManifest(`"AppState" { "appid" "40" "name" "X" "StateFlags" "${4 | 1024 | 1048576}" "BytesToDownload" "1000" "BytesDownloaded" "250" "buildid" "1" "TargetBuildID" "2" "SizeOnDisk" "5" }`);
  assert.strictEqual(m.appid, 40);
  assert.ok(m.state.installed && m.state.busy);
  assert.ok(m.updatePending);
  assert.strictEqual(m.download.pct, 25);
  const ok = L.parseAppManifest('"AppState" { "appid" "1" "StateFlags" "4" "buildid" "5" "TargetBuildID" "0" }');
  assert.strictEqual(ok.updatePending, false);
  assert.strictEqual(ok.download, null);
  assert.strictEqual(L.parseAppManifest('"nix" {}'), null);
});

test('libraryfolders.vdf: neues Format mit Größen und altes Format', () => {
  const neu = L.parseLibraryFolders('"libraryfolders" { "0" { "path" "C:\\\\Steam" "apps" { "10" "99" } } "1" { "path" "D:\\\\Lib" "label" "D" "apps" {} } }', 'c:/steam');
  assert.strictEqual(neu.length, 2, 'Steam-Ordner nur einmal, auch in anderer Schreibweise');
  assert.strictEqual(neu[0].apps['10'], 99);
  const alt = L.parseLibraryFolders('"LibraryFolders" { "TimeNextStatsReport" "1" "ContentStatsID" "2" "1" "D:\\\\SteamLibrary" }', 'C:\\Steam');
  assert.deepStrictEqual(alt.map((x) => x.path), ['C:\\Steam', 'D:\\SteamLibrary']);
});

test('Bibliothek: zwei Bibliotheken, Werkzeug markiert, Spielzeit vom zuletzt angemeldeten Konto', () => {
  const f = fakeSteam();
  const lib = L.scanLibrary(f.root);
  assert.strictEqual(lib.libraries.length, 2);
  assert.strictEqual(lib.games.length, 5);
  const by = Object.fromEntries(lib.games.map((g) => [g.appid, g]));
  assert.ok(by[228980].tool, 'Redistributables sind kein Spiel');
  assert.strictEqual(by[10].playtime, 300);
  assert.strictEqual(by[10].playtime2wks, 60);
  assert.strictEqual(by[20].updatePending, true);
  assert.strictEqual(by[40].download.pct, 25);
  assert.strictEqual(by[30].playtime, 0);
  assert.strictEqual(lib.user, f.account);
  assert.strictEqual(lib.users[0].persona, 'Tester');
  assert.ok(!JSON.stringify(lib.users).includes('secret_login_name'), 'Kontoname bleibt außen vor');
  assert.strictEqual(lib.libraries[1].count, 3);
});

test('Bilder aus Steams Zwischenspeicher: neues und altes Format', () => {
  const f = fakeSteam();
  const a = L.localArt(f.root, 10);
  assert.ok(a.portrait.endsWith('library_600x900.jpg'));
  assert.ok(a.logo.endsWith('logo.png'));
  assert.strictEqual(a.hero, null);
  assert.ok(L.localArt(f.root, 20).portrait.endsWith('20_library_600x900.jpg'));
});

test('Screenshots: Liste und nur sichere Dateinamen', () => {
  const f = fakeSteam();
  const list = L.listScreenshots(f.root, f.account);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].hasThumb, true);
  assert.ok(L.screenshotPath(f.root, f.account, 10, '20261001_1.jpg', true).includes('thumbnails'));
  assert.strictEqual(L.screenshotPath(f.root, f.account, 10, '../../config/loginusers.vdf'), null);
  assert.strictEqual(L.screenshotPath(f.root, '..', 10, 'a.jpg'), null);
});

test('Steam finden: Registry, Standardordner, Linux mit Flatpak, eigener Ordner zuerst', async () => {
  const win = loc.candidates({ platform: 'win32', env: {}, reg: { SteamPath: 'c:/program files (x86)/steam' } });
  assert.strictEqual(win[0].source, 'registry');
  assert.strictEqual(win.length, 2, 'Registry und Standard sind derselbe Ordner');
  const lin = loc.candidates({ platform: 'linux', env: {}, home: '/home/a', custom: '/mnt/steam' });
  assert.strictEqual(lin[0].dir, '/mnt/steam');
  assert.ok(lin.some((c) => c.source === 'flatpak'));
  const f = fakeSteam();
  const hit = await loc.findSteam({ platform: 'linux', home: tmpDir('home'), env: {}, custom: f.root });
  assert.strictEqual(hit.source, 'custom');
  const home = tmpDir('home');
  fs.mkdirSync(path.join(home, '.local', 'share', 'Steam', 'steamapps'), { recursive: true });
  const def = await loc.findSteam({ platform: 'linux', home, env: {} });
  assert.ok(def && def.root.endsWith('Steam'));
  assert.strictEqual(await loc.findSteam({ platform: 'linux', home: tmpDir('leer'), env: {} }), null);
  // Registry-Pfad wird mit Windows-Regeln normalisiert – auf Linux (GitHub-Action) wäre der Testordner dann ein \-Pfad
  if (process.platform === 'win32') {
    const viaReg = await loc.findSteam({ platform: 'win32', env: {}, reg: async () => ({ SteamPath: f.root }) });
    assert.strictEqual(viaReg.source, 'registry');
  }
});

test('reg query lesen und Laufzustand (Windows-Registry, Linux registry.vdf)', async () => {
  const out = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x1b2\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n';
  const v = loc.parseRegQuery(out);
  assert.strictEqual(v.RunningAppID, 434);
  assert.strictEqual(v.SteamPath, 'c:/program files (x86)/steam');
  const reg = async (k) => (k.endsWith('ActiveProcess') ? { pid: 42 } : { RunningAppID: 434 });
  assert.deepStrictEqual(await loc.runState({ platform: 'win32', reg, alive: () => true }), { running: true, pid: 42, appId: 434 });
  assert.deepStrictEqual(await loc.runState({ platform: 'win32', reg, alive: () => false }), { running: false, pid: 0, appId: 0 });
  const home = tmpDir('home');
  write(path.join(home, '.steam', 'registry.vdf'), '"Registry" { "HKCU" { "Software" { "Valve" { "Steam" { "RunningAppID" "10" } } } } }');
  write(path.join(home, '.steam', 'steam.pid'), '777\n');
  assert.deepStrictEqual(await loc.runState({ platform: 'linux', home, alive: (p) => p === 777 }), { running: true, pid: 777, appId: 10 });
});
