'use strict';
/*
 * Steam-Links und Ordner öffnen – die einzigen Programme, die die Erweiterung startet, und nur auf ausdrücklichen Klick:
 *
 *   steam://…  geht an Steam selbst (Steams eigener Dialog fragt beim Deinstallieren nach). Nur eine feste Liste von
 *              Aktionen mit Zahl als Ziel – nie ein freier Link. Hostwerks „Link öffnen“ erlaubt nur http(s), darum
 *              öffnet der Server-Teil den Link mit dem Programm, das das System dafür vorsieht.
 *   Ordner     nur Ordner, die die Erweiterung selbst ermittelt hat (Bibliothek, Reste, Screenshots, Spielstände) –
 *              die Oberfläche schickt eine Kennung, nie einen Pfad.
 * Steam-Links wirken auf dem PC, auf dem Hostwerk läuft (von unterwegs ohne Wirkung – die Oberfläche sagt das).
 */
const { spawn } = require('child_process');

const ACTIONS = {
  run: (id) => `steam://rungameid/${id}`,
  details: (id) => `steam://nav/games/details/${id}`,
  uninstall: (id) => `steam://uninstall/${id}`,
  install: (id) => `steam://install/${id}`,
  validate: (id) => `steam://validate/${id}`,
  store: (id) => `steam://store/${id}`,
  screenshots: (id) => `steam://open/screenshots/${id}`,
  downloads: () => 'steam://open/downloads',
  library: () => 'steam://open/games',
};

/** Aktion + Steam-ID → steam://-Link oder null */
function steamUrl(action, appid) {
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!fn) return null;
  if (fn.length === 0) return fn();
  const id = Number(appid);
  if (!Number.isInteger(id) || id <= 0 || id > 1e10) return null;
  return fn(id);
}

/** Programm, das Links/Ordner mit der Standard-Anwendung öffnet – je System */
function opener(target, platform = process.platform) {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [target] };
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  return { cmd: 'xdg-open', args: [target] };
}

/** Öffnen, ohne zu warten; spawnImpl für Tests */
function open(target, { platform = process.platform, spawnImpl = spawn } = {}) {
  const { cmd, args } = opener(target, platform);
  return new Promise((resolve) => {
    try {
      const p = spawnImpl(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
      if (p && typeof p.on === 'function') p.on('error', () => resolve(false));
      if (p && typeof p.unref === 'function') p.unref();
      setTimeout(() => resolve(true), 50);
    } catch { resolve(false); }
  });
}

module.exports = { steamUrl, open, opener, ACTIONS };
