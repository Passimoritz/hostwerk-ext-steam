import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, LogIn, RefreshCw, Trash2, Play, FolderOpen, ExternalLink, Download, CheckCircle2, CircleAlert, Store } from 'lucide-react';
import { useApi, get, post, put, del, openExternal } from '@hostwerk/api';
import { Btn, Seg, Field, Empty, Loading, InfoTip, toast, confirmDialog } from '@hostwerk/ui';
import { t } from '@hostwerk/i18n';
import { hours, ago, steam } from './common';

/*
 * Spielebibliothek 2.0, Reiter „Konten“ und „Weitere Spiele“: Steam-Anmeldung (OpenID) mit eigenem Web-API-Schlüssel,
 * itch.io mit API-Schlüssel, Epic und GOG ohne Anmeldung aus den Launchern auf diesem PC. Schlüssel gehen nur an den
 * Server-Teil (versiegelt gespeichert) und kommen nie zurück. Texte englisch, Deutsch aus locales/de.json.
 */
const STORE = { steam: 'Steam', epic: 'Epic Games', gog: 'GOG', itch: 'itch.io' };

function Status({ ok, text }) {
  return <span className={`badge ${ok ? 'ok' : ''}`}>{ok ? <CheckCircle2 size={12} aria-hidden="true" /> : null} {text}</span>;
}

function KeyField({ id, label, placeholder, onSave }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => { setBusy(true); try { await onSave(v.trim()); setV(''); } catch (e) { toast.error(e); } setBusy(false); };
  return (
    <div className="row-tight st-acc-key">
      <Field label={label} className="grow"><input id={id} className="input mono" type="password" autoComplete="off" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) save(); }} /></Field>
      <Btn className="sm" icon={KeyRound} busy={busy} disabled={!v.trim()} onClick={save}>Save</Btn>
    </div>
  );
}

/** Reiter „Konten“ */
export function AccountsTab() {
  const a = useApi('/steam/accounts');
  const [busy, setBusy] = useState('');
  const wait = useRef(null);
  useEffect(() => () => clearInterval(wait.current), []);
  if (!a.data) return a.error ? <Empty icon={Store} title="Accounts could not be loaded" text={a.error.message || String(a.error)} action={<Btn icon={RefreshCw} onClick={() => a.reload()}>Try again</Btn>} /> : <Loading />;
  const x = a.data;
  const run = async (what, fn) => { setBusy(what); try { a.setData(await fn()); } catch (e) { toast.error(e); } setBusy(''); };
  const signIn = async () => {
    try {
      const { url } = await post('/steam/accounts/steam/openid');
      await openExternal(url);
      toast('Your browser opens Steam’s sign-in – Hostwerk only learns your SteamID, never your password.');
      // Die Anmeldung endet im Browser – bis zu 5 Minuten nachsehen, ob sie angekommen ist
      clearInterval(wait.current);
      const until = Date.now() + 5 * 60e3;
      wait.current = setInterval(async () => {
        if (Date.now() > until) { clearInterval(wait.current); return; }
        try { const d = await get('/steam/accounts'); if (d.steam && d.steam.connected) { clearInterval(wait.current); a.setData(d); toast.success('Connected with Steam'); } } catch { /* weiter warten */ }
      }, 3000);
    } catch (e) { toast.error(e); }
  };
  const remove = async (p) => {
    if (await confirmDialog({ title: t('Disconnect {name}?', { name: STORE[p] }), text: 'Hostwerk forgets the key and the list. Your account at the provider stays as it is.', confirm: 'Disconnect', danger: true })) run(`rm-${p}`, () => del(`/steam/accounts/${p}`));
  };
  const counted = (s) => t('{n} games in your account · updated {when}', { n: s.games, when: s.at ? ago(s.at) : '–' });
  return (
    <div className="stack st-acc">
      <p className="small muted">Connect your accounts once – Hostwerk keeps them up to date by itself. Only official ways of the providers that do not expire; keys stay encrypted on this PC.</p>
      <div className="st-acc-grid">
        <section className="card card-pad stack" aria-labelledby="acc-steam">
          <div className="row"><b id="acc-steam" className="grow">Steam</b><Status ok={x.steam.connected && x.steam.hasKey && !x.steam.error} text={x.steam.connected ? (x.steam.persona || x.steam.steamid) : t('not connected')} /></div>
          <p className="small muted">Installed games are read from this PC without any sign-in. With your account Hostwerk also sees games you own but have not installed, with playtime.</p>
          {!x.steam.connected
            ? <div><Btn className="primary sm" icon={LogIn} onClick={signIn}>Sign in through Steam</Btn></div>
            : (
              <>
                {!x.steam.hasKey && (
                  <div className="small">
                    {t('Step 2: your own Web API key – Steam needs it to list your games.')}{' '}
                    <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">steamcommunity.com/dev/apikey <ExternalLink size={12} aria-hidden="true" /></a>{' '}
                    <InfoTip pop title="Web API key">Steam gives every account a free key. Enter any domain name (for example “localhost”). The key does not expire; you can revoke it there at any time.</InfoTip>
                  </div>
                )}
                <KeyField id="acc-steam-key" label={x.steam.hasKey ? t('New Web API key') : t('Web API key')} placeholder={x.steam.hasKey ? t('•••••••• (saved)') : ''} onSave={(k) => run('steam-key', () => put('/steam/accounts/steam/key', { key: k }))} />
                {x.steam.hasKey && <div className="tiny muted">{x.steam.error ? <span className="c-err"><CircleAlert size={12} aria-hidden="true" /> {x.steam.errorAuth ? t('Steam does not accept the key – enter a new one.') : x.steam.error}</span> : counted(x.steam)}</div>}
                <div className="row-tight"><Btn className="sm ghost" icon={Trash2} busy={busy === 'rm-steam'} onClick={() => remove('steam')}>Disconnect</Btn></div>
              </>
            )}
        </section>
        <section className="card card-pad stack" aria-labelledby="acc-itch">
          <div className="row"><b id="acc-itch" className="grow">itch.io</b><Status ok={x.itch.connected && !x.itch.error} text={x.itch.connected ? (x.itch.user || t('connected')) : t('not connected')} /></div>
          <p className="small muted">Your bought games from itch.io – with your own API key from itch.io → Settings → API keys.</p>
          <KeyField id="acc-itch-key" label={x.itch.connected ? t('New API key') : t('API key')} placeholder={x.itch.connected ? t('•••••••• (saved)') : ''} onSave={(k) => run('itch-key', () => put('/steam/accounts/itch/key', { key: k }))} />
          {x.itch.connected && <div className="tiny muted">{x.itch.error ? <span className="c-err"><CircleAlert size={12} aria-hidden="true" /> {x.itch.errorAuth ? t('itch.io does not accept the key – enter a new one.') : x.itch.error}</span> : counted(x.itch)}</div>}
          {x.itch.connected && <div className="row-tight"><Btn className="sm ghost" icon={Trash2} busy={busy === 'rm-itch'} onClick={() => remove('itch')}>Disconnect</Btn></div>}
        </section>
        <section className="card card-pad stack" aria-labelledby="acc-epic">
          <div className="row"><b id="acc-epic" className="grow">Epic Games</b><Status ok={x.epic.found} text={x.epic.found ? t('{n} installed', { n: x.epic.games }) : t('not found')} /></div>
          <p className="small muted">Read from the Epic Games Launcher on this PC – no sign-in needed.</p>
        </section>
        <section className="card card-pad stack" aria-labelledby="acc-gog">
          <div className="row"><b id="acc-gog" className="grow">GOG</b><Status ok={x.gog.found} text={x.gog.found ? t('{n} installed', { n: x.gog.games }) : t('not found')} /></div>
          <p className="small muted">Read from GOG Galaxy and the GOG installers on this PC – no sign-in needed.</p>
        </section>
      </div>
      <div className="row-tight"><Btn className="sm ghost" icon={RefreshCw} busy={busy === 'refresh'} onClick={() => run('refresh', () => post('/steam/accounts/refresh'))}>Update all now</Btn></div>
    </div>
  );
}

