import { useMemo, useState } from 'react';
import { BarChart3, Clock, Flame, Trophy, CalendarDays, Image as ImageIcon, FolderOpen, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useApi, apiUrl, fmtDate } from '@hostwerk/api';
import { Btn, Loading, Empty, InfoTip, Modal, TileEmpty } from '@hostwerk/ui';
import { LazyImg } from '@hostwerk/kit';
import { t } from '@hostwerk/i18n';
import { Art, hours, StatBar, openFolder } from './common';
import { useFill } from './fill';

/* Reiter „Statistik“ (Spielzeit je Woche/Tag, Lieblingsspiele, Serie, Sitzungen) und „Screenshots“ (Galerie). */

const dayName = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(document.documentElement.lang || undefined, { weekday: 'short' });
const shortDate = (k) => new Date(`${k}T12:00:00`).toLocaleDateString(document.documentElement.lang || undefined, { day: '2-digit', month: '2-digit' });

function Bars({ data, label }) {
  const max = Math.max(60, ...data.map((x) => x.minutes));
  return (
    <div className="st-bars" role="img" aria-label={label}>
      {data.map((x) => (
        <div key={x.key} className="st-bar" title={`${x.title}: ${hours(x.minutes)}`}>
          <span className="st-bar-fill" style={{ height: `${Math.round((x.minutes / max) * 100)}%` }} />
          <span className="st-bar-label">{x.label}</span>
        </div>
      ))}
    </div>
  );
}

