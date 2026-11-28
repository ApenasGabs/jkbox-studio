import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { copyTextToClipboard } from '../lib/clipboard';
import type { SystemUpdateApplyResult, SystemUpdateStatus } from '../lib/types';

export interface SystemUpdatePanelProps {
  onToast: (message: string, error?: boolean) => void;
  reloadKey?: number;
  /** Optional initial state (tests / SSR). */
  initialStatus?: SystemUpdateStatus | null;
  /** Polling interval for `/api/health` while waiting for server restart (ms). */
  pollIntervalMs?: number;
  /** Overridable transport/reload hooks for tests. */
  fetchStatus?: (refresh?: boolean) => Promise<SystemUpdateStatus>;
  applyUpdate?: () => Promise<SystemUpdateApplyResult>;
  fetchHealth?: () => Promise<{ ok: boolean; version?: string }>;
  onReload?: () => void;
}

export function normalizeVersion(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/^v/i, '');
}

function formatPublishedDate(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return new Date(ts).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function shouldReloadAfterHealth(
  health: { ok: boolean; version?: string },
  baselineVersion: string | null,
  sawDisconnect: boolean,
): boolean {
  if (!health.ok) return false;
  const prev = normalizeVersion(baselineVersion);
  const next = normalizeVersion(health.version);
  if (prev && next && next !== prev) return true;
  return sawDisconnect;
}

/**
 * Host card for OTA system updates (Kiosk `⚙︎ Host` and `/remote` Host panel).
 * Queries `GET /api/system/update`, triggers `POST /api/system/update/apply` on Kiosk OS,
 * and polls `/api/health` until the server returns on the new version.
 */
export function SystemUpdatePanel({
  onToast,
  reloadKey = 0,
  initialStatus,
  pollIntervalMs = 1500,
  fetchStatus = (refresh) => api.systemUpdate(refresh),
  applyUpdate = () => api.applySystemUpdate(),
  fetchHealth = () => api.health(),
  onReload = () => window.location.reload(),
}: SystemUpdatePanelProps) {
  const [status, setStatus] = useState<SystemUpdateStatus | null>(initialStatus ?? null);
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [updating, setUpdating] = useState(Boolean(initialStatus?.updating));

  const baselineVersionRef = useRef<string | null>(initialStatus?.currentVersion ?? null);
  const sawDisconnectRef = useRef(false);
  const updateStartedAtRef = useRef<number>(0);

  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const onReloadRef = useRef(onReload);
  onReloadRef.current = onReload;
  const fetchStatusRef = useRef(fetchStatus);
  fetchStatusRef.current = fetchStatus;
  const fetchHealthRef = useRef(fetchHealth);
  fetchHealthRef.current = fetchHealth;

  const loadStatus = useCallback(async (refresh: boolean, showToast: boolean) => {
    setChecking(true);
    try {
      const next = await fetchStatusRef.current(refresh);
      setStatus(next);
      setLocked(false);
      if (!baselineVersionRef.current) baselineVersionRef.current = next.currentVersion;
      if (next.updating) {
        updateStartedAtRef.current = updateStartedAtRef.current || Date.now();
        setUpdating(true);
      }
      if (showToast) {
        if (next.checkError) {
          onToastRef.current(next.checkError, true);
        } else if (next.updateAvailable && next.latestVersion) {
          onToastRef.current(`Nova versão disponível: ${next.latestVersion}`);
        } else {
          onToastRef.current(`Sistema atualizado (${next.currentVersion})`);
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setLocked(true);
      } else if (showToast) {
        onToastRef.current((err as Error).message, true);
      }
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (initialStatus !== undefined) return;
    void loadStatus(false, false);
  }, [initialStatus, loadStatus, reloadKey]);

  useEffect(() => {
    if (!updating) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;
    if (!updateStartedAtRef.current) updateStartedAtRef.current = Date.now();

    const tick = async () => {
      if (cancelled) return;
      pollCount += 1;
      try {
        const health = await fetchHealthRef.current();
        if (cancelled) return;
        if (shouldReloadAfterHealth(health, baselineVersionRef.current, sawDisconnectRef.current)) {
          onReloadRef.current();
          return;
        }
      } catch {
        sawDisconnectRef.current = true;
      }

      const elapsed = Date.now() - updateStartedAtRef.current;
      if (!sawDisconnectRef.current && elapsed > 15_000 && pollCount % 6 === 0) {
        try {
          const current = await fetchStatusRef.current(false);
          if (cancelled) return;
          setStatus(current);
          if (!current.updating) {
            setUpdating(false);
            if (
              baselineVersionRef.current &&
              normalizeVersion(current.currentVersion) !== normalizeVersion(baselineVersionRef.current)
            ) {
              onReloadRef.current();
              return;
            }
            onToastRef.current('Atualização encerrada sem reinício. Verifique os logs ou tente novamente.', true);
            return;
          }
        } catch {
          sawDisconnectRef.current = true;
        }
      }

      if (!cancelled) {
        timer = setTimeout(() => {
          void tick();
        }, pollIntervalMs);
      }
    };

    timer = setTimeout(() => {
      void tick();
    }, pollIntervalMs);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pollIntervalMs, updating]);

  const handleApply = async () => {
    if (applying || updating) return;
    setApplying(true);
    try {
      const res = await applyUpdate();
      if (!res.supported) {
        onToast(res.message);
        return;
      }
      if (res.started || res.updating) {
        baselineVersionRef.current = status?.currentVersion ?? baselineVersionRef.current;
        sawDisconnectRef.current = false;
        updateStartedAtRef.current = Date.now();
        setUpdating(true);
        setStatus((prev) => (prev ? { ...prev, updating: true } : prev));
        onToast(res.message);
      }
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setApplying(false);
    }
  };

  const badge = updating
    ? { text: 'Atualizando…', cls: 'bg-amber-500/20 text-amber-200 animate-pulse' }
    : status?.updateAvailable
      ? { text: `Nova: ${status.latestVersion}`, cls: 'bg-accent/25 text-purple-100 border border-accent/40' }
      : status?.mode === 'docker'
        ? { text: 'Docker', cls: 'bg-amber-500/20 text-amber-300' }
        : status?.mode === 'dev'
          ? { text: 'Dev', cls: 'bg-white/10 text-zinc-300' }
          : status?.latestVersion
            ? { text: 'Atualizado', cls: 'bg-emerald-500/20 text-emerald-300' }
            : { text: 'Kiosk OS', cls: 'bg-white/10 text-zinc-300' };

  const publishedDate = formatPublishedDate(status?.publishedAt ?? null);

  return (
    <section className="glass flex flex-col gap-3 p-4" data-system-update-panel="true">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 font-semibold">
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 text-accent-2"
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          <span>Atualização do Sistema</span>
        </h3>
        <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${badge.cls}`}>
          {badge.text}
        </span>
      </div>

      {locked ? (
        <p className="text-xs text-zinc-400">Desbloqueie o PIN do Host para verificar e instalar atualizações.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/25 px-3 py-2 text-xs">
            <span className="text-zinc-400">
              Versão instalada:{' '}
              <code className="font-mono font-semibold text-zinc-100">{status?.currentVersion ?? '…'}</code>
            </span>
            {status?.latestVersion && (
              <span className="text-zinc-400">
                Última:{' '}
                <code className="font-mono font-semibold text-accent-2">{status.latestVersion}</code>
                {publishedDate ? ` (${publishedDate})` : ''}
              </span>
            )}
          </div>

          <button
            type="button"
            disabled={checking || updating}
            onClick={() => void loadStatus(true, true)}
            className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-white/20 disabled:opacity-50"
          >
            {checking ? 'Procurando atualizações…' : 'Procurar atualizações'}
          </button>

          {updating && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-xl border border-amber-400/40 bg-amber-500/15 p-3 text-xs text-amber-100"
            >
              <p className="font-semibold">Baixando e aplicando atualização… aguarde a reconexão automática</p>
              <p className="mt-1 text-[11px] text-amber-200/80">
                O servidor será reiniciado na nova versão e esta página será recarregada automaticamente.
              </p>
            </div>
          )}

          {!updating && status?.updateAvailable && status.latestVersion && (
            <div className="flex flex-col gap-2.5 rounded-xl border border-accent/40 bg-accent/15 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-purple-100">
                  Nova versão disponível: <code className="font-mono">{status.latestVersion}</code>
                </span>
                {publishedDate && <span className="text-[11px] text-zinc-300">{publishedDate}</span>}
              </div>

              {status.releaseNotes && (
                <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-2 font-sans text-[11px] leading-relaxed text-zinc-200">
                  {status.releaseNotes}
                </pre>
              )}

              {status.supported ? (
                <button
                  type="button"
                  disabled={applying}
                  onClick={() => void handleApply()}
                  className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                >
                  {applying ? 'Iniciando atualização…' : 'Atualizar agora'}
                </button>
              ) : (
                <DockerUpdateHint
                  command={status.dockerCommand ?? 'docker compose pull && docker compose up -d'}
                  onToast={onToast}
                />
              )}
            </div>
          )}

          {!updating && status && !status.supported && !status.updateAvailable && (
            <DockerUpdateHint
              command={status.dockerCommand ?? 'docker compose pull && docker compose up -d'}
              onToast={onToast}
              subtle
            />
          )}

          {status?.checkError && (
            <p className="rounded-lg bg-red-500/10 p-2 text-[11px] text-red-200">{status.checkError}</p>
          )}
        </>
      )}
    </section>
  );
}

function DockerUpdateHint({
  command,
  onToast,
  subtle = false,
}: {
  command: string;
  onToast: (message: string, error?: boolean) => void;
  subtle?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-lg p-2.5 text-[11px] ${
        subtle ? 'bg-black/25 text-zinc-300' : 'bg-amber-500/15 text-amber-100'
      }`}
    >
      <p>
        Atualização com 1 clique é exclusiva do <strong>Kiosk OS</strong>. No Docker, atualize pelo host:
      </p>
      <div className="flex items-center justify-between gap-2 rounded-md bg-black/40 px-2.5 py-1.5">
        <code className="min-w-0 truncate font-mono text-[11px] text-accent-2">{command}</code>
        <button
          type="button"
          onClick={() =>
            void copyTextToClipboard(command).then((copied) =>
              onToast(copied ? 'Comando copiado' : command),
            )
          }
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-white/20"
        >
          Copiar
        </button>
      </div>
    </div>
  );
}
