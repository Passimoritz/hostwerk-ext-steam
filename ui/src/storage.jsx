import { useMemo } from 'react';
import { HardDrive, Trash2, FolderOpen, Gauge, MoveRight, Ghost, Hourglass, AlertTriangle, Save, Gamepad2, RefreshCw, Sparkles } from 'lucide-react';
import { post, useApi } from '@hostwerk/api';
import { Btn, Loading, Empty, InfoTip, toast } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { gb, ago, steam, openFolder, StatBar } from './common';
import { uninstall, backupNow } from './library';
import { useFill } from './fill';

/*
 * Reiter „Speicher“: Laufwerke als Platz-Karte (größte Spiele als Streifen), darunter die Befunde des Speicher-Doktors.
 * Hostwerk löscht nichts selbst – Deinstallieren und Verschieben macht Steam, Reste öffnet der Explorer.
 */
const KIND = {
  'drive-low': { icon: AlertTriangle, tone: 'err' },
  leftover: { icon: Ghost, tone: 'warn' },
  'never-played': { icon: Hourglass, tone: '' },
  dormant: { icon: Hourglass, tone: '' },
  'slow-drive': { icon: Gauge, tone: 'info' },
};
const TONE = { err: 'st-tone-err', warn: 'st-tone-warn', info: 'st-tone-info' };
const WHAT = { workshop: 'Workshop items', shader: 'Shader cache', compat: 'Proton prefix', downloading: 'Unfinished download' };

function text(f) {
  switch (f.kind) {
    case 'drive-low': return { title: t('Drive {d} is almost full', { d: f.drive }), sub: t('{free} free of {total}', { free: gb(f.free), total: gb(f.total) }) + (f.top && f.top.length ? ` · ${t('candidates: {list}', { list: f.top.map((x) => x.name).join(', ') })}` : '') };
    case 'leftover': return { title: `${t(WHAT[f.what] || f.what)} · ${f.name || t('Steam ID {id}', { id: f.appid })}`, sub: t('Left behind by a game that is no longer installed.') };
    case 'never-played': return { title: f.name, sub: t('Installed {n} days ago, never started', { n: f.days }) };
    case 'dormant': return { title: f.name, sub: t('Last played {when}', { when: ago(Date.now() - f.days * 86400e3) }) };
    case 'slow-drive': return { title: f.name, sub: t('Played a lot, but lies on a hard disk ({from}) – on the SSD ({to}) it loads faster.', { from: f.drive, to: f.to }) };
    default: return { title: f.kind, sub: '' };
  }
}

