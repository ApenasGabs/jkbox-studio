import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueueList } from '../components/QueueList';
import { Remote } from '../pages/Remote';
import { api } from './api';
import { createQueueRetryController } from './queueRetry';
import type { AppConfig, JukeboxState, QueueEntry } from './types';
import type { DownloadInfo } from './useJukebox';

function makeEntry(overrides: Partial<QueueEntry> & { id: number; trackId: string; requesterId: string }): QueueEntry {
  const { id, trackId, requesterId, track: trackOverride, ...rest } = overrides;
  return {
    id,
    trackId,
    requesterId,
    requesterName: 'Convidado',
    addedAt: 1_700_000_000_000 + id,
    votes: 0,
    voters: [],
    track: {
      id: trackId,
      source: 'youtube',
      sourceId: `yt-${trackId}`,
      title: `Música ${trackId}`,
      artist: 'Banda Teste',
      album: null,
      durationSec: 210,
      thumbnail: null,
      status: 'error',
      progress: 0,
      error: 'yt-dlp exit 1',
      ...trackOverride,
    },
    ...rest,
  };
}

const HOST_REQUIRED_CONFIG: AppConfig = {
  publicUrl: null,
  hostPinRequired: true,
  audioFormat: 'mp3',
  videoMode: 'off',
  autoDjEnabled: false,
  playbackOutput: { type: 'local' },
  spotify: {
    configured: false,
    connected: false,
    playbackAuthorized: false,
    playlistId: null,
    playlistUrl: null,
    redirectUri: null,
  },
};

function findElements(node: ReactNode, predicate: (el: ReactElement<Record<string, unknown>>) => boolean): ReactElement<Record<string, unknown>>[] {
  const matches: ReactElement<Record<string, unknown>>[] = [];
  const visit = (cur: ReactNode) => {
    if (Array.isArray(cur)) {
      for (const item of cur) visit(item);
      return;
    }
    if (!isValidElement(cur)) return;
    const el = cur as ReactElement<Record<string, unknown>>;
    if (predicate(el)) matches.push(el);
    if (el.props) {
      for (const value of Object.values(el.props)) {
        if (isValidElement(value) || Array.isArray(value)) visit(value as ReactNode);
      }
    }
  };
  visit(node);
  return matches;
}

