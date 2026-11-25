import { QRCodeSVG } from 'qrcode.react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { ApiError, api, getHostPin, setHostPin } from '../lib/api';
import { activateHostPin, buildHostControllerUrl } from '../lib/hostPin';
import type { HostPinStatus } from '../lib/types';

interface HostPinPanelProps {
  remoteUrl: string;
  onToast: (message: string, error?: boolean) => void;
  /** Called after the PIN is changed/enabled/disabled so the parent can refresh /api/config. */
  onChanged?: () => void;
}

/**
 * ⚙︎ Host (Kiosk): exclusive Main Controller QR (`/remote?pin=<PIN>`) + view/edit/disable the PIN.
 * The PIN and QR stay hidden until revealed, since the TV is visible to every guest in the room.
 */
export function HostPinPanel({ remoteUrl, onToast, onChanged }: HostPinPanelProps) {
  const [status, setStatus] = useState<HostPinStatus | null>(null);
  const [locked, setLocked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.hostPinStatus();
      setStatus(next);
      setLocked(false);
      // The Kiosk on the jukebox machine learns the PIN automatically and keeps Host powers.
      if (next.pin && getHostPin() !== next.pin) setHostPin(next.pin);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setLocked(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    const pin = draft.trim();
    if (!pin) return;
    setBusy(true);
    const ok = await activateHostPin(pin, { getPin: getHostPin, setPin: setHostPin, verify: api.verifyPin });
    setBusy(false);
    if (!ok) return onToast('PIN incorreto', true);
    setDraft('');
    onToast('PIN salvo — Modo Controlador Principal ativo');
    await load();
    onChanged?.();
  };

  const update = async (patch: { pin?: string; enabled?: boolean }, ok: string) => {
    setBusy(true);
    try {
      const next = await api.updateHostPin(patch);
      setHostPin(next.pin);
      setStatus(next);
      setDraft('');
      onToast(ok);
      onChanged?.();
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  if (locked) {
    return (
      <section className="glass flex flex-col gap-2 p-4" aria-label="PIN do Controlador Principal">
        <h3 className="font-semibold">PIN do Controlador Principal</h3>
        <p className="text-xs text-zinc-400">Digite o PIN do Host (exibido no log do servidor ou no .env) para liberar os controles.</p>
        <form onSubmit={unlock} className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            aria-label="PIN do host"
            className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
            placeholder="PIN"
          />
          <button type="submit" disabled={busy} className="rounded-lg bg-accent px-3 py-2 font-semibold disabled:opacity-50">
            Salvar
          </button>
        </form>
      </section>
    );
  }

  if (!status) return null;
  const hostUrl = status.pin ? buildHostControllerUrl(remoteUrl, status.pin) : '';

  return (
    <section className="glass flex flex-col gap-3 p-4" aria-label="QR Code do Controlador Principal">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">QR Code do Controlador Principal</h3>
          <p className="text-xs text-zinc-400">
            Convidados usam o QR padrão (Modo Convidado). Este QR dá controle total da jukebox pelo celular.
          </p>
        </div>
        {status.editable && (
          <button
            type="button"
            role="switch"
            aria-label="Exigir PIN do Host"
            aria-checked={status.enabled}
            disabled={busy}
            onClick={() =>
              void update(
                { enabled: !status.enabled },
                status.enabled ? 'PIN desativado — todos os celulares têm controle total' : 'PIN do Host ativado',
              )
            }
            className={`relative h-7 w-12 shrink-0 rounded-full transition ${status.enabled ? 'bg-accent' : 'bg-white/20'}`}
          >
            <span
              className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${status.enabled ? 'left-6' : 'left-1'}`}
            />
          </button>
        )}
      </div>

      {!status.enabled ? (
        <p className="rounded-lg bg-amber-500/15 px-3 py-2 text-xs text-amber-200">
          PIN desativado: qualquer pessoa que escanear o QR terá controles de Host.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            {revealed ? (
              <div className="shrink-0 rounded-xl bg-white p-1.5">
                <QRCodeSVG value={hostUrl} size={96} aria-label="QR Code do Controlador Principal" />
              </div>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-sm">
                PIN:{' '}
                <span className="font-mono text-lg font-bold tracking-widest">{revealed ? status.pin : '••••'}</span>
                {status.source === 'env' && <span className="ml-2 text-[11px] text-zinc-400">(definido no .env)</span>}
              </p>
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="self-start rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold hover:bg-white/20"
              >
                {revealed ? 'Ocultar PIN e QR' : 'Mostrar PIN e QR do Controlador'}
              </button>
            </div>
          </div>
          {status.editable && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void update({ pin: draft.trim() }, 'PIN do Host atualizado');
              }}
              className="flex gap-2"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 8))}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                aria-label="Novo PIN do host"
                className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
                placeholder="Novo PIN (4 a 8 dígitos)"
              />
              <button
                type="submit"
                disabled={busy || draft.trim().length < 4}
                className="rounded-lg bg-accent px-3 py-2 font-semibold disabled:opacity-50"
              >
                Alterar
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
