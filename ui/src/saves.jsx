import { useMemo, useState } from 'react';
import { Save, Cloud, CloudOff, RotateCcw, Trash2, FolderOpen, ShieldCheck, ShieldAlert, HelpCircle, Search, RefreshCw, History, KeyRound, Gamepad2 } from 'lucide-react';
import { post, del, useApi, fmtDate } from '@hostwerk/api';
import { Btn, Loading, Empty, TileEmpty, InfoTip, Callout, toast, confirmDialog } from '@hostwerk/ui';
import * as HUI from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { Art, gb, ago, openFolder, StatBar, useRemembered } from './common';
import { useFill } from './fill';

/*
 * Reiter „Spielstände“: links die Spiele (bekannt aus dem Ludusavi-Verzeichnis, Steam Cloud ja/nein, letzte Sicherung),
 * rechts Orte, Dateien und die Stände des gewählten Spiels mit Zurückspielen (mit Vorab-Sicherung) und Löschen.
 */
const REASON = { session: 'after playing', manual: 'by hand', 'before-restore': 'before restoring' };

function Detail({ appid, onChanged }) {
  const d = useApi(`/steam/saves/${appid}`, [appid], { live: false });
  const x = d.data;
  if (!x) return d.error ? <Empty icon={ShieldAlert} title="The saves could not be read" text={d.error} action={<Btn icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />;
  const backup = async () => {
    try {
      const r = await post(`/steam/saves/${appid}/backup`);
      if (r.created) toast.success(t('Saves backed up'));
      else if (r.unchanged) toast(t('Nothing changed since the last backup'), 'info');
      else toast(t('No saves found on this PC'), 'info');
      d.reload(); onChanged();
    } catch (e) { toast.error(e.message); }
  };
  const restore = async (s) => {
    const ok = await confirmDialog({ title: t('Restore the saves from {when}?', { when: fmtDate(s.t) }), text: t('Hostwerk backs up the current saves first (“before restoring”), then puts back {n} files. Close the game before.', { n: s.count }), confirm: t('Restore') });
    if (!ok) return;
    try { const r = await post('/steam/saves/restore', { id: s.id }); toast.success(t('{n} files restored', { n: r.restored })); d.reload(); onChanged(); } catch (e) { toast.error(e.message); }
  };
  const remove = async (s) => {
    if (!(await confirmDialog({ title: t('Delete this backup?'), text: t('The backup from {when} is gone afterwards. Your current saves stay untouched.', { when: fmtDate(s.t) }), confirm: t('Delete'), danger: true }))) return;
    try { await del(`/steam/saves/${encodeURIComponent(s.id)}`); toast.success(t('Backup deleted')); d.reload(); onChanged(); } catch (e) { toast.error(e.message); }
  };
  return (
    <>
      <div className="row-tight st-savehead">
        <Art appid={x.appid} name={x.name} kind="header" className="st-savehead-art" />
        <div className="grow">
          <h3 className="st-h3">{x.name}</h3>
          <div className="small muted">
            {x.known ? `${pl(x.files, '{n} file', '{n} files')} · ${gb(x.bytes)}` : t('Not in the save index yet')}
            {x.cloud ? <span className="badge info st-ml"><Cloud size={12} aria-hidden="true" />Steam Cloud</span> : null}
          </div>
        </div>
        {x.known && x.files > 0 && <Btn className="sm ghost" icon={FolderOpen} onClick={() => openFolder('saves', x.appid)}>Open folder</Btn>}
        <Btn className="sm primary" icon={Save} disabled={!x.known || !x.files} onClick={backup}>Back up now</Btn>
      </div>
      {!x.known && <Callout kind="info" icon={HelpCircle} title="Where this game saves is not known yet" dismissible={false}>{t('The save index (Ludusavi, made from the PCGamingWiki) does not list this game. It is updated every day – when the game is added, Hostwerk backs it up from then on.')}</Callout>}
      {x.registry && x.registry.length > 0 && <Callout kind="warn" icon={KeyRound} title="Part of the saves lives in the Windows registry" dismissible={false}>{t('Hostwerk backs up files only. The registry keys are: {keys}', { keys: x.registry.join(', ') })}</Callout>}
      {x.places.length > 0 && (
        <div className="card">
          <div className="card-head"><FolderOpen size={16} aria-hidden="true" /><h3>Places</h3><span className="badge">{x.places.length}</span>
            <div className="right"><InfoTip title="Where saves are looked for">{t('From the Ludusavi index. <base> is the game folder, AppData and Documents are your user folders; on Linux Windows games are also looked for in their Proton prefix.')}</InfoTip></div></div>
          <div className="card-body st-places">
            {x.places.map((p) => <div key={p.pattern} className="row-tight small"><code className="grow st-code" title={p.pattern}>{p.pattern}</code>{p.proton && <span className="badge">Proton</span>}<span className={`badge ${p.files ? 'ok' : ''}`}>{p.files}</span></div>)}
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-head"><History size={16} aria-hidden="true" /><h3>Backups</h3><span className="badge">{x.snapshots.length}</span></div>
        {x.snapshots.length === 0 ? <TileEmpty icon={History} text={t('No backups yet.')} /> : (
          <div className="list-rows st-flat">
            {x.snapshots.map((s) => (
              <div key={s.id} className="list-row-item">
                <History size={16} aria-hidden="true" className="st-ico" />
                <div className="grow"><div className="list-row-title">{fmtDate(s.t)}</div><div className="list-row-sub">{t(REASON[s.reason] || s.reason)} · {pl(s.count, '{n} file', '{n} files')} · {gb(s.bytes)}{s.newBytes ? ` · ${t('{size} new', { size: gb(s.newBytes) })}` : ` · ${t('nothing new stored')}`}</div></div>
                <Btn className="xs" icon={RotateCcw} onClick={() => restore(s)}>Restore …</Btn>
                <Btn className="xs ghost" icon={Trash2} title={t('Delete backup')} aria-label={t('Delete backup')} onClick={() => remove(s)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export function SavesTab() {
  const d = useApi('/steam/saves', [], { live: false });
  const [sel, setSel] = useRemembered('steam:saves:sel', null);
  const [q, setQ] = useState('');
  const fill = useFill({ min: 320 });
  const x = d.data;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return ((x && x.games) || []).filter((g) => !s || g.name.toLowerCase().includes(s)).sort((a, b) => (Number(b.known) - Number(a.known)) || (b.lastPlayed || 0) - (a.lastPlayed || 0));
  }, [x, q]);
  if (!x) return d.error ? <Empty icon={ShieldAlert} title="The saves could not be read" text={d.error} action={<Btn icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />;
  const known = x.games.filter((g) => g.known);
  const noCloud = known.filter((g) => !g.cloud && g.files > 0);
  const unprotected = noCloud.filter((g) => !g.backups);
  const cur = list.find((g) => g.appid === sel) || list[0] || null;
  const loadIndex = async () => { try { const r = await post('/steam/saves/manifest'); if (r.error) toast.error(r.error); else toast.success(t('Save index loaded')); d.reload(); } catch (e) { toast.error(e.message); } };
  const backupAll = async () => {
    let n = 0;
    for (const g of known.filter((y) => y.files > 0)) { try { const r = await post(`/steam/saves/${g.appid}/backup`); if (r.created) n++; } catch { /* nächstes */ } }
    toast.success(pl(n, '{n} game backed up', '{n} games backed up'));
    d.reload();
  };
  const listEl = (
    <>
      <div className="input-icon st-md-search"><Search aria-hidden="true" /><input className="input sm" type="search" placeholder={t('Search games …')} aria-label={t('Search games')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {list.map((g) => (
        <button key={g.appid} type="button" className={`md-item ${cur && cur.appid === g.appid ? 'active' : ''}`} onClick={() => setSel(g.appid)} aria-current={cur && cur.appid === g.appid ? 'true' : undefined}>
          <Art appid={g.appid} name={g.name} kind="portrait" className="st-md-art" />
          <span className="md-item-main"><b>{g.name}</b><span>{!g.known ? t('location unknown') : g.lastBackup ? t('backed up {when}', { when: ago(g.lastBackup) }) : g.files ? t('not backed up yet') : t('no saves on this PC')}</span></span>
          {g.known && (g.cloud ? <Cloud size={14} className="muted" aria-label={t('Steam Cloud')} /> : g.files > 0 && !g.backups ? <CloudOff size={14} className="st-tone-warn" aria-label={t('Only on this PC')} /> : g.backups ? <ShieldCheck size={14} className="st-tone-ok" aria-label={t('Backed up')} /> : null)}
        </button>
      ))}
      {list.length === 0 && <TileEmpty icon={Search} text={t('Nothing found.')} />}
    </>
  );
  const Master = HUI.MasterDetail;
  return (
    <>
      {(!x.manifest.have || !x.autoBackup || unprotected.length > 0) && (
        <div className="st-hints">
          {!x.manifest.have && <Callout kind="info" icon={Cloud} title="The save index is not loaded yet" dismissible={false}>{x.offline ? t('Offline mode is on – Hostwerk loads it as soon as it may go online.') : t('Hostwerk loads it once a day from GitHub (about 17 MB, then only changes).')} <Btn className="sm st-ml" icon={RefreshCw} onClick={loadIndex} disabled={x.offline}>Load now</Btn></Callout>}
          {x.manifest.have && unprotected.length > 0 && <Callout kind="warn" icon={CloudOff} title={pl(unprotected.length, '{n} game keeps its saves only on this PC', '{n} games keep their saves only on this PC')} dismissible={false}>{t('No Steam Cloud and no backup yet: {list}.', { list: unprotected.slice(0, 4).map((g) => g.name).join(', ') })} <Btn className="sm st-ml" icon={Save} onClick={backupAll}>Back up all now</Btn></Callout>}
        </div>
      )}
      <div className="st-toolbar">
        <StatBar label={t('Saves')} items={[
          { label: t('Known places'), value: `${known.length} / ${x.games.length}`, icon: Gamepad2 },
          { label: t('Steam Cloud'), value: known.filter((g) => g.cloud).length, icon: Cloud },
          noCloud.length > 0 && { label: t('Only on this PC'), value: noCloud.length, icon: CloudOff, tone: unprotected.length ? 'warn' : undefined },
          { label: t('Backed up'), value: x.games.filter((g) => g.backups).length, icon: ShieldCheck, tone: 'ok' },
          { label: t('Space used'), value: gb(x.usage), title: t('Unchanged files are stored only once.') },
        ]} />
        <span className="grow" />
        <InfoTip title="How save backups work">{t('Where a game keeps its saves comes from the open Ludusavi index (made from the PCGamingWiki, updated daily) – Hostwerk keeps no list of its own. {auto} Each file is stored once; unchanged saves cost no space. Backups show up in Hostwerk’s backup center and in the external backup.', { auto: x.autoBackup ? t('After every session (Hostwerk sees when a game ends) the saves are backed up automatically.') : t('Automatic backups after playing are switched off in the settings.') })}{x.manifest.changedAt ? ` ${t('Index from {when}.', { when: fmtDate(x.manifest.changedAt) })}` : ''}</InfoTip>
        {x.manifest.have && <Btn className="sm ghost" icon={RefreshCw} onClick={loadIndex} disabled={x.offline} title={t('Load the save index again')}>Update index</Btn>}
      </div>
      {Master ? (
        <Master listLabel={t('Games')} list={listEl} detail={cur ? <Detail appid={cur.appid} onChanged={() => d.reload()} /> : <Empty icon={Save} title="No games" text="Install a game in Steam first." />} />
      ) : (
        <div ref={fill} className="st-md">
          <nav className="st-md-list" aria-label={t('Games')}>{listEl}</nav>
          <div className="st-md-detail">{cur ? <Detail appid={cur.appid} onChanged={() => d.reload()} /> : <Empty icon={Save} title="No games" text="Install a game in Steam first." />}</div>
        </div>
      )}
    </>
  );
}
