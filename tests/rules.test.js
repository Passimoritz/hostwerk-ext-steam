'use strict';
// Speicher-Doktor, Laufwerke, Preise und Meldungen, Server-Erkennung, Vorschläge, Statistik, Steam-Links
const test = require('node:test');
const assert = require('node:assert');
const { diagnose, GB } = require('../server/doctor');
const drives = require('../server/drives');
const { Shop, libraryValue } = require('../server/store');
const servers = require('../server/servers');
const { suggest, rng } = require('../server/picks');
const stats = require('../server/stats');
const links = require('../server/links');
const { tmpDir, cleanup, fakeFetch, DAY } = require('./helpers');

test.after(cleanup);
const NOW = Date.parse('2026-10-20T12:00:00Z');
const game = (o) => ({ tool: false, state: { installed: true, busy: false, uninstalling: false }, library: 'D:\\Lib', sizeOnDisk: 2 * GB, playtime: 0, lastPlayed: null, lastUpdated: NOW - 100 * DAY, ...o });

test('Speicher-Doktor: nie gespielt, lange nicht gespielt, HDD statt SSD, volles Laufwerk, Reste', () => {
  const lib = { games: [
    game({ appid: 1, name: 'Never', sizeOnDisk: 3 * GB }),
    game({ appid: 2, name: 'Old', sizeOnDisk: 40 * GB, playtime: 900, lastPlayed: NOW - 400 * DAY }),
    game({ appid: 3, name: 'Hot', playtime: 3000, playtime2wks: 300, lastPlayed: NOW - DAY, library: 'E:\\Slow' }),
    game({ appid: 4, name: 'Fresh install', lastUpdated: NOW - 5 * DAY }),
    game({ appid: 5, name: 'Tiny', sizeOnDisk: 0.2 * GB }),
    { appid: 6, name: 'Proton', tool: true, state: { installed: true }, sizeOnDisk: 5 * GB, library: 'D:\\Lib' },
  ] };
  const dr = [
    { key: 'D', label: 'D:', paths: ['D:\\Lib'], free: 500 * GB, total: 1000 * GB, media: 'ssd' },
    { key: 'E', label: 'E:', paths: ['E:\\Slow'], free: 5 * GB, total: 2000 * GB, media: 'hdd' },
  ];
  const r = diagnose({ lib, drives: dr, leftovers: { workshop: { 99: { bytes: 2 * GB, dir: 'x' }, 1: { bytes: 2 * GB } }, shader: { 98: 10 } }, now: NOW });
  const kinds = r.findings.map((f) => `${f.kind}:${f.appid || f.drive}`);
  assert.ok(kinds.includes('never-played:1'));
  assert.ok(kinds.includes('dormant:2'));
  assert.ok(kinds.includes('slow-drive:3'));
  assert.ok(kinds.includes('drive-low:E:'));
  assert.ok(kinds.includes('leftover:99'));
  assert.ok(!kinds.some((k) => /:(4|5|6)$/.test(k)), 'frisch installiert, klein und Werkzeuge bleiben außen vor');
  assert.ok(!kinds.includes('leftover:1'), 'Reste eines installierten Spiels sind keine Reste');
  assert.ok(!kinds.includes('leftover:98'), 'winzige Reste werden nicht genannt');
  assert.strictEqual(r.findings[0].kind, 'drive-low', 'Dringendes zuerst');
  assert.strictEqual(r.reclaim, 3 * GB + 40 * GB + 2 * GB);
  assert.strictEqual(diagnose({ lib, drives: dr, now: NOW, opts: { dormantDays: 500 } }).counts.dormant, undefined);
});

