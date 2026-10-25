'use strict';
// Spielebibliothek 2.0: Konten (Steam-Anmeldung per OpenID, Web-API-Schlüssel, itch.io) und weitere Shops (Epic, GOG).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../server/accounts');

const ORIGIN = 'http://127.0.0.1:7780';
const STEAMID = '76561198000000001';

test('OpenID: Adresse zu Steam mit return_to auf den öffentlichen Teil, Antwort nur mit passendem return_to und SteamID', () => {
  const { url, returnTo } = A.openidUrl(ORIGIN, 'abc');
  const q = new URL(url).searchParams;
  assert.strictEqual(new URL(url).origin, 'https://steamcommunity.com');
  assert.strictEqual(q.get('openid.mode'), 'checkid_setup');
  assert.strictEqual(q.get('openid.realm'), ORIGIN);
  assert.strictEqual(returnTo, `${ORIGIN}/api/x/steam/pub/openid?state=abc`);
  const good = { 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login', 'openid.return_to': returnTo, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAMID}`, 'openid.identity': `https://steamcommunity.com/openid/id/${STEAMID}`, 'openid.sig': 'x' };
  assert.strictEqual(A.openidClaim(good, returnTo), STEAMID);
  assert.strictEqual(A.openidClaim({ ...good, 'openid.return_to': 'https://evil.example/' }, returnTo), null, 'fremdes return_to');
  assert.strictEqual(A.openidClaim({ ...good, 'openid.claimed_id': 'https://evil.example/openid/id/1', 'openid.identity': 'https://evil.example/openid/id/1' }, returnTo), null);
  assert.strictEqual(A.openidClaim({ ...good, 'openid.op_endpoint': 'https://evil.example/login' }, returnTo), null);
  const body = A.checkBody({ ...good, state: 'abc' });
  assert.strictEqual(body.get('openid.mode'), 'check_authentication');
  assert.strictEqual(body.get('state'), null, 'nur openid.*');
});

test('Listen der Anbieter: Steam (gekauft), itch.io, Epic-Manifeste, GOG-Registry', () => {
  assert.deepStrictEqual(A.parseOwned({ response: { games: [{ appid: 440, name: 'Team Fortress 2', playtime_forever: 90, rtime_last_played: 1700000000 }, { name: 'kaputt' }] } }), [{ appid: 440, name: 'Team Fortress 2', playtime: 90, lastPlayed: 1700000000000 }]);
  assert.deepStrictEqual(A.parseOwned(null), []);
  assert.deepStrictEqual(A.parseItch({ owned_keys: [{ game: { id: 7, title: 'Celeste Classic', url: 'https://x.itch.io/c', cover_url: 'http://no' } }, {}] }), [{ id: '7', title: 'Celeste Classic', url: 'https://x.itch.io/c', cover: null }]);
  const epic = A.parseEpic([
    JSON.stringify({ AppName: 'Fortnite', DisplayName: 'Fortnite', InstallLocation: 'D:\\Epic\\Fortnite', InstallSize: 123, AppCategories: ['public', 'games'] }),
    JSON.stringify({ AppName: 'UE_5', DisplayName: 'Unreal Engine', AppCategories: ['engines'] }),
    JSON.stringify({ AppName: 'Half', DisplayName: 'Halb fertig', bIsIncompleteInstall: true }),
    '{kaputt',
  ]);
  assert.deepStrictEqual(epic.map((g) => [g.id, g.name, g.size]), [['Fortnite', 'Fortnite', 123]]);
  assert.match(epic[0].launch, /^com\.epicgames\.launcher:\/\/apps\/Fortnite\?action=launch/);
  const reg = ['', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1207658924', '    gameName    REG_SZ    The Witcher', '    path    REG_SZ    C:\\GOG Games\\The Witcher', '', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\1', '    exe    REG_SZ    x.exe'].join('\r\n');
  assert.deepStrictEqual(A.parseGogReg(reg), [{ store: 'gog', id: '1207658924', name: 'The Witcher', dir: 'C:\\GOG Games\\The Witcher', launch: 'goggalaxy://openGameView/1207658924' }]);
});

function setup({ answers = {}, seed = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-acc-'));
  if (seed) fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(seed));
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push([String(url), opts.method || 'GET']);
    const hit = Object.entries(answers).find(([k]) => String(url).startsWith(k));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const v = typeof hit[1] === 'function' ? hit[1](url, opts) : hit[1];
    return { ok: (v.status || 200) < 400, status: v.status || 200, json: async () => v.json, text: async () => v.text || '' };
  };
  const secrets = { seal: (x) => `sealed:${x}`, open: (x) => String(x).replace(/^sealed:/, '') };
  const epicDir = path.join(dir, 'epic'); fs.mkdirSync(epicDir);
  fs.writeFileSync(path.join(epicDir, 'a.item'), JSON.stringify({ AppName: 'Sat', DisplayName: 'Satisfactory', InstallLocation: path.join(dir, 'sat'), AppCategories: ['games'] }));
  const acc = A.createAccounts({ ctx: {}, t: (s) => s }, { dataDir: dir, fetch, secrets, platform: 'win32', epicDir, gogReg: async () => ({ stdout: '' }) });
  return { acc, calls, dir };
}

