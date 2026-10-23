'use strict';
// Ludusavi-Verzeichnis (YAML, Datenstrom, Platzhalter, Muster) und die Spielstand-Zeitmaschine – mit Attrappen
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');
const YAML = require('../server/yaml');
const lud = require('../server/ludusavi');
const { SaveStore } = require('../server/saves');
const { tmpDir, cleanup, write, fakeFetch } = require('./helpers');

test.after(cleanup);

const MANIFEST = `---
"Alpha Game":
  cloud:
    steam: true
  files:
    "<winAppData>/Alpha/save*.dat":
      tags:
        - save
      when:
        - os: windows
          store: steam
    "<base>/Saves":
      tags:
        - save
    "<base>/settings.ini":
      tags:
        - config
    "<xdgData>/alpha":
      when:
        - os: linux
  installDir:
    Alpha: {}
  steam:
    id: 100
Beta:
  files:
    "<home>/Documents/Beta/**/*.sav":
      tags:
        - save
  registry:
    HKEY_CURRENT_USER/Software/Beta:
      tags:
        - save
  steam:
    id: 200
"Gamma: \\"Quoted\\"":
  id:
    steamExtra:
      - 301
  steam:
    id: 300
Notes Game:
  notes:
    - message: |-
        Line one
        Line two
  steam:
    id: 400
`;

test('YAML: Abbildungen, Listen, „- key:“, Anführungszeichen, Blocktext', () => {
  const doc = YAML.parse(MANIFEST);
  assert.deepStrictEqual(Object.keys(doc), ['Alpha Game', 'Beta', 'Gamma: "Quoted"', 'Notes Game']);
  assert.deepStrictEqual(doc['Alpha Game'].files['<winAppData>/Alpha/save*.dat'].when, [{ os: 'windows', store: 'steam' }]);
  assert.deepStrictEqual(doc['Alpha Game'].installDir, { Alpha: {} });
  assert.strictEqual(doc.Beta.steam.id, 200);
  assert.deepStrictEqual(doc['Gamma: "Quoted"'].id.steamExtra, [301]);
  assert.strictEqual(doc['Notes Game'].notes[0].message, 'Line one\nLine two');
  assert.strictEqual(YAML.parse("a: 'it''s'").a, "it's");
});

test('Datenstrom: nur gesuchte Steam-IDs werden geparst (auch steamExtra)', async () => {
  const map = await lud.scanStream(Readable.from([MANIFEST]), new Set([100, 301, 999]));
  assert.deepStrictEqual([...map.keys()].sort(), [100, 301]);
  assert.strictEqual(map.get(301).name, 'Gamma: "Quoted"');
  assert.strictEqual(map.get(100).entry.cloud.steam, true);
});

test('Laden: einmal am Tag, mit If-None-Match, gepackt abgelegt, offline nicht', async () => {
  const dir = tmpDir('lud');
  let t = 1e12;
  let offline = false;
  const fetch = fakeFetch((url, opts) => (opts.headers['If-None-Match'] === '"v1"' ? { status: 304 } : { status: 200, body: MANIFEST, headers: { etag: '"v1"' } }));
  const m = new lud.Manifest({ dataDir: dir, fetch, now: () => t, offline: () => offline });
  assert.deepStrictEqual(await m.refresh(), { changed: true });
  assert.ok(m.state().have);
  assert.strictEqual(zlib.gunzipSync(fs.readFileSync(path.join(dir, lud.FILE))).toString(), MANIFEST);
  assert.deepStrictEqual(await m.refresh(), { skipped: 'fresh' });
  t += 25 * 3600e3;
  assert.deepStrictEqual(await m.refresh(), { changed: false });
  assert.strictEqual(fetch.calls[1].headers['If-None-Match'], '"v1"');
  offline = true;
  assert.deepStrictEqual(await m.refresh({ force: true }), { skipped: 'offline' });
  const map = await m.lookup([200, 100]);
  assert.strictEqual(map.get(200).name, 'Beta');
  assert.strictEqual(await m.lookup([200, 100]), map, 'gemerkt');
  const bad = new lud.Manifest({ dataDir: tmpDir('lud'), fetch: fakeFetch(() => ({ status: 500 })), now: () => t });
  assert.strictEqual((await bad.refresh()).error, 'HTTP 500');
  assert.strictEqual((await bad.lookup([1])).size, 0);
});

