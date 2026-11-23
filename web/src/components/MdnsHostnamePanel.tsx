import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { MdnsStatus } from '../lib/types';

interface MdnsHostnamePanelProps {
  mdns: MdnsStatus | null | undefined;
  onUpdated: (mdns: MdnsStatus) => void;
  onToast: (message: string, error?: boolean) => void;
}

const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MdnsHostnamePanel = ({ mdns, onUpdated, onToast }: MdnsHostnamePanelProps) => {
  const [hostname, setHostname] = useState(mdns?.hostname ?? 'jkbox');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mdns?.hostname) setHostname(mdns.hostname);
  }, [mdns?.hostname]);

  if (!mdns) return null;

  const cleaned = hostname.trim().toLowerCase().replace(/\.local\.?$/i, '');
  const isValid = cleaned.length >= 2 && cleaned.length <= 63 && HOSTNAME_RE.test(cleaned);
  const changed = cleaned !== mdns.hostname;

  const handleSave = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      const res = await api.updateHostname({ hostname: cleaned });
      onUpdated(res.mdns);
      onToast(`Endereço atualizado para ${res.mdns.fqdn}`);
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleQr = async () => {
    if (!mdns || saving) return;
    setSaving(true);
    try {
      const next = !mdns.useForQr;
      const res = await api.updateHostname({ useForQr: next });
      onUpdated(res.mdns);
      onToast(next ? `QR Code usando ${res.mdns.fqdn}` : 'QR Code usando URL padrão');
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = () => {
    if (!mdns) return;
    void navigator.clipboard?.writeText(mdns.url).then(
      () => onToast(`Copiado: ${mdns.url}`),
      () => onToast(mdns.url),
    );
  };

  const badge =
    mdns.mode === 'disabled'
      ? { text: 'Desativado', cls: 'bg-white/10 text-zinc-400' }
      : mdns.dockerBridgeHint
        ? { text: 'Docker bridge', cls: 'bg-amber-500/20 text-amber-300' }
        : mdns.active
          ? { text: mdns.mode === 'os-helper' ? 'OS / Avahi' : 'Ativo (mDNS)', cls: 'bg-emerald-500/20 text-emerald-300' }
          : { text: 'Indisponível', cls: 'bg-red-500/20 text-red-300' };

  return (
    <section className="glass flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Endereço na Rede (.local)</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>{badge.text}</span>
      </div>

      <p className="text-xs text-zinc-400">
        Acesse a jukebox na rede local por um nome amigável (ex: <code>jkbox.local</code>, <code>gabisa.local</code>).
      </p>

      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center rounded-lg bg-white/10 px-3 py-2 focus-within:ring-2 focus-within:ring-accent">
          <input
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && isValid && changed) {
                e.preventDefault();
                void handleSave();
              }
            }}
            aria-label="Nome na rede (.local)"
            placeholder="jkbox"
            spellCheck={false}
            autoCapitalize="none"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <span className="shrink-0 text-xs font-semibold text-zinc-400">.local</span>
        </div>
        <button
          type="button"
          disabled={!isValid || !changed || saving}
          onClick={() => void handleSave()}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
        >
          {saving ? '...' : 'Salvar'}
        </button>
      </div>

      {!isValid && hostname.trim().length > 0 && (
        <p className="text-xs text-red-300">
          Use de 2 a 63 caracteres: letras minúsculas, números e hífen.
        </p>
      )}

      <div className="flex items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 text-xs">
        <span className="truncate font-mono text-accent-2">{mdns.url}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded-md bg-white/10 px-2 py-1 font-semibold hover:bg-white/20"
        >
          Copiar
        </button>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs text-zinc-300">Usar endereço .local no QR Code</span>
        <button
          type="button"
          role="switch"
          aria-label="Usar endereço .local no QR Code"
          aria-checked={mdns.useForQr}
          disabled={saving}
          onClick={() => void handleToggleQr()}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${
            mdns.useForQr ? 'bg-accent' : 'bg-white/20'
          } disabled:opacity-50`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
              mdns.useForQr ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {mdns.dockerBridgeHint && (
        <p className="rounded-lg bg-amber-500/10 p-2 text-[11px] text-amber-200">
          Rodando em Docker bridge: para anunciar <code>{mdns.fqdn}</code> na rede local, use{' '}
          <code>network_mode: host</code> no <code>docker-compose.yml</code> (Linux) ou rode nativo.
        </p>
      )}
    </section>
  );
}
