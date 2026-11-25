import { useState } from 'react';
import { api } from '../lib/api';
import type { KioskControl, KioskStageView } from '../lib/types';

const STAGE_VIEWS: { id: KioskStageView; label: string }[] = [
  { id: 'cover', label: 'Capa' },
  { id: 'lyrics', label: 'Letra' },
  { id: 'video', label: 'Clipe' },
  { id: 'cinema', label: 'Cinema' },
];

interface KioskRemoteControlsProps {
  onToast: (message: string, error?: boolean) => void;
  /** Overrides the transport (tests). */
  send?: (control: KioskControl) => Promise<unknown>;
}

/** "Player & TV" (Host on /remote): drives the local player and stage of the Kiosk TV over WebSocket. */
export function KioskRemoteControls({ onToast, send = api.kioskControl }: KioskRemoteControlsProps) {
  const [volume, setVolume] = useState(80);
  const [reactions, setReactions] = useState(true);
  const [busy, setBusy] = useState(false);

  const dispatch = async (control: KioskControl, ok?: string) => {
    setBusy(true);
    try {
      await send(control);
      if (ok) onToast(ok);
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="glass flex flex-col gap-3 p-3" aria-label="Player e TV">
      <div className="min-w-0">
        <h3 className="text-sm font-semibold">Player &amp; TV</h3>
        <p className="text-xs text-zinc-400">Controla o player local e o palco da tela Kiosk em tempo real.</p>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => void dispatch({ action: 'toggle' })}
        className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-zinc-900 disabled:opacity-50"
      >
        ⏯ Play / Pause na TV
      </button>
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <span className="shrink-0">🔊 Volume da TV</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={volume}
          aria-label="Volume do player local da TV"
          onChange={(e) => setVolume(Number(e.target.value))}
          onPointerUp={() => void dispatch({ action: 'volume', value: volume })}
          onKeyUp={() => void dispatch({ action: 'volume', value: volume })}
          className="min-w-0 flex-1 accent-[var(--color-accent,#a855f7)]"
        />
        <span className="w-8 shrink-0 text-right tabular-nums">{volume}</span>
      </label>
      <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Visualização do palco da TV">
        {STAGE_VIEWS.map((view) => (
          <button
            key={view.id}
            type="button"
            disabled={busy}
            onClick={() => void dispatch({ action: 'stage', value: view.id }, `TV: ${view.label}`)}
            className="rounded-lg bg-white/10 px-2 py-2 text-xs font-semibold hover:bg-white/20 disabled:opacity-50"
          >
            {view.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={reactions}
        disabled={busy}
        onClick={() => {
          const next = !reactions;
          setReactions(next);
          void dispatch({ action: 'reactions', value: next }, next ? 'Reações ao vivo ligadas na TV' : 'Reações ao vivo desligadas na TV');
        }}
        className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-white/15"
      >
        <span>Reações ao vivo na TV</span>
        <span className={reactions ? 'text-emerald-300' : 'text-zinc-500'}>{reactions ? 'Ligadas' : 'Desligadas'}</span>
      </button>
    </section>
  );
}
