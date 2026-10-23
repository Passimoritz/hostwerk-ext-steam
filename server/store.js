'use strict';
/*
 * Steam-Shop ohne Schlüssel: Preise, Rabatte und Angaben zu Spielen – für Merkliste, Preisalarm, Preisverlauf,
 * Bibliothekswert und „Was spiele ich heute?“ (Genres, Kurzbeschreibung).
 *
 *   Preise:   store.steampowered.com/api/appdetails?appids=1,2,3&filters=price_overview – viele Spiele in EINER Abfrage
 *   Angaben:  …/appdetails?appids=<id> (Genres, Kategorien, Erscheinungsdatum) – je Spiel, 30 Tage gemerkt
 *   Suche:    …/api/storesearch/?term=… – zum Hinzufügen zur Merkliste
 *   Wunschliste: api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=… – nur öffentliche Wunschlisten, ohne Schlüssel
 * Steam begrenzt Abfragen ohne Schlüssel (rund 200 je 5 Minuten): Hostwerk fragt gedrosselt (1,5 s Abstand), höchstens
 * 25 Einzelangaben je Lauf, Preise zweimal am Tag. Offline-Modus: nichts wird gefragt, der letzte Stand bleibt.
 * Preisverlauf: nur Änderungen werden gespeichert (höchstens 200 Punkte je Spiel).
 */
const fs = require('fs');
const path = require('path');

const STORE = 'https://store.steampowered.com';
const API = 'https://api.steampowered.com';
const DETAILS_AGE = 30 * 24 * 3600e3;
const PRICE_AGE = 11 * 3600e3;
const MAX_POINTS = 200;
const BATCH = 80;

const COUNTRIES = ['DE', 'AT', 'CH', 'NL', 'FR', 'IT', 'ES', 'PL', 'GB', 'US', 'CA', 'AU'];

