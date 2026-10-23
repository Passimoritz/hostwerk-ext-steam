import { useEffect, useState } from 'react';
import { Tag, Search, Plus, Trash2, RefreshCw, Target, Heart, BellRing, TrendingDown, Store } from 'lucide-react';
import { get, post, del, useApi, fmtDate } from '@hostwerk/api';
import { Btn, Loading, Empty, InfoTip, Callout, Sparkline, toast, promptDialog } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';
import { Art, money, steam, StatBar } from './common';
import { useFill } from './fill';

/*
 * Reiter „Angebote“: Merkliste mit heutigem Preis, Rabatt, tiefstem gesehenen Preis und Verlauf; Zielpreis je Spiel;
 * Spiele über die Shop-Suche hinzufügen oder die öffentliche Wunschliste übernehmen. Preise ohne Schlüssel (Steam-Shop).
 */
function AddSearch({ onAdded, have }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setItems(null); return undefined; }
    const x = setTimeout(async () => { setBusy(true); try { setItems((await get(`/steam/shop/search?q=${encodeURIComponent(s)}`)).items); } catch (e) { setItems([]); toast.error(e.message); } finally { setBusy(false); } }, 450);
    return () => clearTimeout(x);
  }, [q]);
  const add = async (it) => { try { onAdded(await post('/steam/shop/watch', { appid: it.appid, name: it.name })); toast.success(t('“{name}” is on the watchlist', { name: it.name })); setQ(''); } catch (e) { toast.error(e.message); } };
  return (
    <div className="st-addsearch">
      <div className="input-icon"><Search aria-hidden="true" /><input className="input sm" type="search" placeholder={t('Add a game from the Steam store …')} aria-label={t('Search the Steam store')} value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {q.trim().length >= 2 && (
        <div className="st-results" role="listbox" aria-label={t('Search results')}>
          {busy && !items ? <div className="small muted st-pad">{t('Searching …')}</div> : (items || []).length === 0 ? <div className="small muted st-pad">{t('Nothing found.')}</div> : items.map((it) => (
            <button key={it.appid} type="button" role="option" aria-selected="false" className="st-result" disabled={have.has(it.appid)} onClick={() => add(it)}>
              <Art appid={it.appid} name={it.name} kind="header" className="st-result-art" />
              <span className="grow ellipsis">{it.name}</span>
              <span className="small muted">{it.final != null ? money(it.final, it.currency) : ''}</span>
              {have.has(it.appid) ? <span className="badge">{t('on the list')}</span> : <Plus size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DealsTab() {
  const d = useApi('/steam/shop', [], { live: false });
  const fill = useFill({ min: 240 });
  const [busy, setBusy] = useState(false);
  const x = d.data;
  if (!x) return d.error ? <Empty icon={Tag} title="The watchlist could not be loaded" text={d.error} action={<Btn icon={RefreshCw} onClick={() => d.reload()}>Try again</Btn>} /> : <Loading />;
  const watch = [...x.watch].sort((a, b) => ((b.price && b.price.discount) || 0) - ((a.price && a.price.discount) || 0) || a.name.localeCompare(b.name));
  const onSale = watch.filter((w) => w.price && w.price.discount > 0);
  const atTarget = watch.filter((w) => w.price && w.target != null && w.price.final <= w.target);
  const have = new Set(watch.map((w) => w.appid));
  const refresh = async () => { setBusy(true); try { d.setData(await post('/steam/shop/refresh')); toast.success(t('Prices updated')); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  const wishlist = async () => { setBusy(true); try { const r = await post('/steam/shop/wishlist'); d.setData(r); toast.success(pl(r.added, '{n} game taken over', '{n} games taken over')); } catch (e) { toast.error(e.message); } finally { setBusy(false); } };
  const remove = async (w) => { try { d.setData(await del(`/steam/shop/watch/${w.appid}`)); } catch (e) { toast.error(e.message); } };
  const target = async (w) => {
    const cur = w.target != null ? (w.target / 100).toFixed(2) : '';
    const r = await promptDialog({ title: t('Target price for {name}', { name: w.name }), label: t('Notify me at this price or lower (empty = any discount)'), value: cur, confirm: t('Save') });
    if (r === null || r === undefined || r === false) return;
    const v = String(r && typeof r === 'object' ? r.value : r).replace(',', '.').trim();
    const cents = v === '' ? null : Math.round(Number(v) * 100);
    if (v !== '' && !Number.isFinite(cents)) { toast.error(t('Please enter a price like 9.99')); return; }
    try { d.setData(await post('/steam/shop/watch', { appid: w.appid, name: w.name, target: cents })); toast.success(t('Saved')); } catch (e) { toast.error(e.message); }
  };
  return (
    <>
      {x.blocked && <Callout kind="warn" title="Steam asked for a break" dismissible={false}>{t('The store limits requests without a key – Hostwerk tries again in a few minutes.')}</Callout>}
      <div className="st-toolbar">
        <StatBar label={t('Watchlist')} items={[
          { label: t('On the watchlist'), value: watch.length, icon: Heart },
          { label: t('On sale'), value: onSale.length, icon: Tag, tone: onSale.length ? 'ok' : undefined },
          atTarget.length > 0 && { label: t('At your target price'), value: atTarget.length, icon: Target, tone: 'ok' },
        ]} />
        <span className="grow" />
        <InfoTip title="Prices and alerts">{t('Prices come from the Steam store (country {cc}, change it in the extension’s settings), twice a day and without a key. {notify} Hostwerk remembers every price change and shows the lowest price it has seen.', { cc: x.country, notify: x.notify ? t('A new sale or your target price sends one bundled notification.') : t('Notifications are switched off in the settings.') })}</InfoTip>
        <Btn className="sm ghost" icon={Heart} onClick={wishlist} busy={busy} disabled={x.offline} title={t('Take over your public Steam wishlist')}>Take over wishlist</Btn>
        <Btn className="sm ghost" icon={RefreshCw} onClick={refresh} busy={busy} disabled={x.offline}>Update prices</Btn>
      </div>
      <AddSearch have={have} onAdded={(v) => d.setData(v)} />
      <div ref={fill} className="fill-scroll">
        {watch.length === 0 ? <Empty icon={BellRing} title="No games on the watchlist yet" text="Search a game above or take over your public Steam wishlist – Hostwerk tells you when it is on sale." /> : (
          <div className="list-rows">
            {watch.map((w) => {
              const p = w.price;
              const hist = (w.history || []).map((h) => h[1]);
              const lowest = p && p.lowest != null && p.lowest < p.final;
              return (
                <div key={w.appid} className="list-row-item">
                  <Art appid={w.appid} name={w.name} kind="header" className="st-deal-art" />
                  <div className="grow">
                    <div className="list-row-title">{w.name}</div>
                    <div className="list-row-sub">
                      {w.details && w.details.genres && w.details.genres.length ? `${w.details.genres.slice(0, 3).join(', ')} · ` : ''}
                      {w.target != null ? `${t('target {price}', { price: money(w.target, p && p.currency) })} · ` : ''}
                      {p && p.at ? t('checked {when}', { when: fmtDate(p.at) }) : t('not checked yet')}
                    </div>
                  </div>
                  {hist.length > 1 && <span className="st-spark" title={t('Price history')}><Sparkline data={hist} width={90} height={26} /></span>}
                  <div className="st-price">
                    {!p ? <span className="small muted">–</span> : p.free ? <b>{t('Free')}</b> : p.unavailable ? <span className="small muted">{t('not in the store')}</span> : (
                      <>
                        {p.discount > 0 && <span className="badge ok">−{p.discount} %</span>}
                        {p.discount > 0 && <s className="small muted">{money(p.initial, p.currency)}</s>}
                        <b>{money(p.final, p.currency)}</b>
                        {lowest && <span className="tiny muted" title={t('Lowest price Hostwerk has seen')}><TrendingDown size={11} aria-hidden="true" /> {money(p.lowest, p.currency)}</span>}
                      </>
                    )}
                  </div>
                  <Btn className="xs ghost" icon={Target} title={t('Target price')} aria-label={t('Target price')} onClick={() => target(w)} />
                  <Btn className="xs ghost" icon={Store} title={t('Open in the Steam store')} aria-label={t('Open in the Steam store')} onClick={() => steam('store', w.appid)} />
                  <Btn className="xs ghost" icon={Trash2} title={t('Remove from the watchlist')} aria-label={t('Remove from the watchlist')} onClick={() => remove(w)} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