test('Laufwerke: SSD/HDD aus PowerShell und lsblk, frei/gesamt, Abfrage nur einmal am Tag', async () => {
  assert.deepStrictEqual(drives.parseWinMedia('[{"L":"C","M":"SSD","B":"NVMe"},{"L":"D","M":"HDD","B":"SATA"},{"L":"E","M":"Unspecified","B":"NVMe"},{"L":"F","M":"","B":"USB"}]'), { C: 'ssd', D: 'hdd', E: 'ssd', F: null });
  assert.deepStrictEqual(drives.parseWinMedia('{"L":"C","M":"4","B":"11"}'), { C: 'ssd' });
  assert.strictEqual(drives.parseLsblk('   0 part\n   1 disk\n'), 'hdd');
  assert.strictEqual(drives.parseLsblk('0 disk'), 'ssd');
  assert.strictEqual(drives.parseLsblk(''), null);
  let calls = 0;
  const cache = {};
  const io = { platform: 'win32', cache, now: () => NOW, exec: async () => { calls++; return '[{"L":"C","M":"SSD"}]'; }, fs: { statfsSync: () => ({ bavail: 10, bsize: 4096, blocks: 100 }) } };
  const d1 = await drives.describe(['C:\\Steam', 'C:\\Other'], io);
  assert.strictEqual(d1.length, 1);
  assert.strictEqual(d1[0].media, 'ssd');
  assert.strictEqual(d1[0].free, 40960);
  await drives.describe(['C:\\Steam'], io);
  assert.strictEqual(calls, 1);
  const size = drives.dirSize(tmpDir('empty'));
  assert.strictEqual(size, 0);
});

test('Preise: viele Spiele in einer Abfrage, Verlauf nur bei Änderung, tiefster Preis', async () => {
  let t = NOW;
  let price = { 10: { final: 1999, initial: 1999, discount_percent: 0 }, 20: null };
  const fetch = fakeFetch((url) => {
    assert.ok(url.includes('filters=price_overview'));
    const out = {};
    for (const id of /appids=([\d,]+)/.exec(url)[1].split(',')) out[id] = price[id] ? { success: true, data: { price_overview: { currency: 'EUR', ...price[id], final_formatted: `${price[id].final / 100}€` } } } : { success: true, data: [] };
    return out;
  });
  const shop = new Shop({ dataDir: tmpDir('shop'), fetch, now: () => t, sleep: async (ms) => { t += ms; } });
  await shop.refreshPrices([10, 20], { cc: 'DE' });
  assert.strictEqual(fetch.calls.length, 1);
  const p = shop.load().prices;
  assert.strictEqual(p[10].final, 1999);
  assert.strictEqual(p[20].free, true);
  await shop.refreshPrices([10, 20], { cc: 'DE' });
  assert.strictEqual(fetch.calls.length, 1, 'noch frisch – nicht nochmal fragen');
  price = { 10: { final: 999, initial: 1999, discount_percent: 50 } };
  t += 12 * 3600e3;
  const changed = await shop.refreshPrices([10], { cc: 'DE' });
  assert.deepStrictEqual(changed, [10]);
  assert.strictEqual(shop.load().history[10].length, 2);
  assert.strictEqual(shop.load().prices[10].lowest, 999);
  assert.deepStrictEqual(libraryValue([10, 20, 30], shop.load().prices), { regular: 1999, now: 999, counted: 1, missing: 1, currency: 'EUR' });
});

test('Meldungen: je Angebot einmal, Zielpreis, nach Ende wieder bereit', async () => {
  let t = NOW;
  let po = { final: 1500, initial: 1500, discount_percent: 0 };
  const shop = new Shop({ dataDir: tmpDir('shop'), fetch: fakeFetch(() => ({ 1: { success: true, data: { price_overview: { currency: 'EUR', ...po } } } })), now: () => t, sleep: async () => {} });
  shop.addWatch({ appid: 1, name: 'Wish', target: 1000 });
  await shop.refreshPrices([1], { force: true });
  assert.deepStrictEqual(shop.alerts(), []);
  po = { final: 1200, initial: 1500, discount_percent: 20 };
  await shop.refreshPrices([1], { force: true });
  assert.deepStrictEqual(shop.alerts().map((a) => a.why), ['sale']);
  assert.deepStrictEqual(shop.alerts(), [], 'dasselbe Angebot nur einmal');
  po = { final: 900, initial: 1500, discount_percent: 40 };
  await shop.refreshPrices([1], { force: true });
  assert.deepStrictEqual(shop.alerts().map((a) => a.why), ['target']);
  po = { final: 1500, initial: 1500, discount_percent: 0 };
  await shop.refreshPrices([1], { force: true });
  assert.deepStrictEqual(shop.alerts(), []);
  po = { final: 1200, initial: 1500, discount_percent: 20 };
  await shop.refreshPrices([1], { force: true });
  assert.strictEqual(shop.alerts().length, 1, 'neues Angebot nach dem Ende meldet wieder');
  shop.removeWatch(1);
  assert.strictEqual(shop.watchlist().length, 0);
  assert.throws(() => shop.addWatch({ appid: 'x' }), /Invalid/);
});