class Shop {
  /** { dataDir, fetch, offline, now, sleep, gap } */
  constructor({ dataDir, fetch = (...a) => globalThis.fetch(...a), offline = () => false, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gap = 1500 } = {}) {
    Object.assign(this, { dataDir, fetch, offline, now, sleep, gap });
    this.mem = null;
    this.lastAt = 0;
    this.blockedUntil = 0;
  }
  get file() { return path.join(this.dataDir, 'shop.json'); }
  load() {
    if (!this.mem) { try { this.mem = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.mem = {}; } }
    const m = this.mem;
    m.watch = Array.isArray(m.watch) ? m.watch : [];
    m.prices = m.prices || {}; // appid → { cc, final, initial, discount, currency, formatted, at, free, lowest }
    m.history = m.history || {}; // appid → [[t, final, discount]]
    m.details = m.details || {}; // appid → { at, name, genres, categories, short, release, type, ok }
    m.notified = m.notified || {}; // appid → "final|discount"
    return m;
  }
  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.mem));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch { /* nur Zwischenspeicher */ }
  }

  /** Gedrosselte Abfrage → JSON oder null. 429/403 → 15 Minuten Pause. */
  async getJson(url) {
    if (this.offline()) return null;
    if (this.now() < this.blockedUntil) return null;
    const wait = this.lastAt + this.gap - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastAt = this.now();
    try {
      const r = await this.fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Hostwerk Steam extension' }, signal: AbortSignal.timeout(15000) });
      if (r.status === 429 || r.status === 403) { this.blockedUntil = this.now() + 15 * 60e3; return null; }
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  /* ---------- Merkliste ---------- */
  watchlist() { return this.load().watch; }
  addWatch({ appid, name, target = null }) {
    const id = Number(appid);
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Invalid app'), { status: 400 });
    const m = this.load();
    if (m.watch.length >= 300) throw Object.assign(new Error('The watchlist is full (300 games).'), { status: 400 });
    let w = m.watch.find((x) => x.appid === id);
    if (!w) { w = { appid: id, name: String(name || `App ${id}`).slice(0, 120), added: this.now(), target: null }; m.watch.push(w); }
    if (target !== undefined) w.target = target == null || target === '' ? null : Math.max(0, Math.round(Number(target)));
    this.save();
    return w;
  }
  removeWatch(appid) { const m = this.load(); m.watch = m.watch.filter((x) => x.appid !== Number(appid)); delete m.notified[Number(appid)]; this.save(); }

  /* ---------- Preise ---------- */
  /** Preise vieler Spiele aktualisieren (nur fällige, außer force) → Liste der geänderten appids */
  async refreshPrices(ids, { cc = 'DE', force = false } = {}) {
    const m = this.load();
    const due = [...new Set(ids.map(Number).filter(Boolean))].filter((id) => force || !m.prices[id] || m.prices[id].cc !== cc || this.now() - m.prices[id].at > PRICE_AGE);
    const changed = [];
    for (let i = 0; i < due.length; i += BATCH) {
      const part = due.slice(i, i + BATCH);
      const j = await this.getJson(`${STORE}/api/appdetails?appids=${part.join(',')}&cc=${encodeURIComponent(cc)}&filters=price_overview`);
      if (!j) break;
      for (const id of part) {
        const r = j[id] || j[String(id)];
        if (!r) continue;
        const po = r.success && r.data && !Array.isArray(r.data) ? r.data.price_overview : null;
        const prev = m.prices[id];
        const p = po
          ? { cc, final: po.final, initial: po.initial, discount: po.discount_percent || 0, currency: po.currency, formatted: po.final_formatted, initialFormatted: po.initial_formatted, at: this.now(), free: false }
          : { cc, final: 0, initial: 0, discount: 0, currency: null, formatted: null, at: this.now(), free: !!r.success, unavailable: !r.success };
        p.lowest = prev && prev.cc === cc && prev.lowest != null && !p.free ? Math.min(prev.lowest, p.final) : p.final;
        m.prices[id] = p;
        if (po) {
          const h = m.history[id] || (m.history[id] = []);
          const last = h[h.length - 1];
          if (!last || last[1] !== p.final || last[2] !== p.discount) { h.push([this.now(), p.final, p.discount]); if (h.length > MAX_POINTS) h.splice(0, h.length - MAX_POINTS); changed.push(id); }
        }
      }
    }
    this.save();
    return changed;
  }

  /**
   * Was ist melde-würdig? (Merkliste) → [{ appid, name, final, discount, formatted, why: 'sale'|'target'|'lowest' }]
   * Je Angebot nur einmal: gemerkt als „Preis|Rabatt“. Endet das Angebot, darf das nächste wieder melden.
   */
  alerts() {
    const m = this.load();
    const out = [];
    for (const w of m.watch) {
      const p = m.prices[w.appid];
      if (!p || p.free || p.unavailable) continue;
      const sig = `${p.final}|${p.discount}`;
      const target = w.target != null && p.final <= w.target;
      const sale = p.discount > 0;
      const lowestEver = (m.history[w.appid] || []).length > 2 && p.final <= p.lowest && sale;
      if (!sale && !target) { delete m.notified[w.appid]; continue; }
      if (m.notified[w.appid] === sig) continue;
      m.notified[w.appid] = sig;
      out.push({ appid: w.appid, name: w.name, final: p.final, discount: p.discount, formatted: p.formatted, why: target ? 'target' : lowestEver ? 'lowest' : 'sale' });
    }
    if (out.length) this.save();
    return out;
  }

  /* ---------- Angaben (Genres usw.) ---------- */
  async refreshDetails(ids, { lang = 'english', max = 25 } = {}) {
    const m = this.load();
    const due = [...new Set(ids.map(Number).filter(Boolean))].filter((id) => !m.details[id] || this.now() - m.details[id].at > DETAILS_AGE).slice(0, max);
    for (const id of due) {
      const j = await this.getJson(`${STORE}/api/appdetails?appids=${id}&l=${encodeURIComponent(lang)}`);
      if (!j) break;
      const r = j[id] || j[String(id)];
      const d = r && r.success && r.data ? r.data : null;
      m.details[id] = d
        ? { at: this.now(), ok: true, name: d.name, type: d.type, short: String(d.short_description || '').slice(0, 400), genres: (d.genres || []).map((g) => g.description).slice(0, 6), categories: (d.categories || []).map((c) => c.id).slice(0, 40), release: d.release_date && d.release_date.date, metacritic: d.metacritic ? d.metacritic.score : null, controller: d.controller_support || null }
        : { at: this.now(), ok: false };
    }
    if (due.length) this.save();
    return due.length;
  }
  details(id) { return this.load().details[Number(id)] || null; }

  /* ---------- Suche und Wunschliste ---------- */
  async search(term, { cc = 'DE', lang = 'english' } = {}) {
    const q = String(term || '').trim().slice(0, 80);
    if (q.length < 2) return [];
    const j = await this.getJson(`${STORE}/api/storesearch/?term=${encodeURIComponent(q)}&l=${encodeURIComponent(lang)}&cc=${encodeURIComponent(cc)}`);
    if (!j || !Array.isArray(j.items)) return null;
    return j.items.filter((x) => x && x.type === 'app').slice(0, 20).map((x) => ({ appid: Number(x.id), name: x.name, final: x.price ? x.price.final : null, initial: x.price ? x.price.initial : null, currency: x.price ? x.price.currency : null }));
  }
  /** Öffentliche Wunschliste → [{ appid, added }] oder null (privat/nicht erreichbar) */
  async wishlist(steamId) {
    if (!/^\d{17}$/.test(String(steamId || ''))) throw Object.assign(new Error('Invalid Steam ID'), { status: 400 });
    const j = await this.getJson(`${API}/IWishlistService/GetWishlist/v1/?steamid=${steamId}`);
    const items = j && j.response && Array.isArray(j.response.items) ? j.response.items : null;
    return items ? items.map((x) => ({ appid: Number(x.appid), added: (Number(x.date_added) || 0) * 1000 || null, priority: x.priority })) : null;
  }

  view() {
    const m = this.load();
    return {
      // Name aus den Shop-Angaben, solange nur „App 123“ bekannt ist (z. B. nach dem Übernehmen der Wunschliste)
      watch: m.watch.map((w) => ({ ...w, name: /^App \d+$/.test(w.name) && m.details[w.appid] && m.details[w.appid].name ? m.details[w.appid].name : w.name, price: m.prices[w.appid] || null, history: (m.history[w.appid] || []).slice(-60), details: m.details[w.appid] || null })),
      blocked: this.now() < this.blockedUntil,
    };
  }
}

/** Bibliothekswert aus gemerkten Preisen → { regular, now, counted, missing, currency } (Cent) */
function libraryValue(ids, prices) {
  let regular = 0; let cur = 0; let counted = 0; let missing = 0; let currency = null;
  for (const id of ids) {
    const p = prices[id];
    if (!p) { missing++; continue; }
    if (p.free || p.unavailable) continue;
    regular += p.initial || p.final || 0;
    cur += p.final || 0;
    counted++;
    currency = currency || p.currency;
  }
  return { regular, now: cur, counted, missing, currency };
}

module.exports = { Shop, libraryValue, COUNTRIES, STORE, API };