test('Platzhalter: Windows, Linux nativ und Proton-Präfix', () => {
  const entry = YAML.parse(MANIFEST)['Alpha Game'];
  const win = lud.savePatterns(entry, { platform: 'win32', env: { APPDATA: 'C:\\Users\\A\\AppData\\Roaming' }, home: 'C:\\Users\\A', root: 'D:\\Lib', installDir: 'Alpha', appid: 100, accounts: ['1'] });
  assert.deepStrictEqual(win.patterns.map((p) => p.pattern), ['C:/Users/A/AppData/Roaming/Alpha/save*.dat', 'D:/Lib/steamapps/common/Alpha/Saves']);
  assert.strictEqual(win.cloud, true);
  const withCfg = lud.savePatterns(entry, { platform: 'win32', env: {}, home: 'C:\\Users\\A', root: 'D:\\Lib', installDir: 'Alpha' }, { includeConfig: true });
  assert.ok(withCfg.patterns.some((p) => p.pattern.endsWith('settings.ini')));
  const lin = lud.savePatterns(entry, { platform: 'linux', env: {}, home: '/home/a', root: '/home/a/.steam/steam', installDir: 'Alpha', appid: 100, prefix: '/lib/steamapps/compatdata/100/pfx/drive_c' });
  const pats = lin.patterns.map((p) => p.pattern);
  assert.ok(pats.includes('/home/a/.local/share/alpha'), 'Linux-Pfad');
  assert.ok(pats.includes('/lib/steamapps/compatdata/100/pfx/drive_c/users/steamuser/AppData/Roaming/Alpha/save*.dat'), 'Windows-Pfad im Proton-Präfix');
  assert.ok(lin.patterns.find((p) => p.pattern.includes('steamuser')).proton);
  const beta = lud.savePatterns(YAML.parse(MANIFEST).Beta, { platform: 'win32', env: {}, home: 'C:/Users/A' });
  assert.deepStrictEqual(beta.registry, ['HKEY_CURRENT_USER/Software/Beta']);
  assert.deepStrictEqual(lud.expandPlaceholders('<base>/x', { '<base>': [] }), []);
  assert.deepStrictEqual(lud.expandPlaceholders('<unknown>/x', {}), []);
  assert.deepStrictEqual(lud.expandPlaceholders('<winDocuments>/G', { '<winDocuments>': ['C:/A/Documents', 'C:/A/OneDrive/Documents'] }), ['C:/A/Documents/G', 'C:/A/OneDrive/Documents/G']);
});

test('Muster auflösen: *, ** und Ordner mit allen Dateien', () => {
  const d = tmpDir('glob').replace(/\\/g, '/');
  write(`${d}/Alpha/save1.dat`, 'a');
  write(`${d}/Alpha/save2.dat`, 'bb');
  write(`${d}/Alpha/other.txt`, 'x');
  write(`${d}/Beta/slot1/deep/game.sav`, 'c');
  write(`${d}/Beta/game.sav`, 'd');
  write(`${d}/Dir/a/b.bin`, 'e');
  const names = (arr) => arr.map((f) => path.basename(f.file)).sort();
  assert.deepStrictEqual(names(lud.resolveFiles(`${d}/Alpha/save*.dat`)), ['save1.dat', 'save2.dat']);
  assert.deepStrictEqual(names(lud.resolveFiles(`${d}/Beta/**/*.sav`)), ['game.sav', 'game.sav']);
  assert.deepStrictEqual(names(lud.resolveFiles(`${d}/Dir`)), ['b.bin']);
  assert.deepStrictEqual(lud.resolveFiles(`${d}/missing/*.x`), []);
  assert.strictEqual(lud.resolveFiles(`${d}/Alpha/*`, { maxFiles: 2 }).length, 2);
  assert.ok(lud.segRe('SAVE?.dat', true).test('save1.DAT'));
});