test('Shop: Drosselung bei 429, offline nichts, Wunschliste und Suche', async () => {
  let t = NOW;
  let status = 429;
  const shop = new Shop({ dataDir: tmpDir('shop'), fetch: fakeFetch((url) => (status === 429 ? { status } : url.includes('GetWishlist') ? { response: { items: [{ appid: 5, date_added: 1700000000 }] } } : { items: [{ type: 'app', id: 7, name: 'Seven', price: { final: 100, initial: 200, currency: 'EUR' } }, { type: 'sub', id: 8 }] })), now: () => t, sleep: async () => {} });
  assert.strictEqual(await shop.search('Seven'), null);
  assert.ok(shop.view().blocked);
  t += 16 * 60e3;
  status = 200;
  assert.deepStrictEqual((await shop.search('Seven')).map((x) => x.appid), [7]);
  assert.deepStrictEqual(await shop.search('S'), []);
  assert.deepStrictEqual((await shop.wishlist('76561198000000000')).map((x) => x.appid), [5]);
  await assert.rejects(() => shop.wishlist('123'), /Invalid Steam ID/);
  const off = new Shop({ dataDir: tmpDir('shop'), fetch: () => { throw new Error('kein Netz erlaubt'); }, offline: () => true });
  assert.strictEqual(await off.search('Seven'), null);
  assert.deepStrictEqual(await off.refreshPrices([1]), []);
});

test('Server dazu: über die Steam-ID des Spiels, über den Namen, Anmeldung nötig, vorhandene Server', () => {
  const lib = { games: [
    { appid: 892970, name: 'Valheim' }, { appid: 252490, name: 'Rust' }, { appid: 107410, name: 'Arma 3' }, { appid: 555, name: 'Solo Game' }, { appid: 228980, name: 'Redist', tool: true },
  ] };
  const games = {
    list: () => [{ id: 'v1', kind: 'steam', appid: 896660, name: 'Wikinger', running: true }, { id: 'l1', kind: 'lgsm', appid: null, name: 'x' }],
    apps: { all: () => [
      { appid: 896660, name: 'Valheim Dedicated Server', game: 892970, profile: true },
      { appid: 258550, name: 'Rust Dedicated Server', profile: true },
      { appid: 233780, name: 'Arma 3 Server', game: 107410, login: true },
      { appid: 4020, name: "Garry's Mod Dedicated Server", game: 4000 },
    ] },
  };
  const m = servers.match(lib, games);
  assert.deepStrictEqual([...m.keys()].sort(), [107410, 252490, 892970]);
  assert.deepStrictEqual(m.get(892970).servers, [{ id: 'v1', name: 'Wikinger', running: true }]);
  assert.strictEqual(m.get(252490).tool.appid, 258550, 'über den Namen gefunden');
  assert.strictEqual(m.get(107410).tool.login, true);
  assert.strictEqual(servers.match(lib, null).size, 0, 'ohne Spiele-Server keine Treffer');
  assert.strictEqual(servers.gamesApi({}), null);
  assert.strictEqual(servers.toolBase('ARK: Survival Evolved Dedicated Server'), 'ark survival evolved');
});

