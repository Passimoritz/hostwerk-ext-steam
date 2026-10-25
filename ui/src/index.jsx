import { useState } from 'react';
import { Gamepad2, HardDrive, Save, Tag, BarChart3, Image as ImageIcon, Dices, RefreshCw, Library, Settings, Server, Download, Play, Users, CircleOff, KeyRound } from 'lucide-react';
import { useApi, put, post } from '@hostwerk/api';
import { Btn, Tabs, Empty, Loading, TileEmpty, InfoTip, Progress, toast } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { BASE, go, Art, hours, ago, gb, steam, startServer } from './common';
import { LibraryTab } from './library';
import { StorageTab } from './storage';
import { SavesTab } from './saves';
import { DealsTab } from './deals';
import { StatsTab, ShotsTab } from './stats';
import { PicksSheet } from './picks';
import { AccountsTab, OtherGames } from './accounts';
import './style.css';

/*
 * Spielebibliothek: eigene Seite mit Reitern (Bibliothek, Speicher, Spielstände, Angebote, Statistik, Screenshots, Konten),
 * dazu eine Kachel für die Übersicht und der Reiter „Deine Spiele“ im Bereich Spiele-Server (eigener Server je Spiel).
 * Texte englisch, Deutsch aus locales/de.json.
 */
const TABS = [
  { id: 'library', label: 'Library', icon: Library },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'saves', label: 'Saves', icon: Save },
  { id: 'deals', label: 'Deals', icon: Tag },
  { id: 'stats', label: 'Statistics', icon: BarChart3 },
  { id: 'screenshots', label: 'Screenshots', icon: ImageIcon },
  { id: 'accounts', label: 'Accounts', icon: KeyRound },
];

function NotFound({ d, reload }) {
  return (
    <Empty icon={CircleOff} title="Steam was not found on this PC"
      text={d.platform === 'linux' ? 'Hostwerk looked in ~/.steam, ~/.local/share/Steam, Flatpak and Snap. Installed somewhere else? Enter the folder in the extension’s settings.' : 'Hostwerk looked in the registry and in the usual folders. Installed somewhere else? Enter the folder in the extension’s settings.'}
      action={<><a className="btn" href="#/settings/erweiterungen"><Settings size={14} aria-hidden="true" />{t('Settings')}</a> <Btn icon={RefreshCw} onClick={reload}>Search again</Btn> <Btn icon={KeyRound} onClick={() => go('accounts')}>Other stores and accounts</Btn></>} />
  );
}

function RunLine({ d }) {
  const g = d.run && d.run.appId ? (d.games || []).find((x) => x.appid === d.run.appId) : null;
  const dl = (d.games || []).filter((x) => x.download && x.busy);
  if (!d.run || !d.run.running) return <span className="pill">{t('Steam is not running')}</span>;
  return (
    <span className="row-tight">
      {g ? <span className="badge ok"><Play size={12} aria-hidden="true" />{t('Playing: {name}', { name: g.name })}</span> : <span className="pill">{t('Steam is running')}</span>}
      {dl.length > 0 && <span className="pill info" title={dl.map((x) => `${x.name} ${x.download.pct != null ? `${x.download.pct} %` : ''}`).join(', ')}><Download size={12} aria-hidden="true" />{dl.length === 1 ? `${dl[0].name} · ${dl[0].download.pct != null ? `${dl[0].download.pct} %` : '…'}` : pl(dl.length, '{n} download', '{n} downloads')}</span>}
    </span>
  );
}

