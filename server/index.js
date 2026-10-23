'use strict';
/*
 * Steam & Spiele – native Erweiterung. Routen und Takt; die Arbeit steckt in service.js und den Modulen daneben.
 * Bietet ctx.steamLibrary an (andere Erweiterungen: installierte Spiele, läuft gerade, ohne Pfade der Spielstände).
 */
const { createService } = require('./service');
const links = require('./links');

function routes(host, svc) {
  const r = host.router;
  // Fehler aus den Modulen (englisch) in der Sprache der Oberfläche weitergeben
  const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { if (e && typeof e.message === 'string') e.message = host.t(e.message); next(e); } };
  r.get('/steam', wrap(async (req, res) => res.json(await svc.view())));
  r.post('/steam/rescan', wrap(async (req, res) => { await svc.scan({ force: true }); await svc.measure(); res.json(await svc.view()); }));
  r.put('/steam/user', wrap(async (req, res) => { svc.setUser((req.body || {}).accountId); res.json(await svc.view()); }));
  r.get('/steam/art/:appid', wrap(async (req, res) => {
    const hit = await svc.art(req.params.appid, String(req.query.kind || 'portrait'));
    if (!hit) return res.status(404).end();
    res.setHeader('Content-Type', hit.type || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return res.sendFile(hit.file);
  }));
  r.get('/steam/doctor', wrap(async (req, res) => res.json(await svc.doctor())));
  r.post('/steam/doctor/measure', wrap(async (req, res) => { await svc.scan({ force: true }); await svc.measure(); res.json(await svc.doctor()); }));

  r.get('/steam/saves', wrap(async (req, res) => res.json(await svc.savesView())));
  r.post('/steam/saves/manifest', wrap(async (req, res) => { const out = await svc.manifest.refresh({ force: true }); res.json({ ...out, state: svc.manifest.state() }); }));
  r.post('/steam/saves/restore', wrap(async (req, res) => res.json(await svc.backupSource.restore(String((req.body || {}).id || '')))));
  r.get('/steam/saves/:appid', wrap(async (req, res) => res.json(await svc.saveDetail(req.params.appid))));
  r.post('/steam/saves/:appid/backup', wrap(async (req, res) => res.json(await svc.backupGame(req.params.appid, 'manual'))));
  r.delete('/steam/saves/:id', wrap(async (req, res) => { svc.store.remove(req.params.id); res.json({ ok: true }); }));

  r.get('/steam/shop', wrap(async (req, res) => res.json(svc.shopView())));
  r.post('/steam/shop/watch', wrap(async (req, res) => {
    const b = req.body || {};
    const w = svc.shop.addWatch({ appid: b.appid, name: b.name, target: b.target });
    await svc.shop.refreshPrices([w.appid], { cc: svc.settings().country, force: true });
    res.json(svc.shopView());
  }));
  r.delete('/steam/shop/watch/:appid', wrap(async (req, res) => { svc.shop.removeWatch(req.params.appid); res.json(svc.shopView()); }));
  r.get('/steam/shop/search', wrap(async (req, res) => {
    const items = await svc.shop.search(req.query.q, { cc: svc.settings().country, lang: host.lang && host.lang() === 'de' ? 'german' : 'english' });
    if (items === null) throw host.error(503, 'The Steam store does not answer right now.');
    res.json({ items });
  }));
  r.post('/steam/shop/wishlist', wrap(async (req, res) => {
    const sid = svc.steamIdOfUser();
    if (!sid) throw host.error(400, 'No Steam account found on this PC.');
    const items = await svc.shop.wishlist(sid);
    if (items === null) throw host.error(409, 'Steam does not share this wishlist – it is probably private. Set “Game details” to public in your Steam privacy settings, or add games by hand.');
    const have = new Set(svc.shop.watchlist().map((w) => w.appid));
    const fresh = items.filter((x) => !have.has(x.appid)).slice(0, 300 - have.size);
    for (const x of fresh) svc.shop.addWatch({ appid: x.appid, name: `App ${x.appid}` });
    await svc.shop.refreshDetails(fresh.map((x) => x.appid), { max: 25 });
    for (const x of fresh) { const d = svc.shop.details(x.appid); if (d && d.name) svc.shop.addWatch({ appid: x.appid, name: d.name }); }
    await svc.shop.refreshPrices(fresh.map((x) => x.appid), { cc: svc.settings().country, force: true });
    res.json({ added: fresh.length, ...svc.shopView() });
  }));
  r.post('/steam/shop/refresh', wrap(async (req, res) => { await svc.shop.refreshPrices(svc.shop.watchlist().map((w) => w.appid), { cc: svc.settings().country, force: true }); res.json(svc.shopView()); }));

  r.get('/steam/stats', wrap(async (req, res) => res.json(await svc.stats())));
  r.get('/steam/picks', wrap(async (req, res) => res.json(await svc.picks(String(req.query.mood || 'any'), Number(req.query.seed) || Date.now()))));
  r.get('/steam/screenshots', wrap(async (req, res) => res.json(await svc.screenshots())));
  r.get('/steam/screenshot/:appid/:file', wrap(async (req, res) => {
    const f = svc.screenshotFile(req.params.appid, req.params.file, req.query.thumb === '1');
    if (!f) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.sendFile(f, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  }));

  r.post('/steam/open', wrap(async (req, res) => {
    const b = req.body || {};
    const url = links.steamUrl(String(b.action || ''), b.appid);
    if (!url) throw host.error(400, 'Unknown Steam action');
    res.json({ ok: await svc.open(url) });
  }));
  r.post('/steam/folder', wrap(async (req, res) => {
    const b = req.body || {};
    const dir = svc.folderFor(String(b.kind || ''), b.id);
    if (!dir) throw host.error(404, 'Folder not found');
    res.json({ ok: await svc.open(dir) });
  }));
}

exports.activate = (host) => {
  const svc = createService(host);
  routes(host, svc);
  // Für andere Erweiterungen (z. B. Discord-Status, Kacheln): nur lesend, ohne Pfade
  try {
    host.provide('steamLibrary', {
      installed: () => (svc.state.lib ? svc.state.lib.games.filter((g) => !g.tool).map((g) => ({ appid: g.appid, name: g.name, playtime: g.playtime, lastPlayed: g.lastPlayed })) : []),
      running: () => ({ ...svc.state.run, name: svc.state.lib && svc.state.run.appId ? (svc.state.lib.games.find((g) => g.appid === svc.state.run.appId) || {}).name || null : null }),
    });
  } catch { /* schon angeboten (zweite Fassung im Entwickler-Modus) */ }
  // Spielstände in der Sicherungs-Zentrale (SDK 2.10) – ältere Hostwerk-Versionen ohne
  let offBackups = null;
  try { if (host.backups && typeof host.backups.register === 'function') offBackups = host.backups.register(svc.backupSource); } catch { /* ohne */ }
  const timers = [];
  if (!process.env.HW_TEST) {
    // Start leise: erst lesen, nach 2 Minuten der langsame Takt (Netz), dann alle 15 s der Zustand von Steam
    setTimeout(() => { svc.scan().catch(() => {}); }, 3000).unref?.();
    timers.push(setTimeout(() => svc.slow().catch(() => {}), 120000));
    timers.push(setInterval(() => svc.slow().catch(() => {}), 30 * 60e3));
    timers.push(setInterval(() => svc.tick().catch(() => {}), 15000));
    for (const t of timers) if (t && typeof t.unref === 'function') t.unref();
  }
  host.on('shutdown', () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } if (offBackups) offBackups(); });
};

exports.deactivate = () => {};