test('Was spiele ich heute: Stimmungen, Zufall mit Startwert, zuletzt gespieltes nie dabei', () => {
  const g = (appid, o) => ({ appid, name: `G${appid}`, tool: false, state: { installed: true, busy: false }, playtime: 0, lastPlayed: null, ...o });
  const games = [
    g(1, { playtime: 120, lastPlayed: NOW - 40 * DAY }),
    g(2, { playtime: 3000, lastPlayed: NOW - 200 * DAY }),
    g(3, {}),
    g(4, { playtime: 50, lastPlayed: NOW - 3600e3 }),
    g(5, { playtime: 600, lastPlayed: NOW - 10 * DAY }),
  ];
  const details = (id) => ({ 5: { genres: ['Racing', 'Indie'], categories: [2] }, 2: { genres: ['RPG'], categories: [1, 38] } })[id] || null;
  const pick = (mood) => suggest({ games, details, mood, seed: 42, now: NOW, count: 5 }).picks.map((p) => p.appid);
  assert.deepStrictEqual(pick('unfinished'), [1]);
  assert.deepStrictEqual(pick('forgotten'), [2]);
  assert.deepStrictEqual(pick('new'), [3]);
  assert.deepStrictEqual(pick('short'), [5]);
  assert.deepStrictEqual(pick('friends'), [2]);
  assert.ok(!pick('any').includes(4), 'das zuletzt gespielte Spiel ist nie dabei');
  assert.deepStrictEqual(suggest({ games, details, seed: 7, now: NOW }).picks, suggest({ games, details, seed: 7, now: NOW }).picks);
  assert.strictEqual(suggest({ games, details, seed: 7, now: NOW, servers: new Set([2]), mood: 'friends' }).picks[0].server, true);
  assert.ok(rng(1)() >= 0 && rng(1)() < 1);
});

test('Statistik: erster Stand bucht nichts, Zunahmen auf den Tag, Kontowechsel, Wochen und Serie', () => {
  const s = {};
  const day = (n) => NOW - n * DAY;
  assert.strictEqual(stats.record(s, { 10: 100 }, { now: day(3), user: 'a' }), 0);
  assert.strictEqual(stats.record(s, { 10: 160, 20: 30 }, { now: day(2), user: 'a' }), 90);
  assert.strictEqual(stats.record(s, { 10: 220, 20: 30 }, { now: day(1), user: 'a' }), 60);
  assert.strictEqual(stats.record(s, { 10: 250 }, { now: day(0), user: 'a' }), 30);
  assert.strictEqual(stats.record(s, { 10: 999999 }, { now: day(0), user: 'a' }), 0, 'mehr als ein Tag auf einmal = Abgleich, nicht gespielt');
  assert.strictEqual(stats.record(s, { 10: 5 }, { now: day(0), user: 'b' }), 0, 'anderes Konto beginnt neu');
  stats.session(s, { appid: 10, start: day(0), end: day(0) + 3600e3 });
  stats.session(s, { appid: 10, start: 5, end: 1 });
  const sum = stats.summary(s, { now: NOW });
  assert.strictEqual(sum.streak, 3);
  assert.strictEqual(sum.top[0].appid, 10);
  assert.strictEqual(sum.top[0].minutes, 150);
  assert.strictEqual(sum.weeks.length, 12);
  assert.strictEqual(sum.weeks.reduce((a, w) => a + w.minutes, 0), 180);
  assert.strictEqual(sum.thisWeek.length, 7);
  assert.strictEqual(sum.sessions.length, 1);
  assert.strictEqual(stats.weekKey(Date.parse('2026-10-21T12:00:00')), '2026-10-19');
});

test('Steam-Links: nur feste Aktionen mit Zahl, Öffnen je System', async () => {
  assert.strictEqual(links.steamUrl('run', 730), 'steam://rungameid/730');
  assert.strictEqual(links.steamUrl('uninstall', '440'), 'steam://uninstall/440');
  assert.strictEqual(links.steamUrl('downloads'), 'steam://open/downloads');
  assert.strictEqual(links.steamUrl('run', '730;calc'), null);
  assert.strictEqual(links.steamUrl('exec', 1), null);
  assert.strictEqual(links.steamUrl('__proto__', 1), null);
  assert.deepStrictEqual(links.opener('steam://x', 'linux'), { cmd: 'xdg-open', args: ['steam://x'] });
  assert.strictEqual(links.opener('C:\\x', 'win32').cmd, 'explorer.exe');
  const seen = [];
  assert.strictEqual(await links.open('steam://open/games', { platform: 'darwin', spawnImpl: (c, a) => { seen.push([c, ...a]); return { on() {}, unref() {} }; } }), true);
  assert.deepStrictEqual(seen, [['open', 'steam://open/games']]);
  assert.strictEqual(await links.open('x', { spawnImpl: () => { throw new Error('nope'); } }), false);
});