test('Ablauf: Anmeldung mit Steam (nur mit gültigem state, Steam bestätigt), Schlüssel, gekaufte Spiele, Shops auf dem PC', async () => {
  const { acc, calls, dir } = setup({ answers: {
    'https://steamcommunity.com/openid/login': { text: 'ns:http://specs.openid.net/auth/2.0\nis_valid:true\n' },
    'https://api.steampowered.com/IPlayerService/GetOwnedGames': { json: { response: { games: [{ appid: 440, name: 'TF2', playtime_forever: 5 }, { appid: 570, name: 'Dota 2', playtime_forever: 900, rtime_last_played: 1700000000 }] } } },
    'https://api.steampowered.com/ISteamUser/GetPlayerSummaries': { json: { response: { players: [{ personaname: 'Gabe' }] } } },
  } });
  const { url } = acc.startOpenid(ORIGIN);
  const returnTo = new URL(url).searchParams.get('openid.return_to');
  const state = new URL(returnTo).searchParams.get('state');
  const reply = { state, 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res', 'openid.op_endpoint': 'https://steamcommunity.com/openid/login', 'openid.return_to': returnTo, 'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAMID}`, 'openid.identity': `https://steamcommunity.com/openid/id/${STEAMID}` };
  assert.deepStrictEqual(await acc.finishOpenid({ ...reply, state: 'falsch' }), { ok: false, reason: 'expired' });
  assert.deepStrictEqual(await acc.finishOpenid(reply), { ok: true, steamid: STEAMID });
  assert.deepStrictEqual(await acc.finishOpenid(reply), { ok: false, reason: 'expired' }, 'state nur einmal');
  assert.ok(calls.some(([u, m]) => u === 'https://steamcommunity.com/openid/login' && m === 'POST'), 'Steam hat bestätigt');
  assert.throws(() => acc.setSteamKey('kurz'), /Steam Web API key/);
  await acc.setSteamKey('A'.repeat(32));
  assert.strictEqual(acc.read().steam.key, `sealed:${'A'.repeat(32)}`, 'Schlüssel nur versiegelt');
  const v = await acc.view([440]);
  assert.deepStrictEqual(v.steam, { connected: true, steamid: STEAMID, persona: 'Gabe', hasKey: true, games: 2, at: v.steam.at, error: null, errorAuth: false });
  assert.deepStrictEqual(v.owned.map((g) => g.appid), [570], 'installierte stehen nicht doppelt');
  assert.deepStrictEqual(v.others.map((g) => [g.store, g.name, g.hasDir]), [['epic', 'Satisfactory', true]]);
  assert.ok(!JSON.stringify(v).includes('sealed:'), 'kein Schlüssel an die Oberfläche');
  assert.ok(!JSON.stringify(v).includes(dir), 'keine Pfade an die Oberfläche');
  acc.disconnect('steam');
  assert.strictEqual((await acc.view([])).steam.connected, false);
});

test('Ablauf: itch.io über mehrere Seiten; abgelehnter Steam-Schlüssel steht als Fehler da, ohne Absturz', async () => {
  const pages = { 1: Array.from({ length: 50 }, (_, i) => ({ game: { id: i + 1, title: `G${i + 1}` } })), 2: [{ game: { id: 99, title: 'Letztes' } }] };
  const { acc } = setup({
    seed: { steam: { steamid: STEAMID }, itch: {} },
    answers: {
      'https://api.itch.io/profile/owned-keys': (url) => ({ json: { owned_keys: pages[new URL(url).searchParams.get('page')] || [] } }),
      'https://api.itch.io/profile': { json: { user: { display_name: 'Leaf' } } },
      'https://api.steampowered.com/': { status: 403, json: {} },
    },
  });
  await acc.setItchKey('k'.repeat(32));
  const v = await acc.view([]);
  assert.deepStrictEqual([v.itch.user, v.itch.games], ['Leaf', 51]);
  assert.strictEqual(v.others.filter((g) => g.store === 'itch').length, 51);
  await acc.setSteamKey('B'.repeat(32));
  const st = (await acc.view([])).steam;
  assert.strictEqual(st.errorAuth, true);
  assert.match(st.error, /does not accept the key/);
});
