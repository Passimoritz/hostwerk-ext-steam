import { useMemo, useState } from 'react';
import {
  Search, Play, FolderOpen, Download, Server, Save, ExternalLink, Trash2, Clock, HardDrive, Gamepad2, RefreshCw, ShieldCheck, Store, CircleAlert, Wrench,
} from 'lucide-react';
import { post, fmtDate } from '@hostwerk/api';
import { Btn, Seg, Progress, TileEmpty, toast, confirmDialog } from '@hostwerk/ui';
import { contextMenu } from '@hostwerk/kit';
import { t, pl } from '@hostwerk/i18n';
import { Art, hours, ago, gb, steam, openFolder, startServer, Sheet, StatBar, STATE_TEXT, money, useRemembered, go } from './common';
import { useFill } from './fill';

/* Reiter „Bibliothek“: Kennzahlen, Suche/Sortierung, Cover-Raster (scrollt in sich), Details im Seitenblatt. */

const SORTS = [
  { id: 'recent', label: 'Recently played' },
  { id: 'most', label: 'Most played' },
  { id: 'size', label: 'Size' },
  { id: 'name', label: 'Name' },
];
const sorter = {
  recent: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.name.localeCompare(b.name),
  most: (a, b) => (b.playtime || 0) - (a.playtime || 0),
  size: (a, b) => (b.size || 0) - (a.size || 0),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function gameMenu(e, g, { onOpen, serversAvailable }) {
  contextMenu(e, [
    { label: t('Play'), icon: Play, onClick: () => steam('run', g.appid), disabled: g.busy || g.running },
    { label: t('Details …'), icon: Gamepad2, onClick: onOpen },
    { label: t('Show in Steam'), icon: ExternalLink, onClick: () => steam('details', g.appid) },
    { label: t('Open game folder'), icon: FolderOpen, onClick: () => openFolder('game', g.appid) },
    ...(g.server && serversAvailable ? [{ label: t('Start own server …'), icon: Server, onClick: () => startServer(g) }] : []),
    { label: t('Back up saves now'), icon: Save, onClick: () => backupNow(g) },
    '-',
    { label: t('Uninstall in Steam …'), icon: Trash2, danger: true, onClick: () => uninstall(g) },
  ]);
}

export async function backupNow(g) {
  try {
    const r = await post(`/steam/saves/${g.appid}/backup`);
    if (r.created) toast.success(t('Saves backed up'));
    else if (r.unchanged) toast(t('Nothing changed since the last backup'), 'info');
    else toast(t('No saves found on this PC'), 'info');
  } catch (e) { toast.error(e.message); }
}

export async function uninstall(g) {
  const ok = await confirmDialog({ title: t('Uninstall “{name}”?', { name: g.name }), text: t('Steam opens its own dialog and asks once more. Saves in the Steam Cloud stay; Hostwerk’s backups of the saves stay too.'), confirm: t('Open in Steam') });
  if (ok) steam('uninstall', g.appid);
}

function Tile({ g, onOpen, serversAvailable }) {
  const state = STATE_TEXT(g);
  return (
    <button type="button" className={`st-tile ${g.running ? 'st-tile-live' : ''}`} onClick={onOpen} onContextMenu={(e) => gameMenu(e, g, { onOpen, serversAvailable })} title={g.name} aria-label={`${g.name}${state ? ` – ${state}` : ''}`}>
      <span className="st-tile-art">
        <Art appid={g.appid} name={g.name} />
        {state && <span className={`badge ${g.running ? 'ok' : g.broken ? 'err' : g.busy ? 'info' : 'warn'} st-tile-badge`}>{state}</span>}
        {g.server && serversAvailable && <span className="st-tile-server" title={t('Own server possible')}><Server size={12} aria-hidden="true" /></span>}
        {g.download && g.download.pct != null && <span className="st-tile-progress" style={{ '--p': `${g.download.pct}%` }} aria-hidden="true" />}
      </span>
      <span className="st-tile-name">{g.name}</span>
      <span className="st-tile-sub">{g.playtime ? hours(g.playtime) : t('not played yet')}{g.lastPlayed ? ` · ${ago(g.lastPlayed)}` : ''}</span>
    </button>
  );
}

export function GameSheet({ g, onClose, serversAvailable }) {
  if (!g) return null;
  const state = STATE_TEXT(g);
  return (
    <Sheet title={g.name} subtitle={state || (g.playtime ? t('{h} played', { h: hours(g.playtime) }) : t('not played yet'))} onClose={onClose} size="wide"
      footer={<><Btn className="ghost" icon={Trash2} onClick={() => uninstall(g)}>Uninstall in Steam …</Btn><span className="grow" /><Btn className="primary" icon={Play} disabled={g.busy || g.running} onClick={() => steam('run', g.appid)}>Play</Btn></>}>
      <div className="st-hero">
        <Art appid={g.appid} name={g.name} kind="hero" />
        <span className="st-hero-logo"><Art appid={g.appid} name={g.name} kind="logo" /></span>
      </div>
      {g.download && (
        <div className="card"><div className="card-body stack">
          <div className="row-tight"><Download size={16} aria-hidden="true" /><b className="grow">{g.download.paused ? t('Update paused') : t('Steam is updating this game')}</b>{g.download.pct != null && <b>{g.download.pct} %</b>}</div>
          <Progress value={g.download.pct || 0} indeterminate={g.download.pct == null} />
          <span className="small muted">{gb(g.download.bytesDone)} / {gb(g.download.bytesTotal)}</span>
        </div></div>
      )}
      <dl className="st-facts">
        <div><dt><Clock size={14} aria-hidden="true" />{t('Playtime')}</dt><dd>{g.playtime ? hours(g.playtime) : '–'}{g.playtime2wks ? <span className="muted small"> · {t('{h} in the last 2 weeks', { h: hours(g.playtime2wks) })}</span> : null}</dd></div>
        <div><dt><Gamepad2 size={14} aria-hidden="true" />{t('Last played')}</dt><dd>{g.lastPlayed ? `${ago(g.lastPlayed)} (${fmtDate(g.lastPlayed)})` : t('never')}</dd></div>
        <div><dt><HardDrive size={14} aria-hidden="true" />{t('Size')}</dt><dd>{gb(g.size)}{g.drive ? <span className="muted small"> · {g.drive}{g.media ? ` (${g.media.toUpperCase()})` : ''}</span> : null}</dd></div>
        <div><dt><RefreshCw size={14} aria-hidden="true" />{t('Updated')}</dt><dd>{g.lastUpdated ? ago(g.lastUpdated) : '–'}{g.updatePending && !g.busy ? <span className="badge warn st-ml">{t('Update ready')}</span> : null}{g.scheduledUpdate && g.updatePending && g.scheduledUpdate > Date.now() ? <span className="small muted"> · {t('Steam plans it for {when}', { when: fmtDate(g.scheduledUpdate) })}</span> : null}</dd></div>
        <div><dt><ShieldCheck size={14} aria-hidden="true" />{t('Saves')}</dt><dd>{g.lastBackup ? t('backed up {when}', { when: ago(g.lastBackup) }) : t('not backed up yet')}</dd></div>
        {g.price && <div><dt><Store size={14} aria-hidden="true" />{t('Store price today')}</dt><dd>{money(g.price.final, g.price.currency)}{g.price.discount ? <span className="badge ok st-ml">−{g.price.discount} %</span> : null}</dd></div>}
      </dl>
      {g.genres && g.genres.length > 0 && <div className="row-tight st-chips">{g.genres.map((x) => <span key={x} className="pill">{x}</span>)}</div>}
      <div className="row-tight st-wrap">
        <Btn className="sm" icon={ExternalLink} onClick={() => steam('details', g.appid)}>Show in Steam</Btn>
        <Btn className="sm" icon={FolderOpen} onClick={() => openFolder('game', g.appid)}>Open game folder</Btn>
        <Btn className="sm" icon={Save} onClick={() => backupNow(g)}>Back up saves now</Btn>
        <Btn className="sm ghost" icon={Wrench} onClick={() => steam('validate', g.appid)} title={t('Steam checks the game files and repairs missing ones')}>Check files …</Btn>
      </div>
      {g.server && serversAvailable && (
        <div className="card"><div className="card-body row-tight">
          <Server size={18} aria-hidden="true" />
          <div className="grow"><b>{t('Your own server')}</b><div className="small muted">{g.server.servers.length ? pl(g.server.servers.length, '{n} server of this game in Hostwerk', '{n} servers of this game in Hostwerk') : t('{tool} – set up in one step through “Game servers”.', { tool: g.server.tool.name })}</div></div>
          {g.server.servers.length > 0 && <a className="btn sm ghost" href={`#/ext/game-servers/${g.server.servers[0].id}`}>{t('Open')}</a>}
          <Btn className="sm" icon={Server} disabled={g.server.tool.login} title={g.server.tool.login ? t('This server tool needs a Steam account that owns the game – Hostwerk only uses the anonymous login.') : undefined} onClick={() => startServer(g)}>Start own server …</Btn>
        </div></div>
      )}
      <p className="tiny muted">{t('Steam ID {id} · Build {build}', { id: g.appid, build: g.buildid || '–' })} · {g.library}</p>
    </Sheet>
  );
}

export function LibraryTab({ d }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useRemembered('steam:sort', 'recent');
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(null);
  const fill = useFill({ min: 280 });
  const games = useMemo(() => (d.games || []).filter((g) => !g.tool), [d.games]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return games
      .filter((g) => !s || g.name.toLowerCase().includes(s) || String(g.appid) === s)
      .filter((g) => !filter || (filter === 'updates' ? g.updatePending && !g.busy : filter === 'downloads' ? g.busy || g.download : filter === 'servers' ? !!g.server : filter === 'unplayed' ? !g.playtime : true))
      .sort(sorter[sort] || sorter.recent);
  }, [games, q, sort, filter]);
  const tot = d.totals || {};
  const toggle = (f) => setFilter(filter === f ? '' : f);
  const cur = open && games.find((g) => g.appid === open);
  const unplayed = games.filter((g) => !g.playtime).length;
  return (
    <>
      <StatBar label={t('Library')} items={[
        { label: t('Games'), value: tot.games, icon: Gamepad2, onClick: () => setFilter(''), active: !filter },
        { label: t('On disk'), value: gb(tot.bytes), icon: HardDrive, onClick: () => go('storage'), title: t('Open the storage doctor') },
        { label: t('Playtime'), value: hours(tot.playtime), icon: Clock, onClick: () => go('stats') },
        unplayed > 0 && { label: t('Not played yet'), value: unplayed, onClick: () => toggle('unplayed'), active: filter === 'unplayed' },
        tot.updates > 0 && { label: t('Updates ready'), value: tot.updates, tone: 'warn', onClick: () => toggle('updates'), active: filter === 'updates' },
        tot.downloads > 0 && { label: t('Downloading'), value: tot.downloads, icon: Download, onClick: () => toggle('downloads'), active: filter === 'downloads' },
        d.serversAvailable && tot.servers > 0 && { label: t('Own server possible'), value: tot.servers, icon: Server, onClick: () => toggle('servers'), active: filter === 'servers' },
        d.value && d.value.counted > 0 && { label: t('Library value'), value: money(d.value.regular, d.value.currency), title: t('Today’s regular store price of {n} installed games – not what you paid.', { n: d.value.counted }) },
      ]} />
      <div className="st-toolbar">
        <div className="input-icon grow st-search"><Search aria-hidden="true" /><input className="input sm" type="search" placeholder={t('Search games …')} aria-label={t('Search games')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Seg value={sort} onChange={setSort} options={SORTS.map((x) => ({ ...x, label: t(x.label) }))} />
      </div>
      <div ref={fill} className="st-grid-wrap fill-scroll">
        {shown.length === 0 ? <TileEmpty icon={q ? Search : CircleAlert} text={q ? t('Nothing found.') : t('No games in this view.')} /> : (
          <div className="st-grid">
            {shown.map((g) => <Tile key={g.appid} g={g} onOpen={() => setOpen(g.appid)} serversAvailable={d.serversAvailable} />)}
          </div>
        )}
      </div>
      {cur && <GameSheet g={cur} onClose={() => setOpen(null)} serversAvailable={d.serversAvailable} />}
    </>
  );
}
