'use strict';
/*
 * Spielebibliothek 2.0 – Konten und weitere Shops. Nur Wege, die die Anbieter selbst vorsehen und die nicht ablaufen:
 *
 *   Steam    „Mit Steam anmelden“ (OpenID 2.0, Steams offizielle Anmeldung – liefert nur die SteamID, nie ein Passwort) und
 *            auf Wunsch ein eigener Web-API-Schlüssel (steamcommunity.com/dev/apikey) → alle gekauften Spiele, auch nicht
 *            installierte, mit Spielzeit. Der Schlüssel läuft nicht ab und lässt sich dort jederzeit widerrufen.
 *   itch.io  eigener API-Schlüssel (itch.io → Einstellungen → API-Schlüssel) → gekaufte Spiele.
 *   Epic     ohne Anmeldung: die Installations-Dateien des Epic Games Launchers auf diesem PC (Manifests\*.item).
 *   GOG      ohne Anmeldung: die Einträge, die GOG Galaxy und die Installer in der Windows-Registry anlegen.
 *
 * Schlüssel liegen nur mit Hostwerks Geheimschlüssel versiegelt in data/steam/accounts.json und gehen nie an die
 * Oberfläche. Listen werden höchstens alle 6 Stunden neu geholt (oder auf Knopfdruck).
 *   GET    /api/steam/accounts                    → { steam, itch, epic, gog, owned, others }
 *   POST   /api/steam/accounts/steam/openid       → { url } – im Browser öffnen; Steam schickt zurück an …/pub/openid
 *   GET    /api/x/steam/pub/openid                (öffentlich, nur mit gültigem, einmaligem state) – Anmeldung prüfen
 *   PUT    /api/steam/accounts/steam/key  { key } · PUT /api/steam/accounts/itch/key { key }
 *   POST   /api/steam/accounts/refresh            · DELETE /api/steam/accounts/:provider
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const NS = 'http://specs.openid.net/auth/2.0';
const SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const CLAIMED = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;
const KEY_RE = /^[A-Za-z0-9]{20,64}$/;
const REFRESH_MS = 6 * 3600000;
const LOCAL_TTL = 10 * 60000;
const PENDING_MS = 10 * 60000;

/* ---------------- reine Hilfen (getestet in tests/accounts.test.js) ---------------- */

/** Adresse für „Mit Steam anmelden“ – return_to zeigt auf den öffentlichen Teil dieser Erweiterung. */
function openidUrl(origin, state) {
  const returnTo = `${origin}/api/x/steam/pub/openid?state=${encodeURIComponent(state)}`;
  const q = new URLSearchParams({ 'openid.ns': NS, 'openid.mode': 'checkid_setup', 'openid.return_to': returnTo, 'openid.realm': origin, 'openid.identity': SELECT, 'openid.claimed_id': SELECT });
  return { url: `${STEAM_OPENID}?${q}`, returnTo };
}

/** Antwort von Steam prüfen (vor der Rückfrage bei Steam): passt return_to, ist claimed_id eine SteamID? → steamid | null */
function openidClaim(query, expectedReturnTo) {
  const q = query || {};
  if (q['openid.mode'] !== 'id_res' || q['openid.ns'] !== NS) return null;
  if (String(q['openid.return_to'] || '') !== expectedReturnTo) return null;
  if (String(q['openid.op_endpoint'] || '') !== STEAM_OPENID) return null;
  const m = CLAIMED.exec(String(q['openid.claimed_id'] || ''));
  if (!m || q['openid.identity'] !== q['openid.claimed_id']) return null;
  return m[1];
}

/** Body für Steams Rückfrage (check_authentication): alle openid.*-Werte, mode ersetzt. */
function checkBody(query) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) if (k.startsWith('openid.')) p.set(k, String(v));
  p.set('openid.mode', 'check_authentication');
  return p;
}

/** GetOwnedGames → [{ appid, name, playtime (min), lastPlayed (ms) }] */
function parseOwned(json) {
  const games = (json && json.response && Array.isArray(json.response.games)) ? json.response.games : [];
  return games.filter((g) => g && Number.isFinite(Number(g.appid))).map((g) => ({
    appid: Number(g.appid), name: String(g.name || `App ${g.appid}`).slice(0, 200),
    playtime: Number(g.playtime_forever) || 0, lastPlayed: g.rtime_last_played ? Number(g.rtime_last_played) * 1000 : null,
  }));
}

