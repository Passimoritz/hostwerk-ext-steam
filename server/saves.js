'use strict';
/*
 * Spielstand-Sicherung – Zeitmaschine je Spiel, im eigenen Datenordner:
 *
 *   saves/<appid>/blobs/<sha1>          Inhalt jeder Datei genau einmal (unveränderte Dateien kosten keinen Platz)
 *   saves/<appid>/snaps/<stamp>.json    Stand: { appid, name, t, reason, files: [{ src, sha1, size, mtime }], bytes }
 *
 * reason: session (nach dem Spielen, automatisch) · manual · before-restore (Vorab-Sicherung vor dem Zurückspielen).
 * Unverändert seit dem letzten Stand → kein neuer Stand. Zurückspielen überschreibt nur Dateien, die im Stand stehen
 * (nichts wird gelöscht) und sichert vorher den aktuellen Zustand. Läuft das Spiel gerade, wird nicht zurückgespielt.
 * Aufräumen: automatische Stände je Spiel höchstens keep (Standard 15), Vorab-Sicherungen 3, manuelle bleiben.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^(\d{1,10})~(\d{8}-\d{6}(?:-\d{1,3})?)$/;
const stamp = (t) => new Date(t).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function sha1File(file) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

class SaveStore {
  /** { dir, now, keep, keepBefore, maxBytes } */
  constructor({ dir, now = () => Date.now(), keep = 15, keepBefore = 3, maxBytes = 2 * 1024 ** 3 } = {}) {
    Object.assign(this, { dir, now, keep, keepBefore, maxBytes });
  }
  gameDir(appid) { return path.join(this.dir, String(Number(appid))); }
  snapsDir(appid) { return path.join(this.gameDir(appid), 'snaps'); }
  blob(appid, sha) { return path.join(this.gameDir(appid), 'blobs', sha.slice(0, 2), sha); }

  /** Stände eines Spiels (neueste zuerst) oder aller Spiele */
  list(appid = null) {
    const ids = appid != null ? [String(Number(appid))] : (() => { try { return fs.readdirSync(this.dir).filter((d) => /^\d+$/.test(d)); } catch { return []; } })();
    const out = [];
    for (const a of ids) {
      let files = [];
      try { files = fs.readdirSync(this.snapsDir(a)).filter((f) => /^\d{8}-\d{6}(-\d{1,3})?\.json$/.test(f)); } catch { continue; }
      for (const f of files) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(this.snapsDir(a), f), 'utf8'));
          out.push({ id: `${a}~${f.replace(/\.json$/, '')}`, appid: Number(a), name: s.name, t: s.t, reason: s.reason, count: s.files.length, bytes: s.bytes, newBytes: s.newBytes || 0 });
        } catch { /* kaputt – übergehen */ }
      }
    }
    return out.sort((x, y) => y.t - x.t);
  }

  read(id) {
    const m = ID_RE.exec(String(id || ''));
    if (!m) throw Object.assign(new Error('Backup not found'), { status: 404 });
    const f = path.join(this.snapsDir(m[1]), `${m[2]}.json`);
    try { return { appid: Number(m[1]), file: f, snap: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch { throw Object.assign(new Error('Backup not found'), { status: 404 }); }
  }

  /**
   * Neuen Stand anlegen aus Dateiliste [{ file, size, mtime }] → { created, id?, unchanged?, bytes, newBytes, count }
   * Zu groß (maxBytes) → Fehler, damit nicht still ein halber Stand entsteht.
   */
  create({ appid, name, files, reason = 'manual' }) {
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    if (total > this.maxBytes) throw Object.assign(new Error('The saves are larger than the limit for one backup.'), { status: 413, bytes: total });
    if (!files.length) return { created: false, empty: true, bytes: 0, count: 0 };
    const entries = [];
    let newBytes = 0;
    for (const f of files) {
      let sha;
      try { sha = sha1File(f.file); } catch { continue; } // gerade gesperrt oder weg – überspringen
      const b = this.blob(appid, sha);
      if (!fs.existsSync(b)) {
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(f.file, `${b}.part`);
        fs.renameSync(`${b}.part`, b);
        newBytes += f.size || 0;
      }
      entries.push({ src: f.file, sha1: sha, size: f.size || 0, mtime: f.mtime || null });
    }
    const last = this.list(appid)[0];
    if (last && reason !== 'before-restore') {
      const prev = this.read(last.id).snap;
      const sig = (arr) => arr.map((e) => `${e.src}\u0000${e.sha1}`).sort().join('\n');
      if (sig(prev.files) === sig(entries)) return { created: false, unchanged: true, id: last.id, bytes: total, count: entries.length };
    }
    let st = stamp(this.now());
    fs.mkdirSync(this.snapsDir(appid), { recursive: true });
    for (let n = 1; fs.existsSync(path.join(this.snapsDir(appid), `${st}.json`)); n++) st = `${stamp(this.now())}-${n}`;
    const snap = { appid: Number(appid), name, t: this.now(), reason, files: entries, bytes: entries.reduce((s, e) => s + e.size, 0), newBytes };
    fs.writeFileSync(path.join(this.snapsDir(appid), `${st}.json`), JSON.stringify(snap));
    this.prune(appid);
    return { created: true, id: `${Number(appid)}~${st}`, bytes: snap.bytes, newBytes, count: entries.length };
  }

  /** Alte automatische Stände wegräumen, dann Inhalte ohne Verweis löschen */
  prune(appid) {
    const all = this.list(appid);
    const drop = [
      ...all.filter((s) => s.reason === 'session').slice(this.keep),
      ...all.filter((s) => s.reason === 'before-restore').slice(this.keepBefore),
    ];
    for (const s of drop) { try { fs.rmSync(this.read(s.id).file, { force: true }); } catch { /* weg */ } }
    if (drop.length) this.gc(appid);
    return drop.length;
  }

  remove(id) {
    const { appid, file } = this.read(id);
    fs.rmSync(file, { force: true });
    this.gc(appid);
  }

  /** Inhalte löschen, auf die kein Stand mehr zeigt */
  gc(appid) {
    const keep = new Set();
    for (const s of this.list(appid)) { try { for (const e of this.read(s.id).snap.files) keep.add(e.sha1); } catch { /* weg */ } }
    const bdir = path.join(this.gameDir(appid), 'blobs');
    let removed = 0;
    let subs = [];
    try { subs = fs.readdirSync(bdir); } catch { return 0; }
    for (const sub of subs) {
      let items = [];
      try { items = fs.readdirSync(path.join(bdir, sub)); } catch { continue; }
      for (const b of items) if (!keep.has(b)) { fs.rmSync(path.join(bdir, sub, b), { force: true }); removed++; }
    }
    return removed;
  }

  /** Belegter Platz eines Spiels (Inhalte) */
  usage(appid) {
    const bdir = path.join(this.gameDir(appid), 'blobs');
    let bytes = 0;
    try { for (const sub of fs.readdirSync(bdir)) for (const b of fs.readdirSync(path.join(bdir, sub))) { try { bytes += fs.statSync(path.join(bdir, sub, b)).size; } catch { /* weg */ } } } catch { /* leer */ }
    return bytes;
  }

  /**
   * Zurückspielen: current() liefert die aktuelle Dateiliste (für die Vorab-Sicherung) – dann jede Datei des Stands an
   * ihren Ort kopieren. → { restored, before }
   */
  restore(id, { current, isRunning = () => false } = {}) {
    const { appid, snap } = this.read(id);
    if (isRunning(appid)) throw Object.assign(new Error('The game is running – close it first, then restore.'), { status: 409 });
    let before = null;
    if (typeof current === 'function') {
      const files = current();
      if (files && files.length) before = this.create({ appid, name: snap.name, files, reason: 'before-restore' });
    }
    let restored = 0;
    for (const e of snap.files) {
      const b = this.blob(appid, e.sha1);
      if (!fs.existsSync(b)) continue;
      fs.mkdirSync(path.dirname(e.src), { recursive: true });
      const tmp = `${e.src}.hostwerk-restore`;
      fs.copyFileSync(b, tmp);
      fs.renameSync(tmp, e.src);
      if (e.mtime) { try { fs.utimesSync(e.src, new Date(), new Date(e.mtime)); } catch { /* egal */ } }
      restored++;
    }
    return { restored, before: before && before.id ? before.id : null };
  }

  /** Stand als Ordner ausgeben (externe Sicherung): <out>/<Laufwerk>/<Pfad> */
  materialize(id, out) {
    const { appid, snap } = this.read(id);
    let n = 0;
    for (const e of snap.files) {
      const rel = e.src.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1').replace(/^\/+/, '');
      if (rel.split('/').includes('..')) continue;
      const dest = path.join(out, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try { fs.copyFileSync(this.blob(appid, e.sha1), dest); n++; } catch { /* Inhalt fehlt */ }
    }
    fs.writeFileSync(path.join(out, 'hostwerk-saves.json'), JSON.stringify({ appid, name: snap.name, t: snap.t, files: snap.files.map((e) => ({ src: e.src, size: e.size })) }, null, 1));
    return n;
  }
}

module.exports = { SaveStore, sha1File, ID_RE, stamp };