export function SteamPage({ path = [] }) {
  const tab = TABS.some((x) => x.id === path[0]) ? path[0] : 'library';
  const d = useApi('/steam', [], { poll: true });
  const [picks, setPicks] = useState(path[0] === 'picks');
  const [busy, setBusy] = useState(false);
  const rescan = async () => { setBusy(true); try { d.setData(await post('/steam/rescan')); toast.success(t('Read again')); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  const x = d.data;
  const head = (
    <div className="page-head">
      <div>
        <h1><Gamepad2 size={22} /> Game library</h1>
        <p>Your games from Steam, Epic, GOG and itch.io – with saves, deals and your accounts.</p>
      </div>
      <div className="actions">
        {x && x.found && <RunLine d={x} />}
        {x && x.found && x.users && x.users.filter((u) => u.hasData).length > 1 && (
          <select className="input sm select st-select" value={x.user || ''} aria-label={t('Steam account for playtime')} title={t('Steam account for playtime')}
            onChange={async (e) => { try { d.setData(await put('/steam/user', { accountId: e.target.value })); } catch (err) { toast.error(err.message); } }}>
            {x.users.filter((u) => u.hasData).map((u) => <option key={u.accountId} value={u.accountId}>{u.persona || t('Account {id}', { id: u.accountId })}</option>)}
          </select>
        )}
        <Btn className="ghost" icon={RefreshCw} busy={busy} onClick={rescan} title={t('Read Steam’s files again')} aria-label={t('Read again')} />
        {x && x.found && <Btn className="primary" icon={Dices} onClick={() => setPicks(true)}>What should I play?</Btn>}
      </div>
    </div>
  );
  if (!x) return <div className="page">{head}{d.error ? <Empty icon={Gamepad2} title="The library could not be read" text={d.error} action={<Btn icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />}</div>;
  if (!x.found) return <div className="page">{head}{tab === 'accounts' ? <AccountsTab /> : <><NotFound d={x} reload={rescan} /><OtherGames /></>}</div>;
  const tabs = TABS.map((y) => ({ ...y, label: t(y.label), badge: y.id === 'library' ? x.totals.games : undefined }));
  return (
    <div className="page fade-in st-page">
      {head}
      <Tabs value={tab} onChange={go} tabs={tabs} />
      <div className="st-body">
        {tab === 'library' && <><LibraryTab d={x} /><OtherGames /></>}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'storage' && <StorageTab d={x} />}
        {tab === 'saves' && <SavesTab />}
        {tab === 'deals' && <DealsTab />}
        {tab === 'stats' && <StatsTab />}
        {tab === 'screenshots' && <ShotsTab />}
      </div>
      {picks && <PicksSheet onClose={() => setPicks(false)} games={x.games} serversAvailable={x.serversAvailable} />}
    </div>
  );
}

/** Kachel: läuft gerade / zuletzt gespielt, Downloads, Platz */
function SteamTile() {
  const d = useApi('/steam', [], { poll: true });
  const x = d.data;
  if (!x) return d.error ? <TileEmpty icon={Gamepad2} text={d.error} /> : <div className="card-body"><div className="skeleton st-skel" /></div>;
  if (!x.found) return <TileEmpty icon={CircleOff} text={t('Steam was not found on this PC.')} href={BASE} />;
  const games = (x.games || []).filter((g) => !g.tool);
  const playing = x.run && x.run.appId ? games.find((g) => g.appid === x.run.appId) : null;
  const last = playing || [...games].filter((g) => g.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed)[0];
  const dl = games.filter((g) => g.download && g.busy);
  const low = (x.drives || []).find((dr) => dr.free != null && dr.total && dr.free / dr.total < 0.1);
  return (
    <div className="card-body st-tile-card">
      {last ? (
        <a className="st-tile-last" href={BASE}>
          <Art appid={last.appid} name={last.name} kind="portrait" className="st-tile-last-art" />
          <span className="stack st-tile-last-text">
            <span className="tiny muted">{playing ? t('Playing right now') : t('Last played')}</span>
            <b className="ellipsis">{last.name}</b>
            <span className="small muted">{hours(last.playtime)}{!playing && last.lastPlayed ? ` · ${ago(last.lastPlayed)}` : ''}</span>
          </span>
        </a>
      ) : <span className="small muted">{t('Not played yet')}</span>}
      <div className="row-tight st-wrap small">
        <span className="pill">{pl(x.totals.games, '{n} game', '{n} games')} · {gb(x.totals.bytes)}</span>
        {x.totals.updates > 0 && <span className="badge warn">{pl(x.totals.updates, '{n} update ready', '{n} updates ready')}</span>}
        {low && <a className="badge err" href={`${BASE}/storage`}>{t('{d} almost full', { d: low.label })}</a>}
      </div>
      {dl.slice(0, 1).map((g) => <div key={g.appid} className="stack st-tile-dl"><span className="small">{t('Downloading {name}', { name: g.name })}</span><Progress value={g.download.pct || 0} indeterminate={g.download.pct == null} /></div>)}
    </div>
  );
}

/** Reiter „Deine Spiele“ im Bereich Spiele-Server: installierte Spiele mit eigenem Server – ein Klick zum Einrichten */
function YourGamesTab() {
  const d = useApi('/steam', [], { live: false });
  const x = d.data;
  if (!x) return <Loading />;
  if (!x.found) return <Empty icon={CircleOff} title="Steam was not found on this PC" text="Then Hostwerk cannot see which games you own." />;
  const list = (x.games || []).filter((g) => g.server).sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
  if (!list.length) return <Empty icon={Server} title="None of your games has a server tool here" text="Hostwerk compares your installed Steam games with the server tools it knows. Load Steam’s complete list under “New server” to find more." />;
  return (
    <div className="stack">
      <div className="row-tight"><b className="grow">{pl(list.length, 'You could host one of your games yourself', 'You could host {n} of your games yourself')}</b>
        <InfoTip title="Own server for your games">{t('Found by comparing your installed Steam games with the server tools from “Game servers”. One click sets up the server through SteamCMD; friends join with the address shown on the server page.')}</InfoTip></div>
      <div className="list-rows">
        {list.map((g) => (
          <div key={g.appid} className="list-row-item">
            <Art appid={g.appid} name={g.name} kind="portrait" className="st-md-art" />
            <div className="grow"><div className="list-row-title">{g.name}</div><div className="list-row-sub">{g.server.tool.name}{g.playtime ? ` · ${t('you played {h}', { h: hours(g.playtime) })}` : ''}</div></div>
            {g.server.servers.map((s) => <a key={s.id} className={`badge ${s.running ? 'ok' : ''}`} href={`#/ext/game-servers/${s.id}`}><Users size={12} aria-hidden="true" />{s.name}</a>)}
            <Btn className="xs" icon={Server} disabled={g.server.tool.login} title={g.server.tool.login ? t('This server tool needs a Steam account that owns the game – Hostwerk only uses the anonymous login.') : undefined} onClick={() => startServer(g)}>{g.server.servers.length ? t('Another server …') : t('Start own server …')}</Btn>
            <Btn className="xs ghost" icon={Play} title={t('Play')} aria-label={t('Play {name}', { name: g.name })} onClick={() => steam('run', g.appid)} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default {
  pages: { main: SteamPage },
  slots: {
    'dashboard.tiles': [{ id: 'steam', title: 'Steam', icon: Gamepad2, size: 'third', Component: SteamTile }],
    // Bereich Spiele-Server (Erweiterung „Spiele-Server“, Hostwerk 3.0+): ältere Fassungen zeigen den Steckplatz einfach nicht
    'games.tabs': [{ id: 'your-games', title: 'Your games', icon: Gamepad2, Component: YourGamesTab, order: 30 }],
  },
};
