'use strict';
/*
 * Laufwerke der Steam-Bibliotheken: frei/gesamt (fs.statfs) und – für den Speicher-Doktor – SSD oder HDD.
 *
 *   Windows: EINE PowerShell-Abfrage (Get-Partition → Get-PhysicalDisk.MediaType/BusType), einmal am Tag
 *   Linux:   findmnt/lsblk (ROTA = 1 heißt drehende Platte) – ohne Zusatzprogramme, sonst „unbekannt“
 * Nichts davon braucht Administrator-Rechte. Unbekannt bleibt unbekannt – der Doktor rät dann nicht.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PS = [
  '$ErrorActionPreference = "SilentlyContinue";',
  '$d = @{}; Get-PhysicalDisk | ForEach-Object { $d[[string]$_.DeviceId] = $_ };',
  '$o = @(); Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object { $p = $d[[string]$_.DiskNumber];',
  '$o += [pscustomobject]@{ L = [string]$_.DriveLetter; M = [string]$p.MediaType; B = [string]$p.BusType } };',
  'ConvertTo-Json -Compress -InputObject $o',
].join(' ');

/** Antwort der PowerShell-Abfrage → { 'C': 'ssd' | 'hdd' | null } */
function parseWinMedia(out) {
  const map = {};
  let arr = [];
  try { arr = JSON.parse(String(out || '').trim() || '[]'); } catch { return map; }
  if (!Array.isArray(arr)) arr = [arr];
  for (const x of arr) {
    if (!x || !/^[A-Z]$/i.test(String(x.L || ''))) continue;
    const m = String(x.M || '').toLowerCase();
    const b = String(x.B || '').toLowerCase();
    map[String(x.L).toUpperCase()] = m === 'ssd' || m === '4' || b === 'nvme' || b === '17' ? 'ssd' : m === 'hdd' || m === '3' ? 'hdd' : null;
  }
  return map;
}

/** „lsblk -no ROTA,TYPE“ für ein Gerät → 'ssd' | 'hdd' | null (erste Zeile vom Typ disk, sonst die erste) */
function parseLsblk(out) {
  const rows = String(out || '').trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((r) => r[0] === '0' || r[0] === '1');
  const disk = rows.find((r) => r[1] === 'disk') || rows[0];
  if (!disk) return null;
  return disk[0] === '1' ? 'hdd' : 'ssd';
}

const run = (cmd, args, timeout = 15000) => new Promise((resolve) => {
  try { execFile(cmd, args, { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout))); } catch { resolve(null); }
});

/** Laufwerks-Schlüssel eines Pfads: „C“ unter Windows, sonst der Pfad selbst (Einhängepunkt erst beim Messen) */
const driveKey = (p, platform = process.platform) => (platform === 'win32' ? (/^([a-z]):/i.exec(String(p)) || [])[1]?.toUpperCase() || null : String(p));

/** Frei/gesamt eines Ordners (fs.statfs, Node 18.15+) – null, wenn nicht lesbar */
function space(dir, fsx = fs) {
  try {
    if (typeof fsx.statfsSync !== 'function') return null;
    const s = fsx.statfsSync(dir);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

/**
 * Laufwerke zu Bibliotheksordnern → [{ key, label, paths, free, total, media }]
 * io: { platform, exec(cmd, args) → stdout|null, fs, cache: { at, media } , now }
 */
async function describe(paths, io = {}) {
  const platform = io.platform || process.platform;
  const exec = io.exec || run;
  const fsx = io.fs || fs;
  const out = new Map();
  for (const p of paths) {
    const key = platform === 'win32' ? driveKey(p, platform) || p : p;
    if (!out.has(key)) out.set(key, { key, label: platform === 'win32' && /^[A-Z]$/.test(key) ? `${key}:` : p, paths: [], free: null, total: null, media: null });
    out.get(key).paths.push(p);
  }
  for (const d of out.values()) { const s = space(d.paths[0], fsx); if (s) { d.free = s.free; d.total = s.total; } }
  // SSD/HDD: teuer (PowerShell ~1–2 s) – höchstens einmal am Tag
  const cache = io.cache || {};
  const now = io.now ? io.now() : Date.now();
  if (!cache.media || !cache.at || now - cache.at > 24 * 3600e3) {
    cache.media = {};
    if (platform === 'win32') cache.media = parseWinMedia(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS]));
    else if (platform === 'linux') {
      for (const d of out.values()) {
        const src = (await exec('findmnt', ['-no', 'SOURCE', '--target', d.paths[0]]) || '').trim().split(/\r?\n/)[0];
        if (!/^\/dev\//.test(src)) continue;
        cache.media[d.key] = parseLsblk(await exec('lsblk', ['-no', 'ROTA,TYPE', '-s', src]));
      }
    }
    cache.at = now;
  }
  for (const d of out.values()) d.media = cache.media[d.key] || null;
  return [...out.values()];
}

/** Ordnergröße (rekursiv, Verweise nicht verfolgt) mit Grenze für die Anzahl Einträge – für Shader-Cache & Co. */
function dirSize(dir, { fs: fsx = fs, max = 200000 } = {}) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < max) {
    const d = stack.pop();
    let entries = [];
    try { entries = fsx.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else { try { total += fsx.statSync(p).size; } catch { /* weg */ } }
    }
  }
  return total;
}

module.exports = { describe, parseWinMedia, parseLsblk, driveKey, space, dirSize, PS };