/** itch.io owned-keys → [{ id, title, url, cover }] */
function parseItch(json) {
  const list = (json && Array.isArray(json.owned_keys)) ? json.owned_keys : [];
  return list.map((k) => k && k.game).filter((g) => g && g.id).map((g) => ({
    id: String(g.id), title: String(g.title || '').slice(0, 200), url: /^https:\/\//.test(g.url || '') ? g.url : null, cover: /^https:\/\//.test(g.cover_url || '') ? g.cover_url : null,
  }));
}

/** Epic-Manifeste (.item, JSON) → [{ store, id, name, dir, size, launch }] */
function parseEpic(items) {
  const out = [];
  for (const raw of items || []) {
    let j; try { j = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { continue; }
    if (!j || !j.AppName || !j.DisplayName || j.bIsIncompleteInstall) continue;
    if (Array.isArray(j.AppCategories) && j.AppCategories.length && !j.AppCategories.includes('games')) continue; // Plug-ins, Engine …
    out.push({ store: 'epic', id: String(j.AppName), name: String(j.DisplayName).slice(0, 200), dir: j.InstallLocation || null, size: Number(j.InstallSize) || 0, launch: `com.epicgames.launcher://apps/${encodeURIComponent(j.AppName)}?action=launch&silent=true` });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Ausgabe von „reg query …\GOG.com\Games /s“ → [{ store, id, name, dir, launch }] */
function parseGogReg(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const key = /\\GOG\.com\\Games\\(\d+)\s*$/i.exec(line.trim());
    if (key) { cur = { store: 'gog', id: key[1], name: '', dir: null }; out.push(cur); continue; }
    const v = /^\s+(\w+)\s+REG_\w+\s+(.*)$/.exec(line);
    if (cur && v) {
      if (/^gameName$/i.test(v[1])) cur.name = v[2].trim().slice(0, 200);
      if (/^path$/i.test(v[1])) cur.dir = v[2].trim();
    }
  }
  return out.filter((g) => g.name).map((g) => ({ ...g, launch: `goggalaxy://openGameView/${g.id}` })).sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------- Dienst ---------------- */

function createAccounts(host, io = {}) {
  const ctx = host.ctx || {};
  const now = io.now || Date.now;
  const platform = io.platform || process.platform;
  const fetch = io.fetch || globalThis.fetch;
  const file = path.join(io.dataDir || path.join(ctx.paths.data, 'steam'), 'accounts.json');
  const secrets = io.secrets || host.core('secrets');
  const read = () => { try { return { steam: {}, itch: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { return { steam: {}, itch: {} }; } };
  const write = (v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(v)); fs.renameSync(`${file}.tmp`, file); };
  const pending = new Map(); // state → { returnTo, at }

  async function getJson(url, opts = {}) {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': 'Hostwerk', ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error('The provider does not accept the key.'), { auth: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  /* ----- Steam ----- */
  function startOpenid(origin) {
    for (const [k, v] of pending) if (now() - v.at > PENDING_MS) pending.delete(k);
    const state = crypto.randomBytes(16).toString('hex');
    const { url, returnTo } = openidUrl(origin, state);
    pending.set(state, { returnTo, at: now() });
    return { url };
  }
  async function finishOpenid(query) {
    const p = pending.get(String((query || {}).state || ''));
    if (!p || now() - p.at > PENDING_MS) return { ok: false, reason: 'expired' };
    pending.delete(String(query.state));
    const steamid = openidClaim(query, p.returnTo);
    if (!steamid) return { ok: false, reason: 'invalid' };
    // Steam selbst bestätigen lassen, dass die Antwort echt ist
    const r = await fetch(STEAM_OPENID, { method: 'POST', body: checkBody(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Hostwerk' }, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    if (!/is_valid\s*:\s*true/i.test(text)) return { ok: false, reason: 'invalid' };
    const s = read();
    s.steam = { ...s.steam, steamid, connectedAt: now(), error: null };
    write(s);
    await refreshSteam(true).catch(() => {});
    return { ok: true, steamid };
  }
  async function refreshSteam(force = false) {
    const s = read();
    const a = s.steam || {};
    if (!a.steamid || !a.key) return a;
    if (!force && a.at && now() - a.at < REFRESH_MS) return a;
    const key = secrets.open(a.key);
    try {
      const [owned, who] = await Promise.all([
        getJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(key)}&steamid=${a.steamid}&include_appinfo=1&include_played_free_games=1&format=json`),
        getJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(key)}&steamids=${a.steamid}`).catch(() => null),
      ]);
      const p = who && who.response && Array.isArray(who.response.players) ? who.response.players[0] : null;
      s.steam = { ...a, owned: parseOwned(owned), persona: p && p.personaname ? String(p.personaname).slice(0, 80) : a.persona || null, at: now(), error: null, errorAuth: false };
    } catch (e) { s.steam = { ...a, error: e.message, errorAuth: !!e.auth, at: now() }; }
    write(s);
    return s.steam;
  }
  function setSteamKey(k) {
    const key = String(k || '').trim();
    if (!KEY_RE.test(key)) throw Object.assign(new Error('That does not look like a Steam Web API key (32 letters and digits).'), { status: 400 });
    const s = read(); s.steam = { ...s.steam, key: secrets.seal(key), at: null, error: null }; write(s);
    return refreshSteam(true);
  }

  /* ----- itch.io ----- */
  async function refreshItch(force = false) {
    const s = read();
    const a = s.itch || {};
    if (!a.key) return a;
    if (!force && a.at && now() - a.at < REFRESH_MS) return a;
    const key = secrets.open(a.key);
    try {
      const auth = { headers: { Authorization: `Bearer ${key}` } };
      const me = await getJson('https://api.itch.io/profile', auth);
      const owned = [];
      for (let page = 1; page <= 20; page++) {
        const j = await getJson(`https://api.itch.io/profile/owned-keys?page=${page}`, auth);
        const list = parseItch(j);
        owned.push(...list);
        if (list.length < 50) break;
      }
      s.itch = { ...a, user: me && me.user ? String(me.user.display_name || me.user.username || '').slice(0, 80) : null, owned, at: now(), error: null, errorAuth: false };
    } catch (e) { s.itch = { ...a, error: e.message, errorAuth: !!e.auth, at: now() }; }
    write(s);
    return s.itch;
  }
  function setItchKey(k) {
    const key = String(k || '').trim();
    if (!KEY_RE.test(key)) throw Object.assign(new Error('That does not look like an itch.io API key.'), { status: 400 });
    const s = read(); s.itch = { ...s.itch, key: secrets.seal(key), at: null, error: null }; write(s);
    return refreshItch(true);
  }

  /* ----- Epic und GOG: nur lesen, was auf diesem PC liegt ----- */
  let localCache = null;
  async function local(force = false) {
    if (!force && localCache && now() - localCache.at < LOCAL_TTL) return localCache;
    const out = { epic: { found: false, games: [] }, gog: { found: false, games: [] }, at: now() };
    if (platform === 'win32') {
      const dir = io.epicDir || path.join(process.env.ProgramData || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
      try {
        const items = fs.readdirSync(dir).filter((f) => f.endsWith('.item')).slice(0, 2000).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
        out.epic = { found: true, games: parseEpic(items) };
      } catch { /* kein Epic Launcher */ }
      try {
        const reg = io.gogReg ? await io.gogReg() : await host.core('util').exec('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games', '/s'], { timeout: 15000 });
        const games = parseGogReg(reg && (reg.stdout !== undefined ? reg.stdout : reg));
        out.gog = { found: games.length > 0, games };
      } catch { /* kein GOG */ }
    }
    localCache = out;
    return out;
  }

  /** Für die Oberfläche: Zustand je Anbieter (ohne Schlüssel) und die Spiele aus Konten und anderen Shops. */
  async function view(installedAppids = []) {
    const s = read();
    const loc = await local();
    const have = new Set((installedAppids || []).map(String));
    const st = s.steam || {};
    const it = s.itch || {};
    return {
      steam: { connected: !!st.steamid, steamid: st.steamid || null, persona: st.persona || null, hasKey: !!st.key, games: (st.owned || []).length, at: st.at || null, error: st.error || null, errorAuth: !!st.errorAuth },
      itch: { connected: !!it.key, user: it.user || null, games: (it.owned || []).length, at: it.at || null, error: it.error || null, errorAuth: !!it.errorAuth },
      epic: { found: loc.epic.found, games: loc.epic.games.length },
      gog: { found: loc.gog.found, games: loc.gog.games.length },
      // Gekauft, aber nicht installiert (aus dem Steam-Konto)
      owned: (st.owned || []).filter((g) => !have.has(String(g.appid))).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || b.playtime - a.playtime).slice(0, 2000),
      others: [...loc.epic.games, ...loc.gog.games, ...(it.owned || []).map((g) => ({ store: 'itch', id: g.id, name: g.title, url: g.url, cover: g.cover }))].map(({ dir, ...g }) => ({ ...g, hasDir: !!dir })),
    };
  }
  async function find(store, id) {
    const loc = await local();
    return [...loc.epic.games, ...loc.gog.games].find((x) => x.store === store && x.id === String(id)) || null;
  }
  function disconnect(provider) {
    const s = read();
    if (provider === 'steam') s.steam = {};
    else if (provider === 'itch') s.itch = {};
    else throw Object.assign(new Error('Unknown provider'), { status: 400 });
    write(s);
  }
  async function refresh() { localCache = null; await Promise.all([refreshSteam(true), refreshItch(true), local(true)]); }

  return { startOpenid, finishOpenid, refreshSteam, refreshItch, setSteamKey, setItchKey, local, view, find, disconnect, refresh, read };
}

const PAGE = (title, text) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;line-height:1.5}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

/**
 * Routen – svc ist der Dienst der Bibliothek (für die installierten Spiele), open(url) öffnet einen Launcher-Link,
 * openDir(dir) einen Ordner (beides aus server/links.js, nur auf ausdrücklichen Klick).
 */
function mount(host, svc, { open, openDir } = {}) {
  const acc = createAccounts(host);
  const r = host.router;
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e && typeof e.message === 'string') e.message = host.t(e.message); next(e); } };
  const installed = async () => { try { const v = await svc.view(); return (v.games || []).map((g) => g.appid); } catch { return []; } };
  const changed = () => { try { host.broadcast({ type: 'ext-event', id: host.id, event: 'accounts' }); } catch { /* egal */ } };
  r.get('/steam/accounts', wrap(async (req, res) => { acc.refreshSteam().catch(() => {}); acc.refreshItch().catch(() => {}); res.json(await acc.view(await installed())); }));
  r.post('/steam/accounts/steam/openid', wrap(async (req, res) => res.json(acc.startOpenid(`${req.protocol}://${req.get('host')}`))));
  r.put('/steam/accounts/steam/key', wrap(async (req, res) => { await acc.setSteamKey((req.body || {}).key); changed(); res.json(await acc.view(await installed())); }));
  r.put('/steam/accounts/itch/key', wrap(async (req, res) => { await acc.setItchKey((req.body || {}).key); changed(); res.json(await acc.view(await installed())); }));
  r.post('/steam/accounts/refresh', wrap(async (req, res) => { await acc.refresh(); res.json(await acc.view(await installed())); }));
  r.delete('/steam/accounts/:provider', wrap(async (req, res) => { acc.disconnect(req.params.provider); changed(); res.json(await acc.view(await installed())); }));
  // Spiel aus einem anderen Shop starten bzw. seinen Ordner öffnen – nur, was die Erweiterung selbst gefunden hat
  r.post('/steam/accounts/launch', wrap(async (req, res) => {
    const b = req.body || {};
    const g = await acc.find(String(b.store || ''), String(b.id || ''));
    if (!g || typeof open !== 'function') throw Object.assign(new Error('This game cannot be started from here.'), { status: 400 });
    if (b.what === 'folder') { if (!g.dir || typeof openDir !== 'function') throw Object.assign(new Error('No folder known for this game.'), { status: 400 }); await openDir(g.dir); } else await open(g.launch);
    res.json({ ok: true });
  }));
  // Öffentlich: Steam schickt den Browser nach der Anmeldung hierher (nur mit gültigem, einmaligem state)
  host.publicRouter.get('/pub/openid', async (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    let out = { ok: false };
    try { out = await acc.finishOpenid(req.query || {}); } catch { out = { ok: false }; }
    if (out.ok) { changed(); return res.send(PAGE(host.t('Connected with Steam'), host.t('You can close this window – Hostwerk shows your library now.'))); }
    return res.status(400).send(PAGE(host.t('Sign-in did not work'), host.t('The link expired or Steam did not confirm it. Start the sign-in again in Hostwerk.')));
  });
  // Konten alle 6 Stunden auffrischen (nur, wenn verbunden)
  if (!process.env.HW_TEST) {
    const timer = setInterval(() => { acc.refreshSteam().catch(() => {}); acc.refreshItch().catch(() => {}); }, REFRESH_MS);
    if (timer.unref) timer.unref();
    if (typeof host.on === 'function') host.on('shutdown', () => clearInterval(timer));
  }
  return acc;
}

module.exports = { mount, createAccounts, openidUrl, openidClaim, checkBody, parseOwned, parseItch, parseEpic, parseGogReg };