test('Zeitmaschine: Stand, unverändert, nur Neues kostet Platz, Zurückspielen mit Vorab-Sicherung', () => {
  const d = tmpDir('saves');
  const live = path.join(d, 'live');
  write(path.join(live, 'a.sav'), 'one');
  write(path.join(live, 'b.sav'), 'two');
  let t = Date.parse('2026-10-01T10:00:00Z');
  const store = new SaveStore({ dir: path.join(d, 'store'), now: () => t, keep: 2 });
  const files = () => lud.resolveFiles(live.replace(/\\/g, '/'));
  const r1 = store.create({ appid: 10, name: 'Cube', files: files(), reason: 'session' });
  assert.ok(r1.created);
  assert.strictEqual(r1.count, 2);
  t += 60e3;
  const r2 = store.create({ appid: 10, name: 'Cube', files: files(), reason: 'session' });
  assert.strictEqual(r2.unchanged, true, 'nichts geändert → kein neuer Stand');
  fs.writeFileSync(path.join(live, 'a.sav'), 'ONE-CHANGED');
  t += 60e3;
  const r3 = store.create({ appid: 10, name: 'Cube', files: files(), reason: 'session' });
  assert.ok(r3.created);
  assert.strictEqual(r3.newBytes, 'ONE-CHANGED'.length, 'b.sav liegt schon da');
  assert.strictEqual(store.list(10).length, 2);
  // Zurückspielen des ersten Stands: läuft das Spiel, wird abgelehnt
  assert.throws(() => store.restore(r1.id, { isRunning: () => true }), /running/);
  const out = store.restore(r1.id, { current: files });
  assert.strictEqual(out.restored, 2);
  assert.ok(out.before, 'Vorab-Sicherung angelegt');
  assert.strictEqual(fs.readFileSync(path.join(live, 'a.sav'), 'utf8'), 'one');
  assert.strictEqual(store.list(10).find((s) => s.id === out.before).reason, 'before-restore');
  // Aufräumen: höchstens 2 automatische Stände
  for (let i = 0; i < 3; i++) { t += 60e3; fs.writeFileSync(path.join(live, 'b.sav'), `v${i}`); store.create({ appid: 10, name: 'Cube', files: files(), reason: 'session' }); }
  assert.strictEqual(store.list(10).filter((s) => s.reason === 'session').length, 2);
  // Löschen räumt Inhalte ohne Verweis weg
  const before = store.usage(10);
  store.remove(store.list(10).find((s) => s.reason === 'session').id);
  assert.ok(store.usage(10) <= before);
  assert.throws(() => store.read('../../etc'), /not found/);
  // Ausgeben für die externe Sicherung
  const outDir = path.join(d, 'offsite');
  assert.strictEqual(store.materialize(store.list(10)[0].id, outDir), 2);
  assert.ok(fs.existsSync(path.join(outDir, 'hostwerk-saves.json')));
});

test('Zeitmaschine: zu groß → Fehler, leer → kein Stand', () => {
  const d = tmpDir('saves');
  write(path.join(d, 'big.sav'), 'x'.repeat(100));
  const store = new SaveStore({ dir: path.join(d, 'store'), maxBytes: 10 });
  assert.throws(() => store.create({ appid: 1, name: 'X', files: [{ file: path.join(d, 'big.sav'), size: 100 }] }), (e) => e.status === 413);
  assert.deepStrictEqual(store.create({ appid: 1, name: 'X', files: [] }), { created: false, empty: true, bytes: 0, count: 0 });
});
