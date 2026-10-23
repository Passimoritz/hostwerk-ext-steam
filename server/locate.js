'use strict';
/*
 * Steam auf diesem Rechner finden – ohne Anmeldung, nur lesend.
 *
 *   Windows: Registry (HKCU\Software\Valve\Steam → SteamPath, HKLM … → InstallPath), dann die üblichen Ordner
 *   Linux:   ~/.steam/steam (Verweis), ~/.local/share/Steam, Flatpak (~/.var/app/com.valvesoftware.Steam/…), Snap
 *   macOS:   ~/Library/Application Support/Steam
 * Gültig ist ein Ordner mit steamapps/ (oder config/libraryfolders.vdf). Ein eigener Ordner aus den Einstellungen
 * steht immer vorn. Der Laufzustand (läuft Steam, welches Spiel gerade) kommt aus derselben Registry bzw. registry.vdf.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const VDF = require('./vdf');

/** Ausgabe von „reg query <Schlüssel>“ → { Name: Wert } (REG_DWORD als Zahl). */
function parseRegQuery(out) {
  const vals = {};
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s{2,}(\S(?:.*?\S)?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line) || /^\s{2,}(\S(?:.*?\S)?)\s{2,}(REG_\w+)\s*$/.exec(line);
    if (!m) continue;
    const [, name, type, raw = ''] = m;
    vals[name] = /DWORD|QWORD/.test(type) ? Number(raw.trim()) : raw.trim();
  }
  return vals;
}

/** reg query ohne Shell; leere Antwort bei Fehlern (Schlüssel fehlt, kein Windows). */
function regQuery(key, { exec = execFile, timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    try {
      exec('reg', ['query', key], { windowsHide: true, timeout }, (err, stdout) => resolve(err ? {} : parseRegQuery(stdout)));
    } catch { resolve({}); }
  });
}

const isSteamDir = (dir, fsx = fs) => {
  try { return !!dir && (fsx.existsSync(path.join(dir, 'steamapps')) || fsx.existsSync(path.join(dir, 'config', 'libraryfolders.vdf'))); } catch { return false; }
};

/** Kandidaten in der Reihenfolge, in der sie geprüft werden (ohne Dateizugriff – testbar). */
function candidates({ platform = process.platform, env = process.env, home = os.homedir(), reg = {}, custom = '' } = {}) {
  const out = [];
  if (custom) out.push({ dir: custom, source: 'custom' });
  if (platform === 'win32') {
    if (reg.SteamPath) out.push({ dir: path.win32.normalize(reg.SteamPath), source: 'registry' });
    if (reg.InstallPath) out.push({ dir: path.win32.normalize(reg.InstallPath), source: 'registry' });
    const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles || 'C:\\Program Files';
    out.push({ dir: path.win32.join(pf86, 'Steam'), source: 'default' }, { dir: path.win32.join(pf, 'Steam'), source: 'default' });
  } else if (platform === 'darwin') {
    out.push({ dir: path.posix.join(home, 'Library', 'Application Support', 'Steam'), source: 'default' });
  } else {
    const xdg = env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share');
    out.push(
      { dir: path.posix.join(home, '.steam', 'steam'), source: 'default' },
      { dir: path.posix.join(xdg, 'Steam'), source: 'default' },
      { dir: path.posix.join(home, '.steam', 'root'), source: 'default' },
      { dir: path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'), source: 'flatpak' },
      { dir: path.posix.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam'), source: 'snap' },
    );
  }
  // Doppelte (gleicher Ordner, andere Schreibweise) nur einmal
  const seen = new Set();
  return out.filter((c) => { const k = c.dir.toLowerCase().replace(/[\\/]+$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Steam-Ordner finden → { root, source, platform } oder null.
 * io: { platform, env, home, fs, reg: async () => ({ SteamPath, InstallPath }), custom }
 */
async function findSteam(io = {}) {
  const platform = io.platform || process.platform;
  const fsx = io.fs || fs;
  let reg = {};
  if (platform === 'win32') {
    reg = io.reg ? await io.reg() : { ...(await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam')), ...(await regQuery('HKCU\\Software\\Valve\\Steam')) };
  }
  for (const c of candidates({ platform, env: io.env || process.env, home: io.home || os.homedir(), reg, custom: io.custom })) {
    let dir = c.dir;
    try { dir = fsx.realpathSync(dir); } catch { /* Verweis kaputt oder Ordner fehlt – unten geprüft */ }
    if (isSteamDir(dir, fsx)) return { root: dir, source: c.source, platform };
  }
  return null;
}

/**
 * Läuft Steam, und welches Spiel gerade? → { running, pid, appId }
 * Windows: HKCU\Software\Valve\Steam (RunningAppID) + \ActiveProcess (pid). Linux/macOS: ~/.steam/registry.vdf und steam.pid.
 * io: { platform, reg(key), fs, home, alive(pid) }
 */
async function runState(io = {}) {
  const platform = io.platform || process.platform;
  const alive = io.alive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  if (platform === 'win32') {
    const q = io.reg || regQuery;
    const main = await q('HKCU\\Software\\Valve\\Steam');
    const act = await q('HKCU\\Software\\Valve\\Steam\\ActiveProcess');
    const pid = Number(act.pid) || 0;
    const running = pid > 0 && alive(pid);
    return { running, pid: running ? pid : 0, appId: running ? Number(main.RunningAppID) || 0 : 0 };
  }
  const fsx = io.fs || fs;
  const home = io.home || os.homedir();
  let appId = 0;
  try {
    const reg = VDF.parse(fsx.readFileSync(path.join(home, '.steam', 'registry.vdf'), 'utf8'));
    appId = VDF.num(VDF.get(reg, 'Registry', 'HKCU', 'Software', 'Valve', 'Steam', 'RunningAppID'), 0);
  } catch { /* keine Datei */ }
  let pid = 0;
  try { pid = Number(String(fsx.readFileSync(path.join(home, '.steam', 'steam.pid'), 'utf8')).trim()) || 0; } catch { /* keine Datei */ }
  const running = pid > 0 && alive(pid);
  return { running, pid: running ? pid : 0, appId: running ? appId : 0 };
}

module.exports = { findSteam, candidates, parseRegQuery, regQuery, runState, isSteamDir };
