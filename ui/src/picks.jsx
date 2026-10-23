import { useEffect, useState } from 'react';
import { Dices, Play, Server, Sparkles, Hourglass, Heart, Timer, Users, Shuffle, PackageOpen } from 'lucide-react';
import { get } from '@hostwerk/api';
import { Btn, Seg, Loading, Empty, InfoTip } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { Art, hours, ago, steam, startServer, Sheet } from './common';

/*
 * „Was spiele ich heute?“ – drei Vorschläge aus der eigenen Bibliothek nach Stimmung, „Neu würfeln“ bringt andere.
 * Ohne KI und ohne Konto: Spielzeit, zuletzt gespielt und Genres/Kategorien aus dem Steam-Shop.
 */
const MOODS = [
  { id: 'any', label: 'Surprise me', icon: Shuffle },
  { id: 'unfinished', label: 'Unfinished', icon: Hourglass },
  { id: 'forgotten', label: 'Old favourites', icon: Heart },
  { id: 'new', label: 'Never started', icon: PackageOpen },
  { id: 'short', label: 'Short session', icon: Timer },
  { id: 'friends', label: 'With friends', icon: Users },
];
const WHY = {
  new: 'Installed, but never started.',
  unfinished: 'You started it and left it – time to finish?',
  forgotten: 'You played it a lot – and not for months.',
  short: 'Good for a short session.',
  friends: 'Made for playing together.',
  any: 'Just because.',
};

export function PicksSheet({ onClose, games, serversAvailable }) {
  const [mood, setMood] = useState('any');
  const [seed, setSeed] = useState(() => Date.now());
  const [r, setR] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { let on = true; setR(null); get(`/steam/picks?mood=${mood}&seed=${seed}`).then((x) => on && setR(x)).catch((e) => on && setErr(e.message)); return () => { on = false; }; }, [mood, seed]);
  const byId = new Map((games || []).map((g) => [g.appid, g]));
  return (
    <Sheet title={t('What should I play tonight?')} subtitle={t('Three ideas from your own library')} onClose={onClose} size="wide"
      footer={<><InfoTip title="How the ideas are picked">{t('Only from your installed games: playtime, when you last played and the genres from the Steam store. No account, no AI – and the game you played last is never among them.')}</InfoTip><span className="grow" /><Btn className="primary" icon={Dices} onClick={() => setSeed(Date.now())}>Roll again</Btn></>}>
      <Seg value={mood} onChange={setMood} options={MOODS.map((m) => ({ ...m, label: t(m.label) }))} />
      {err ? <Empty icon={Dices} title="No ideas right now" text={err} /> : !r ? <Loading /> : r.picks.length === 0 ? (
        <Empty icon={Sparkles} title="Nothing fits this mood" text={mood === 'short' || mood === 'friends' ? 'Genres come from the Steam store a few minutes after Hostwerk starts – try again later or choose another mood.' : 'Choose another mood.'} />
      ) : (
        <div className="st-picks">
          {r.picks.map((p) => {
            const g = byId.get(p.appid) || { appid: p.appid, name: p.name };
            return (
              <div key={p.appid} className="card st-pick">
                <Art appid={p.appid} name={p.name} kind="portrait" className="st-pick-art" />
                <div className="card-body stack">
                  <b className="st-pick-name">{p.name}</b>
                  <span className="small">{t(WHY[p.reason] || WHY.any)}</span>
                  <span className="tiny muted">{p.playtime ? hours(p.playtime) : t('not played yet')}{p.lastPlayed ? ` · ${ago(p.lastPlayed)}` : ''}{p.genres.length ? ` · ${p.genres.join(', ')}` : ''}</span>
                  <div className="row-tight st-wrap">
                    <Btn className="sm primary" icon={Play} onClick={() => steam('run', p.appid)}>Play</Btn>
                    {p.server && serversAvailable && <Btn className="sm" icon={Server} onClick={() => startServer(g)}>Own server …</Btn>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {r && <p className="tiny muted">{t('{n} games fit this mood.', { n: r.pool })}</p>}
    </Sheet>
  );
}
