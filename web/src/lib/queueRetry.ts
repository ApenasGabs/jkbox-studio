import { useCallback, useRef, useState } from 'react';
import { api } from './api';
import type { QueueEntry } from './types';

export type QueueRetryToastFn = (message: string, error?: boolean) => void;

export interface QueueRetryApi {
  retry: (trackId: string) => Promise<{ cached: boolean }>;
  retryFailedQueue: () => Promise<{ retried: number; cached: number }>;
  clearFailedQueue: () => Promise<{ removed: number }>;
}

export interface QueueRetryControllerOptions {
  apiClient?: QueueRetryApi;
  onToast: QueueRetryToastFn;
  onRetryingChange?: (trackId: string, busy: boolean) => void;
  onBatchRetryBusyChange?: (busy: boolean) => void;
  onBatchClearBusyChange?: (busy: boolean) => void;
}

/**
 * Pure controller for single-track and batch queue retry/clear actions with synchronous
 * re-entrancy guards so double-taps cannot fire duplicate requests.
 */
export function createQueueRetryController({
  apiClient = api,
  onToast,
  onRetryingChange,
  onBatchRetryBusyChange,
  onBatchClearBusyChange,
}: QueueRetryControllerOptions) {
  const retryingTrackIds = new Set<string>();
  let batchRetryBusy = false;
  let batchClearBusy = false;

  const retryEntry = async (entry: Pick<QueueEntry, 'trackId'>): Promise<boolean> => {
    if (retryingTrackIds.has(entry.trackId)) return false;
    retryingTrackIds.add(entry.trackId);
    onRetryingChange?.(entry.trackId, true);
    try {
      const { cached } = await apiClient.retry(entry.trackId);
      onToast(cached ? 'Faixa já está pronta no acervo ⚡' : 'Tentando baixar novamente…');
      return true;
    } catch (err) {
      onToast((err as Error).message, true);
      return false;
    } finally {
      retryingTrackIds.delete(entry.trackId);
      onRetryingChange?.(entry.trackId, false);
    }
  };

  const retryAllFailed = async (): Promise<boolean> => {
    if (batchRetryBusy) return false;
    batchRetryBusy = true;
    onBatchRetryBusyChange?.(true);
    try {
      const { retried, cached } = await apiClient.retryFailedQueue();
      if (retried === 0) {
        onToast('Nenhuma faixa com falha na fila');
      } else if (cached === retried) {
        onToast(`${retried} faixa${retried === 1 ? '' : 's'} pronta${retried === 1 ? '' : 's'} no acervo ⚡`);
      } else {
        onToast(`Tentando baixar novamente ${retried} faixa${retried === 1 ? '' : 's'} com falha…`);
      }
      return true;
    } catch (err) {
      onToast((err as Error).message, true);
      return false;
    } finally {
      batchRetryBusy = false;
      onBatchRetryBusyChange?.(false);
    }
  };

  const clearFailed = async (): Promise<boolean> => {
    if (batchClearBusy) return false;
    batchClearBusy = true;
    onBatchClearBusyChange?.(true);
    try {
      const { removed } = await apiClient.clearFailedQueue();
      if (removed === 0) {
        onToast('Nenhuma falha para remover da fila');
      } else {
        onToast(`${removed} faixa${removed === 1 ? '' : 's'} com falha removida${removed === 1 ? '' : 's'} da fila`);
      }
      return true;
    } catch (err) {
      onToast((err as Error).message, true);
      return false;
    } finally {
      batchClearBusy = false;
      onBatchClearBusyChange?.(false);
    }
  };

  return {
    retryEntry,
    retryAllFailed,
    clearFailed,
    isRetrying: (trackId: string) => retryingTrackIds.has(trackId),
    isBatchRetryBusy: () => batchRetryBusy,
    isBatchClearBusy: () => batchClearBusy,
  };
}

/** Shared hook for queue retry and failed-item cleanup actions in Remote and Kiosk. */
export function useQueueRetryActions(onToast: QueueRetryToastFn) {
  const [retryingIds, setRetryingIds] = useState<Record<string, boolean>>({});
  const [batchRetryBusy, setBatchRetryBusy] = useState(false);
  const [batchClearBusy, setBatchClearBusy] = useState(false);
  const toastRef = useRef(onToast);
  toastRef.current = onToast;

  const controllerRef = useRef<ReturnType<typeof createQueueRetryController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createQueueRetryController({
      onToast: (message, error) => toastRef.current(message, error),
      onRetryingChange: (trackId, busy) => {
        setRetryingIds((prev) => {
          if (busy) return { ...prev, [trackId]: true };
          if (!prev[trackId]) return prev;
          const next = { ...prev };
          delete next[trackId];
          return next;
        });
      },
      onBatchRetryBusyChange: setBatchRetryBusy,
      onBatchClearBusyChange: setBatchClearBusy,
    });
  }

  const retryEntry = useCallback((entry: QueueEntry) => controllerRef.current!.retryEntry(entry), []);
  const retryAllFailed = useCallback(() => controllerRef.current!.retryAllFailed(), []);
  const clearFailed = useCallback(() => controllerRef.current!.clearFailed(), []);

  return {
    retryingIds,
    batchRetryBusy,
    batchClearBusy,
    retryEntry,
    retryAllFailed,
    clearFailed,
  };
}