/** Unter der Bibliothek: gekauft, aber nicht installiert (Steam-Konto) und Spiele aus anderen Shops. */
export function OtherGames() {
  const a = useApi('/steam/accounts');
  const [store, setStore] = useState('all');
  const x = a.data;
  const list = useMemo(() => {
    if (!x) return [];
    const owned = (x.owned || []).map((g) => ({ store: 'steam', id: String(g.appid), appid: g.appid, name: g.name, playtime: g.playtime, notInstalled: true }));
    return [...(x.others || []), ...owned];
  }, [x]);
  if (!list.length) return null;
  const stores = ['all', ...['epic', 'gog', 'itch', 'steam'].filter((s) => list.some((g) => g.store === s))];
  const shown = store === 'all' ? list : list.filter((g) => g.store === store);
  const act = async (g, what) => {
    try {
      if (g.store === 'steam') await steam('install', g.appid);
      else if (g.store === 'itch') { if (g.url) await openExternal(g.url); }
      else await post('/steam/accounts/launch', { store: g.store, id: g.id, what });
    } catch (e) { toast.error(e); }
  };
  return (
    <section className="card st-other" aria-labelledby="st-other-h">
      <div className="card-head">
        <Store size={16} aria-hidden="true" /><h3 id="st-other-h">More games</h3><span className="small muted">{t('{n} games', { n: list.length })}</span>
        {stores.length > 2 && <div className="right"><Seg value={store} onChange={setStore} options={stores.map((s) => ({ id: s, label: s === 'all' ? 'All' : STORE[s] }))} /></div>}
      </div>
      <div className="st-other-list">
        {shown.slice(0, 300).map((g) => (
          <div key={`${g.store}:${g.id}`} className="list-item st-other-row">
            <span className="badge">{STORE[g.store]}</span>
            <b className="grow ellipsis" title={g.name}>{g.name}</b>
            {g.notInstalled && <span className="tiny muted">{g.playtime ? t('{h} played', { h: hours(g.playtime) }) : t('never played')}</span>}
            {g.store === 'steam' && <Btn className="xs" icon={Download} onClick={() => act(g)}>Install</Btn>}
            {(g.store === 'epic' || g.store === 'gog') && <Btn className="xs" icon={Play} onClick={() => act(g, 'launch')}>Play</Btn>}
            {(g.store === 'epic' || g.store === 'gog') && g.hasDir && <Btn className="xs ghost icon" icon={FolderOpen} title="Open folder" aria-label={t('Open folder')} onClick={() => act(g, 'folder')} />}
            {g.store === 'itch' && g.url && <Btn className="xs ghost" icon={ExternalLink} onClick={() => act(g)}>itch.io</Btn>}
          </div>
        ))}
      </div>
    </section>
  );
}