function elementText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elementText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return elementText(props.children);
  }
  return '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('/remote QueueList — tentar de novo e ações em lote (Host e Convidado)', () => {
  const myFailed = makeEntry({
    id: 1,
    trackId: 'track-mine',
    requesterId: 'guest-me',
    requesterName: 'Eu',
    track: {
      id: 'track-mine',
      source: 'youtube',
      sourceId: 'yt-mine',
      title: 'Minha Música com Erro',
      artist: 'Artista A',
      album: null,
      durationSec: 185,
      thumbnail: null,
      status: 'error',
      progress: 0,
      error: 'timeout',
    },
  });

  const otherFailed = makeEntry({
    id: 2,
    trackId: 'track-other',
    requesterId: 'guest-other',
    requesterName: 'Outro',
    track: {
      id: 'track-other',
      source: 'youtube',
      sourceId: 'yt-other',
      title: 'Música de Outro com Erro',
      artist: 'Artista B',
      album: null,
      durationSec: 200,
      thumbnail: null,
      status: 'error',
      progress: 0,
      error: 'network',
    },
  });

  const readyEntry = makeEntry({
    id: 3,
    trackId: 'track-ready',
    requesterId: 'guest-other',
    requesterName: 'Outro',
    track: {
      id: 'track-ready',
      source: 'youtube',
      sourceId: 'yt-ready',
      title: 'Música Pronta',
      artist: 'Artista C',
      album: null,
      durationSec: 190,
      thumbnail: null,
      status: 'ready',
      progress: 1,
      error: null,
    },
  });

  const mixedState: JukeboxState = {
    nowPlaying: null,
    queue: [myFailed, otherFailed, readyEntry],
  };

  it('exibe botão "tentar de novo" apenas no próprio pedido do convidado e oculta ações em lote do Host', () => {
    const html = renderToStaticMarkup(
      <Remote
        initialView="queue"
        initialState={mixedState}
        initialConfig={HOST_REQUIRED_CONFIG}
        initialHostVerified={false}
        clientId="guest-me"
        locationHref="http://192.168.31.50:3000/remote"
      />,
    );

    expect(html).toContain('Minha Música com Erro');
    expect(html).toContain('Música de Outro com Erro');
    expect(html).toContain('falha no download');
    expect(html).toContain('aria-label="Tentar baixar novamente Minha Música com Erro"');
    expect(html).not.toContain('aria-label="Tentar baixar novamente Música de Outro com Erro"');
    expect(html).not.toContain('Tentar novamente todas com falha');
    expect(html).not.toContain('Limpar falhas da fila');
  });

  it('no Modo Host no /remote, exibe "tentar de novo" para qualquer falha e exibe ações rápidas em lote', () => {
    const html = renderToStaticMarkup(
      <Remote
        initialView="queue"
        initialState={mixedState}
        initialConfig={HOST_REQUIRED_CONFIG}
        initialHostVerified={true}
        clientId="host-client"
        locationHref="http://192.168.31.50:3000/remote"
      />,
    );

    expect(html).toContain('aria-label="Tentar baixar novamente Minha Música com Erro"');
    expect(html).toContain('aria-label="Tentar baixar novamente Música de Outro com Erro"');
    expect(html).toContain('↻ Tentar novamente todas com falha');
    expect(html).toContain('Limpar falhas da fila');
    expect(html).toContain('2 faixas com falha no download');
  });

  it('oculta ações rápidas em lote quando não há itens com falha na fila', () => {
    const html = renderToStaticMarkup(
      <Remote
        initialView="queue"
        initialState={{ nowPlaying: null, queue: [readyEntry] }}
        initialConfig={HOST_REQUIRED_CONFIG}
        initialHostVerified={true}
        clientId="host-client"
      />,
    );

    expect(html).not.toContain('Tentar novamente todas com falha');
    expect(html).not.toContain('Limpar falhas da fila');
    expect(html).not.toContain('tentar de novo');
  });

  it('usa status em tempo real de downloads (WebSocket) para mostrar ou esconder "tentar de novo"', () => {
    const liveDownloads: Record<string, DownloadInfo> = {
      'track-mine': { status: 'downloading', progress: 0.45, error: null },
    };

    const html = renderToStaticMarkup(
      <Remote
        initialView="queue"
        initialState={{ nowPlaying: null, queue: [myFailed] }}
        initialDownloads={liveDownloads}
        initialConfig={HOST_REQUIRED_CONFIG}
        initialHostVerified={false}
        clientId="guest-me"
      />,
    );

    expect(html).toContain('baixando 45%');
    expect(html).not.toContain('tentar de novo');
    expect(html).not.toContain('falha no download');
  });

  it('dispara clique de "tentar de novo", "↻ Tentar novamente todas com falha" e "Limpar falhas da fila" via QueueList', async () => {
    const retrySpy = vi.spyOn(api, 'retry').mockResolvedValue({ cached: false });
    const retryAllSpy = vi.spyOn(api, 'retryFailedQueue').mockResolvedValue({ retried: 2, cached: 0 });
    const clearFailedSpy = vi.spyOn(api, 'clearFailedQueue').mockResolvedValue({ removed: 2 });
    const toasts: Array<{ message: string; error?: boolean }> = [];
    const controller = createQueueRetryController({
      onToast: (message, error) => toasts.push({ message, error }),
    });

    const tree = QueueList({
      queue: [myFailed, otherFailed, readyEntry],
      downloads: {},
      clientId: 'host-client',
      onVote: () => {},
      onRemove: () => {},
      onRetry: controller.retryEntry,
      canRemove: () => true,
      canRetry: () => true,
      canManageFailed: true,
      onRetryAllFailed: controller.retryAllFailed,
      onClearFailed: controller.clearFailed,
    });

    const buttons = findElements(tree, (el) => el.type === 'button');
    const retryBtn = buttons.find((b) => b.props['aria-label'] === 'Tentar baixar novamente Minha Música com Erro');
    const retryAllBtn = buttons.find((b) => elementText(b.props.children as ReactNode).includes('Tentar novamente todas com falha'));
    const clearBtn = buttons.find((b) => elementText(b.props.children as ReactNode).includes('Limpar falhas da fila'));

    expect(retryBtn).toBeDefined();
    expect(retryAllBtn).toBeDefined();
    expect(clearBtn).toBeDefined();

    await (retryBtn!.props.onClick as () => Promise<void>)();
    await (retryAllBtn!.props.onClick as () => Promise<void>)();
    await (clearBtn!.props.onClick as () => Promise<void>)();

    expect(retrySpy).toHaveBeenCalledWith('track-mine');
    expect(retryAllSpy).toHaveBeenCalledTimes(1);
    expect(clearFailedSpy).toHaveBeenCalledTimes(1);
    expect(toasts).toEqual([
      { message: 'Tentando baixar novamente…', error: undefined },
      { message: 'Tentando baixar novamente 2 faixas com falha…', error: undefined },
      { message: '2 faixas com falha removidas da fila', error: undefined },
    ]);
  });

  it('evita cliques duplicados enquanto retry individual ou em lote estão em andamento e exibe feedback de erro', async () => {
    let resolveRetry!: (value: { cached: boolean }) => void;
    const retryMock = vi.fn(
      () =>
        new Promise<{ cached: boolean }>((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const retryFailedQueueMock = vi.fn().mockRejectedValue(new Error('PIN inválido'));
    const clearFailedQueueMock = vi.fn().mockResolvedValue({ removed: 0 });
    const retryingStates: boolean[] = [];
    const toasts: Array<{ message: string; error?: boolean }> = [];

    const controller = createQueueRetryController({
      apiClient: {
        retry: retryMock,
        retryFailedQueue: retryFailedQueueMock,
        clearFailedQueue: clearFailedQueueMock,
      },
      onToast: (message, error) => toasts.push({ message, error }),
      onRetryingChange: (_trackId, busy) => retryingStates.push(busy),
    });

    const first = controller.retryEntry({ trackId: 'track-1' });
    const duplicate = controller.retryEntry({ trackId: 'track-1' });
    expect(controller.isRetrying('track-1')).toBe(true);
    expect(retryMock).toHaveBeenCalledTimes(1);

    resolveRetry({ cached: true });
    expect(await first).toBe(true);
    expect(await duplicate).toBe(false);
    expect(controller.isRetrying('track-1')).toBe(false);
    expect(retryingStates).toEqual([true, false]);

    await controller.retryAllFailed();
    await controller.clearFailed();

    expect(toasts).toEqual([
      { message: 'Faixa já está pronta no acervo ⚡', error: undefined },
      { message: 'PIN inválido', error: true },
      { message: 'Nenhuma falha para remover da fila', error: undefined },
    ]);
  });

  it('garante classes responsivas sem quebra de botão nem overflow horizontal para mobile 375x812', () => {
    const html = renderToStaticMarkup(
      <QueueList
        queue={[myFailed]}
        downloads={{}}
        clientId="guest-me"
        onVote={() => {}}
        onRemove={() => {}}
        onRetry={() => {}}
        canRemove={() => true}
        canRetry={() => true}
        canManageFailed
        onRetryAllFailed={() => {}}
        onClearFailed={() => {}}
      />,
    );

    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('shrink-0');
    expect(html).toContain('flex-wrap');
    expect(html).toContain('min-w-0 flex-1');
  });
});
