import { useState } from 'react';
import { FolderSearch, CheckCircle2, CircleAlert } from 'lucide-react';
import { get } from '@hostwerk/api';
import { Btn, toast } from '@hostwerk/ui';
import { t, pl } from '@hostwerk/i18n';

/*
 * Abschnitt in Hostwerks Einstellungen (Steckplatz settings.sections): „Prüfen“ zeigt sofort, ob im Steam-Ordner aus den
 * Einstellungen der Spielebibliothek wirklich Steam liegt – leer = was Hostwerk von selbst findet.
 */
const WHY = {
  missing: 'This folder does not exist.',
  'not-steam': 'There is no Steam in this folder (no “steamapps” folder) – choose the folder that contains steam.exe.',
  'not-found': 'Hostwerk did not find Steam by itself – enter the folder in the field “Steam folder”.',
};

export function SteamFolderCheck() {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const check = async () => {
    setBusy(true);
    try { setR(await get('/steam/folder/check')); } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  return (
    <div className="stack st-folder-check">
      <div className="row-tight st-wrap">
        <span className="small muted grow">{t('Checks the “Steam folder” of the game library (empty = found automatically).')}</span>
        <Btn className="sm" icon={FolderSearch} busy={busy} onClick={check}>Check</Btn>
      </div>
      {r && (r.ok ? (
        <div className="row-tight small" role="status">
          <CheckCircle2 size={16} className="st-tone-ok" aria-hidden="true" />
          <span>{r.custom ? t('Steam found in this folder.') : t('Steam found automatically:')} <code>{r.root}</code>{r.games != null ? ` · ${pl(r.libraries, '{n} library', '{n} libraries')}, ${pl(r.games, '{n} game', '{n} games')}` : ''}</span>
        </div>
      ) : (
        <div className="row-tight small" role="alert">
          <CircleAlert size={16} className="st-tone-warn" aria-hidden="true" />
          <span>{r.custom ? <><code>{r.custom}</code> – </> : null}{t(WHY[r.reason] || WHY['not-steam'])}</span>
        </div>
      ))}
    </div>
  );
}
