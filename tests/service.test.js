'use strict';
// Zusammenspiel mit Attrappen: erfundene Steam-Installation, Spielsitzung endet → Spielstände gesichert,
// Sicherungs-Zentrale (Liste, Zurückspielen mit Vorab-Sicherung), Bilder, Ordner, Routen
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createService } = require('../server/service');
const lud = require('../server/ludusavi');
const { fakeSteam, tmpDir, cleanup, write, fakeFetch } = require('./helpers');

process.env.HW_TEST = '1';
test.after(cleanup);

function setup({ manifest = true, run = { running: true, appId: 0 } } = {}) {
  const f = fakeSteam();
  const data = tmpDir('data');
  const saveDir = path.join(f.base, 'Saves', 'Cube');
  write(path.join(saveDir, 'slot1.sav'), 'level 1');
  if (manifest) {
    const yaml = `---\nCube Runner:\n  files:\n    "${saveDir.replace(/\\/g, '/')}":\n      tags:\n        - save\n  steam:\n    id: 10\n`;
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, lud.FILE), zlib.gzipSync(yaml));
  }
  const state = { run };
  const notes = [];
  const host = {
    id: 'steam',
    ctx: { paths: { data }, extMarket: { settingsFor: () => ({ autoBackup: true }) } },
    t: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m)) : s),
    error: (status, text) => Object.assign(new Error(text), { status }),
    broadcast: () => {},
    notifications: { register: () => true, notify: (id, msg) => notes.push(msg) },
    supports: () => false,
    core: () => ({ isOffline: () => false }),
  };
  const opened = [];
  let clock = f.now;
  const svc = createService(host, {
    dataDir: data, now: () => (clock += 1000), find: async () => ({ root: f.root, source: 'test' }), runState: async () => state.run, afterDelay: 0,
    describe: async (paths) => paths.map((p) => ({ key: p, label: p, paths: [p], free: 1e12, total: 2e12, media: 'ssd' })),
    fetch: fakeFetch(() => ({ status: 503 })), sleep: async () => {}, offline: () => false, imageCache: null, games: null,
    open: async (x) => { opened.push(x); return true; },
  });
  return { f, svc, state, saveDir, notes, opened, data };
}

test('Ansicht: Bibliothek, Summen, ohne Spiele-Server keine Server-Treffer', async () => {
  const { svc } = setup();
  const v = await svc.view();
  assert.strictEqual(v.found, true);
  assert.strictEqual(v.totals.games, 4);
  assert.strictEqual(v.totals.updates, 1);
  assert.strictEqual(v.totals.downloads, 1);
  assert.strictEqual(v.serversAvailable, false);
  assert.ok(v.games.find((g) => g.appid === 228980).tool);
});

test('Spielsitzung endet → Spielstände automatisch gesichert, Sitzung gebucht', async () => {
  const { svc, state } = setup();
  await svc.scan();
  state.run = { running: true, appId: 10 };
  await svc.tick();
  state.run = { running: true, appId: 0 };
  await svc.tick();
  for (let i = 0; i < 100 && !svc.store.list(10).length; i++) await new Promise((r) => setTimeout(r, 20)); // Sicherung läuft im Hintergrund
  const list = svc.store.list(10);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].reason, 'session');
  assert.strictEqual(svc.play.sessions.length, 1);
  const sv = await svc.savesView();
  const cube = sv.games.find((g) => g.appid === 10);
  assert.ok(cube.known && cube.backups === 1 && cube.files === 1);
  assert.strictEqual(sv.games.find((g) => g.appid === 20).known, false);
});

test('Sicherungs-Zentrale: Liste und Zurückspielen mit Vorab-Sicherung', async () => {
  const { svc, saveDir } = setup();
  const r = await svc.backupGame(10, 'manual');
  assert.ok(r.created);
  fs.writeFileSync(path.join(saveDir, 'slot1.sav'), 'level 9 – kaputt');
  const items = svc.backupSource.list();
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].svcName, 'Cube Runner');
  const out = await svc.backupSource.restore(items[0].id);
  assert.strictEqual(out.restored, 1);
  assert.ok(out.before);
  assert.strictEqual(fs.readFileSync(path.join(saveDir, 'slot1.sav'), 'utf8'), 'level 1');
  assert.strictEqual(svc.backupSource.list().length, 2);
  await assert.rejects(() => svc.backupGame(20), /does not know/);
  await assert.rejects(() => svc.backupGame(999), /not found/);
});

test('Speicher-Doktor über die Ansicht, Reste werden gemessen', async () => {
  const { svc } = setup();
  await svc.scan();
  await svc.measure();
  const d = await svc.doctor();
  assert.ok(d.measured);
  assert.ok(d.findings.some((x) => x.kind === 'never-played' && x.appid === 30));
  assert.ok(d.findings.some((x) => x.kind === 'dormant' && x.appid === 20));
  assert.ok(svc.state.leftovers.workshop['99'], 'Workshop-Reste von Spiel 99 gefunden');
  assert.ok(svc.folderFor('leftover', 'workshop:99'));
  assert.strictEqual(svc.folderFor('leftover', 'workshop:10'), null);
  assert.strictEqual(svc.folderFor('evil', '../..'), null);
});

test('Bilder: zuerst Steams Zwischenspeicher, ohne Netz/Bildspeicher nichts', async () => {
  const { svc } = setup();
  await svc.scan();
  const a = await svc.art(10, 'portrait');
  assert.ok(a.file.endsWith('library_600x900.jpg'));
  assert.strictEqual((await svc.art(10, 'logo')).type, 'image/png');
  assert.strictEqual(await svc.art(10, 'hero'), null);
  assert.strictEqual(await svc.art('x', 'portrait'), null);
});

test('Routen: angemeldet, steam://-Links nur aus der festen Liste', async () => {
  const routes = {};
  const r = {};
  for (const m of ['get', 'post', 'put', 'delete']) r[m] = (p, fn) => { routes[`${m.toUpperCase()} ${p}`] = fn; };
  const data = tmpDir('data');
  const host = { id: 'steam', ctx: { paths: { data } }, router: r, on: () => {}, provide: () => {}, t: (s) => s, error: (status, text) => Object.assign(new Error(text), { status }), broadcast: () => {} };
  require('../server/index').activate(host);
  for (const k of ['GET /steam', 'GET /steam/art/:appid', 'GET /steam/saves', 'POST /steam/saves/restore', 'POST /steam/open', 'POST /steam/folder', 'GET /steam/picks', 'POST /steam/shop/wishlist']) assert.ok(routes[k], k);
  let err = null;
  await routes['POST /steam/open']({ body: { action: 'exec', appid: 1 } }, { json: () => {} }, (e) => { err = e; });
  assert.strictEqual(err.status, 400);
});