export function StatsTab() {
  const d = useApi('/steam/stats', [], { live: false });
  const x = d.data;
  if (!x) return d.error ? <Empty icon={BarChart3} title="The statistics could not be loaded" text={d.error} action={<Btn icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />;
  const week = x.thisWeek.reduce((a, y) => a + y.minutes, 0);
  const month = x.top.reduce((a, y) => a + y.minutes, 0);
  const maxTop = Math.max(1, ...x.top.map((y) => y.minutes));
  return (
    <>
      <div className="st-toolbar">
        <StatBar label={t('Statistics')} items={[
          { label: t('Total playtime'), value: hours(x.total), icon: Clock },
          { label: t('This week'), value: hours(week), icon: CalendarDays },
          { label: t('Last 30 days'), value: hours(month) },
          x.streak > 1 && { label: t('Days in a row'), value: x.streak, icon: Flame, tone: 'ok' },
        ]} />
        <span className="grow" />
        <InfoTip title="Where the numbers come from">{t('Steam writes the total playtime per game to its files. Hostwerk notes every increase on the day it sees it – so the weeks fill up from the day the extension was installed{since}. Sessions appear when Hostwerk runs while you play.', { since: x.since ? ` (${t('here since {d}', { d: fmtDate(new Date(`${x.since}T12:00:00`).getTime()).split(',')[0] })})` : '' })}</InfoTip>
      </div>
      <div className="cols st-cols">
        <div className="card">
          <div className="card-head"><BarChart3 size={16} aria-hidden="true" /><h3>Per week</h3></div>
          <div className="card-body"><Bars label={t('Playtime per week')} data={x.weeks.map((w) => ({ key: w.week, label: shortDate(w.week), title: t('Week of {d}', { d: shortDate(w.week) }), minutes: w.minutes }))} /></div>
        </div>
        <div className="card">
          <div className="card-head"><CalendarDays size={16} aria-hidden="true" /><h3>This week</h3></div>
          <div className="card-body"><Bars label={t('Playtime this week')} data={x.thisWeek.map((w) => ({ key: w.day, label: dayName(w.day), title: dayName(w.day), minutes: w.minutes }))} /></div>
        </div>
        <div className="card">
          <div className="card-head"><Trophy size={16} aria-hidden="true" /><h3>Most played (30 days)</h3></div>
          <div className="card-body stack">
            {x.top.length === 0 ? <TileEmpty icon={Trophy} text={t('No playtime recorded yet.')} /> : x.top.map((y) => (
              <div key={y.appid} className="row-tight st-toprow">
                <Art appid={y.appid} name={x.names[y.appid]} kind="portrait" className="st-top-art" />
                <div className="grow"><div className="row-tight"><b className="grow ellipsis">{x.names[y.appid] || t('Steam ID {id}', { id: y.appid })}</b><span className="small muted">{hours(y.minutes)}</span></div>
                  <span className="st-meter"><span style={{ width: `${Math.round((y.minutes / maxTop) * 100)}%` }} /></span></div>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><Clock size={16} aria-hidden="true" /><h3>Recent sessions</h3></div>
          <div className="card-body stack">
            {x.sessions.length === 0 ? <TileEmpty icon={Clock} text={t('Sessions appear once you play while Hostwerk runs.')} /> : x.sessions.slice(0, 6).map((s) => (
              <div key={`${s.appid}-${s.start}`} className="row-tight small"><b className="grow ellipsis">{x.names[s.appid] || s.appid}</b><span className="muted">{fmtDate(s.start)}</span><span>{hours(Math.round((s.end - s.start) / 60000))}</span></div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export function ShotsTab() {
  const d = useApi('/steam/screenshots', [], { live: false });
  const [app, setApp] = useState('');
  const [view, setView] = useState(null);
  const fill = useFill({ min: 260 });
  const items = (d.data && d.data.items) || [];
  const names = (d.data && d.data.names) || {};
  const apps = useMemo(() => { const m = new Map(); for (const s of items) m.set(s.appid, (m.get(s.appid) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); }, [items]);
  const shown = items.filter((s) => !app || String(s.appid) === app);
  if (!d.data) return d.error ? <Empty icon={ImageIcon} title="The screenshots could not be loaded" text={d.error} /> : <Loading />;
  if (!items.length) return <Empty icon={ImageIcon} title="No screenshots yet" text="Press F12 in a game – Steam saves the picture, and it shows up here." />;
  const src = (s, thumb) => apiUrl(`/api/steam/screenshot/${s.appid}/${encodeURIComponent(s.file)}${thumb && s.hasThumb ? '?thumb=1' : ''}`);
  const idx = view ? shown.findIndex((s) => s.appid === view.appid && s.file === view.file) : -1;
  const step = (n) => { const k = idx + n; if (k >= 0 && k < shown.length) setView(shown[k]); };
  return (
    <>
      <div className="st-toolbar">
        <select className="input sm select st-select" value={app} onChange={(e) => setApp(e.target.value)} aria-label={t('Game')}>
          <option value="">{t('All games ({n})', { n: items.length })}</option>
          {apps.map(([id, n]) => <option key={id} value={String(id)}>{names[id] || id} ({n})</option>)}
        </select>
        <span className="grow" />
        {app && <Btn className="sm ghost" icon={FolderOpen} onClick={() => openFolder('screenshots', app)}>Open folder</Btn>}
      </div>
      <div ref={fill} className="fill-scroll">
        <div className="st-shots">
          {shown.map((s) => (
            <button key={`${s.appid}/${s.file}`} type="button" className="st-shot" onClick={() => setView(s)} title={`${names[s.appid] || s.appid} · ${fmtDate(s.t)}`} aria-label={`${names[s.appid] || s.appid}, ${fmtDate(s.t)}`}>
              <LazyImg src={src(s, true)} fit="cover" alt="" />
            </button>
          ))}
        </div>
      </div>
      {view && (
        <Modal title={names[view.appid] || String(view.appid)} subtitle={fmtDate(view.t)} size="wide" onClose={() => setView(null)}
          footer={<><Btn className="ghost" icon={FolderOpen} onClick={() => openFolder('screenshots', view.appid)}>Open folder</Btn><span className="grow" /><Btn icon={ChevronLeft} disabled={idx <= 0} onClick={() => step(-1)}>Newer</Btn><Btn icon={ChevronRight} disabled={idx >= shown.length - 1} onClick={() => step(1)}>Older</Btn></>}>
          <img className="st-shot-big" src={src(view, false)} alt={t('Screenshot from {name}', { name: names[view.appid] || view.appid })} />
        </Modal>
      )}
    </>
  );
}
