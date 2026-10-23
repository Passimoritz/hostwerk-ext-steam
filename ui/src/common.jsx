import { useState } from 'react';
import { post, apiUrl, fmtBytes } from '@hostwerk/api';
import { toast, promptDialog, Modal } from '@hostwerk/ui';
import * as HUI from '@hostwerk/ui';
import { LazyImg } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';

/* Steam & Spiele – gemeinsame Bausteine der Oberfläche (Bilder, Zeitangaben, Steam-Links, Server starten). */

export const BASE = '#/ext/steam';
export const go = (tab) => { location.hash = `${BASE.slice(1)}${tab && tab !== 'library' ? `/${tab}` : ''}`; };

// Neue Kern-Bausteine („ohne Scrollen“) mit Rückfall für Hostwerk-Versionen ohne sie
export const Sheet = HUI.SideSheet || Modal;
export const useRemembered = HUI.useRemembered || ((k, init) => useState(init)); // eslint-disable-line react-hooks/rules-of-hooks
export function StatBar({ items, label, className = '' }) {
  if (HUI.StatBar) return <HUI.StatBar items={items} label={label} className={className} />;
  return (
    <div className={`row-tight st-statbar ${className}`} role="group" aria-label={label}>
      {items.filter(Boolean).map((x, i) => {
        const inner = <>{x.icon && <x.icon size={14} aria-hidden="true" />}<span className="muted">{x.label}</span> <b>{x.value}</b></>;
        return x.onClick ? <button key={i} type="button" className={`chip-toggle ${x.active ? 'on' : ''}`} aria-pressed={!!x.active} onClick={x.onClick} title={x.title}>{inner}</button> : <span key={i} className="pill" title={x.title}>{inner}</span>;
      })}
    </div>
  );
}

/** Initialen auf einer Farbe aus dem Namen – nie eine leere graue Fläche */
export function Monogram({ name, className = '' }) {
  const words = String(name || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0; for (const ch of String(name || '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className={`st-mono ${className}`} style={{ '--h': h }} aria-hidden="true">{letters}</span>;
}

/** Bild eines Spiels: Steams eigener Zwischenspeicher, sonst Steams CDN (über Hostwerks Bildspeicher), sonst Initialen */
export function Art({ appid, name, kind = 'portrait', className = '' }) {
  const cls = `st-art st-art-${kind} ${className}`;
  return <LazyImg src={apiUrl(`/api/steam/art/${appid}?kind=${kind}`)} className={cls} fit={kind === 'logo' ? 'contain' : 'cover'} alt="" fallback={kind === 'logo' ? null : <Monogram name={name} className={cls} />} />;
}

/** Minuten → „12 h“ / „45 min“ */
export function hours(min) {
  const m = Number(min) || 0;
  if (m < 60) return t('{n} min', { n: m });
  const h = m / 60;
  return t('{n} h', { n: h >= 10 ? Math.round(h) : Math.round(h * 10) / 10 });
}

/** Zeitpunkt → „heute“, „gestern“, „vor 5 Tagen“, „vor 3 Monaten“ */
export function ago(ts) {
  if (!ts) return t('never');
  const d = Math.floor((Date.now() - ts) / 86400e3);
  if (d <= 0) return t('today');
  if (d === 1) return t('yesterday');
  if (d < 45) return t('{n} days ago', { n: d });
  if (d < 600) return t('{n} months ago', { n: Math.round(d / 30) });
  return t('{n} years ago', { n: Math.round(d / 365) });
}

export const gb = (b) => fmtBytes(b || 0);

/** Preis in Cent → „19,99 €“ (Währung von Steam) */
export function money(cents, currency) {
  if (cents == null) return '–';
  try { return new Intl.NumberFormat(document.documentElement.lang || undefined, { style: 'currency', currency: currency || 'EUR' }).format(cents / 100); } catch { return `${(cents / 100).toFixed(2)} ${currency || ''}`; }
}

/** steam://-Aktion über den Server-Teil (Steam auf dem PC, auf dem Hostwerk läuft) */
export async function steam(action, appid) {
  try { await post('/steam/open', { action, appid }); return true; } catch (e) { toast.error(e.message); return false; }
}
/** Ordner im Explorer/Dateimanager öffnen – nur Ordner, die der Server-Teil kennt */
export async function openFolder(kind, id) {
  try { await post('/steam/folder', { kind, id }); } catch (e) { toast.error(e.message); }
}

/** Eigenen Server über die Erweiterung „Spiele-Server“ einrichten (SteamCMD) – fragt nach dem Namen */
export async function startServer(game) {
  const s = game.server;
  if (!s || !s.tool) return;
  if (s.tool.login) { toast.warn(t('This server tool needs a Steam account that owns the game – Hostwerk only uses the anonymous login.')); return; }
  const r = await promptDialog({ title: t('Own server for {name}', { name: game.name }), label: t('Name of the server'), value: `${game.name}`, confirm: t('Set up server') });
  const name = r && typeof r === 'object' ? r.value : r;
  if (!name) return;
  try {
    const out = await post('/games', { method: 'steam', appid: s.tool.appid, name: String(name).slice(0, 60) });
    toast.success(t('Server is being set up'));
    if (out && out.id) location.hash = `/ext/game-servers/${out.id}`;
  } catch (e) { toast.error(e.message); }
}

export const STATE_TEXT = (g) => (g.running ? t('Running') : g.busy ? (g.download && g.download.pct != null ? t('Updating · {pct} %', { pct: g.download.pct }) : t('Updating …')) : g.paused ? t('Update paused') : g.broken ? t('Files missing') : g.updatePending ? t('Update ready') : null);