function DriveMap({ drives, games }) {
  return (
    <div className="st-drives">
      {drives.map((d) => {
        const on = games.filter((g) => d.paths.includes(g.library) && !g.tool).sort((a, b) => b.size - a.size);
        const used = d.total ? d.total - d.free : 0;
        const top = on.slice(0, 7);
        const rest = on.slice(7).reduce((a, g) => a + g.size, 0);
        const steamBytes = on.reduce((a, g) => a + g.size, 0);
        const pct = (b) => (d.total ? `${Math.max(0.4, (b / d.total) * 100)}%` : '0%');
        return (
          <div key={d.key} className="card st-drive">
            <div className="card-body stack">
              <div className="row-tight">
                <HardDrive size={16} aria-hidden="true" />
                <b>{d.label}</b>
                {d.media && <span className={`badge ${d.media === 'ssd' ? 'ok' : ''}`}>{d.media === 'ssd' ? 'SSD' : 'HDD'}</span>}
                <span className="grow" />
                <span className="small muted">{d.free != null ? t('{free} free of {total}', { free: gb(d.free), total: gb(d.total) }) : t('Size unknown')}</span>
              </div>
              <div className="st-drivebar" role="img" aria-label={t('{steam} games, {other} other files, {free} free', { steam: gb(steamBytes), other: gb(Math.max(0, used - steamBytes)), free: gb(d.free) })}>
                {top.map((g, i) => <span key={g.appid} className={`st-seg st-seg-${i % 7}`} style={{ width: pct(g.size) }} title={`${g.name} · ${gb(g.size)}`} />)}
                {rest > 0 && <span className="st-seg st-seg-rest" style={{ width: pct(rest) }} title={t('{n} more games · {size}', { n: on.length - top.length, size: gb(rest) })} />}
                <span className="st-seg st-seg-other" style={{ width: pct(Math.max(0, used - steamBytes)) }} title={t('Other files · {size}', { size: gb(Math.max(0, used - steamBytes)) })} />
              </div>
              <div className="tiny muted">{pl(on.length, '{n} game', '{n} games')} · {gb(steamBytes)}{top[0] ? ` · ${t('biggest: {name}', { name: top[0].name })}` : ''}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StorageTab({ d }) {
  const doc = useApi('/steam/doctor', [], { live: false });
  const fill = useFill({ min: 220 });
  const games = d.games || [];
  const byId = useMemo(() => new Map(games.map((g) => [g.appid, g])), [games]);
  const measure = async () => { try { doc.setData(await post('/steam/doctor/measure')); toast.success(t('Measured again')); } catch (e) { toast.error(e.message); } };
  const r = doc.data;
  return (
    <>
      {d.drives && d.drives.length > 0 ? <DriveMap drives={d.drives} games={games} /> : null}
      {!r ? (doc.error ? <Empty icon={HardDrive} title="The storage doctor could not look" text={doc.error} action={<Btn icon={RefreshCw} onClick={() => doc.reload()}>Try again</Btn>} /> : <Loading />) : (
        <>
          <div className="st-toolbar">
            <StatBar label={t('Storage doctor')} items={[
              { label: t('Could free up'), value: gb(r.reclaim), icon: Sparkles, tone: r.reclaim > 0 ? 'ok' : undefined },
              r.counts.dormant && { label: t('Long unplayed'), value: r.counts.dormant },
              r.counts['never-played'] && { label: t('Never started'), value: r.counts['never-played'] },
              r.counts.leftover && { label: t('Leftovers'), value: r.counts.leftover, tone: 'warn' },
              r.counts['slow-drive'] && { label: t('Better on the SSD'), value: r.counts['slow-drive'], tone: 'warn' },
            ]} />
            <span className="grow" />
            <InfoTip title="How the storage doctor decides">{t('Only from Steam’s own files: size, last played and playtime per game, drives (SSD or hard disk) and folders of games that are gone (workshop, shader cache, Proton, downloads). Hostwerk never deletes anything here – uninstalling and moving is done by Steam, leftovers open in the file manager. Thresholds (e.g. “long unplayed” after 180 days) are in the extension’s settings.')}</InfoTip>
            <Btn className="sm ghost" icon={RefreshCw} onClick={measure} title={t('Measure drives and leftovers again')}>Measure again</Btn>
          </div>
          {!r.measured && <p className="small muted">{t('Drives and leftovers are measured a few minutes after Hostwerk starts – or right now with “Measure again”.')}</p>}
          <div ref={fill} className="fill-scroll">
            {r.findings.length === 0 ? <Empty icon={Sparkles} title="Nothing to tidy up" text="Every game was played recently, no leftovers, enough space." /> : (
              <div className="list-rows">
                {r.findings.map((f) => {
                  const k = KIND[f.kind] || KIND.dormant;
                  const tx = text(f);
                  const g = f.appid ? byId.get(f.appid) : null;
                  return (
                    <div key={f.id} className="list-row-item">
                      <k.icon size={18} className={`st-ico ${TONE[k.tone] || ''}`} aria-hidden="true" />
                      <div className="grow"><div className="list-row-title">{tx.title}</div><div className="list-row-sub" title={tx.sub}>{tx.sub}</div></div>
                      {f.bytes > 0 && <b className="st-num">{gb(f.bytes)}</b>}
                      <div className="row-tight">
                        {f.actions.includes('backup') && g && <Btn className="xs ghost" icon={Save} onClick={() => backupNow(g)} title={t('Back up the saves first')}>Back up saves</Btn>}
                        {f.actions.includes('details') && <Btn className="xs ghost" icon={Gamepad2} onClick={() => steam('details', f.appid)}>Show in Steam</Btn>}
                        {f.actions.includes('move') && <InfoTip title="Move to the SSD" icon={MoveRight} pop>{t('In Steam: right-click the game → Properties → Installed files → Move install folder, then choose the library on {to}.', { to: f.to })}</InfoTip>}
                        {f.actions.includes('uninstall') && <Btn className="xs danger" icon={Trash2} onClick={() => uninstall(g || { appid: f.appid, name: f.name })}>Uninstall …</Btn>}
                        {f.actions.includes('open-folder') && <Btn className="xs" icon={FolderOpen} onClick={() => openFolder('leftover', `${f.what}:${f.appid}`)}>Open folder</Btn>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
