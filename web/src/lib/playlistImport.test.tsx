import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlaylistImportDetectedCard, PlaylistImportFeedback } from '../components/PlaylistImportBanner';
import { PlaylistManagerPanel } from '../components/PlaylistManagerPanel';
import { ToastBanner } from '../components/Toast';
import { ApiError, api } from './api';
import {
  describePlaylistImportError,
  detectPlaylistLink,
  formatPlaylistImportSummary,
} from './playlistImport';
import type { PlaylistImportResult, PlaylistSummary } from './types';

function makePlaylistSummary(overrides: Partial<PlaylistSummary> = {}): PlaylistSummary {
  return {
    id: 'pl-1',
    name: 'Churrasco Hits',
    description: 'Importada do YouTube',
    source: 'youtube',
    sourceId: 'PL123456',
    thumbnail: 'https://img.example.com/pl.jpg',
    trackCount: 12,
    cover: 'https://img.example.com/pl.jpg',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeImportResult(overrides: Partial<PlaylistImportResult> = {}): PlaylistImportResult {
  return {
    playlist: makePlaylistSummary(),
    created: true,
    imported: 12,
    alreadyCached: 4,
    queued: 10,
    downloading: 8,
    skipped: 2,
    tracks: [],
    ...overrides,
  };
}

describe('detectPlaylistLink', () => {
  it('detects YouTube and YouTube Music playlist URLs', () => {
    expect(detectPlaylistLink('https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf')).toEqual({
      source: 'youtube',
      id: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
      url: 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    });
    expect(detectPlaylistLink('https://music.youtube.com/playlist?list=OLAK5uy_abc123')).toEqual({
      source: 'youtube',
      id: 'OLAK5uy_abc123',
      url: 'https://music.youtube.com/playlist?list=OLAK5uy_abc123',
    });
  });

  it('detects Spotify playlist URLs and URIs', () => {
    expect(detectPlaylistLink('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=xyz')).toEqual({
      source: 'spotify',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=xyz',
    });
    expect(detectPlaylistLink('https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      source: 'spotify',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      url: 'https://open.spotify.com/intl-pt/playlist/37i9dQZF1DXcBWIGoYBM5M',
    });
    expect(detectPlaylistLink('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M')).toEqual({
      source: 'spotify',
      id: '37i9dQZF1DXcBWIGoYBM5M',
      url: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    });
  });

  it('ignores search terms, single-track URLs, and non-http schemes', () => {
    expect(detectPlaylistLink('evidencias chitaozinho')).toBeNull();
    expect(detectPlaylistLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
    expect(detectPlaylistLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123')).toBeNull();
    expect(detectPlaylistLink('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBeNull();
    expect(detectPlaylistLink('javascript:alert(1)')).toBeNull();
  });
});

describe('api.importPlaylist', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('calls POST /api/playlists/import with requester info and returns summary', async () => {
    const payload = makeImportResult();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === 'jkbox.hostPin' ? '' : null),
      setItem: () => {},
    });

    const result = await api.importPlaylist('https://www.youtube.com/playlist?list=PL123456', {
      clientId: 'client-1',
      name: 'Gabriel',
    });

    expect(result).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/playlists/import');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      url: 'https://www.youtube.com/playlist?list=PL123456',
      clientId: 'client-1',
      name: 'Gabriel',
    });
  });

  it.each([
    [400, 'URL inválida ou não suportada. Cole um link de playlist do YouTube ou Spotify.'],
    [404, 'Playlist do Spotify não encontrada, privada ou inacessível'],
    [422, 'A playlist ultrapassa o limite máximo de 50 faixas por importação'],
  ])('throws ApiError with status %i on backend error', async (status, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: message }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('localStorage', {
      getItem: () => '',
      setItem: () => {},
    });

    await expect(
      api.importPlaylist('https://example.com/bad', { clientId: 'c1', name: 'Tester' }),
    ).rejects.toMatchObject({
      status,
      message,
    });
  });
});

describe('formatPlaylistImportSummary and describePlaylistImportError', () => {
  it('formats created and updated playlist import summaries', () => {
    const created = formatPlaylistImportSummary(makeImportResult({ created: true }));
    expect(created.headline).toBe('Playlist "Churrasco Hits" importada');
    expect(created.counts).toContain('12 importadas, 4 já em cache, 8 baixando');
    expect(created.counts).toContain('10 na fila');

    const updated = formatPlaylistImportSummary(
      makeImportResult({ created: false, imported: 1, alreadyCached: 1, downloading: 0, queued: 0, skipped: 0 }),
    );
    expect(updated.headline).toBe('Playlist "Churrasco Hits" atualizada');
    expect(updated.counts).toBe('1 importada, 1 já em cache, 0 baixando');
  });

  it('maps HTTP 400, 404 and 422 errors into clear user-facing alerts', () => {
    expect(describePlaylistImportError(new ApiError('URL inválida', 400))).toEqual({
      status: 400,
      title: 'Link de playlist inválido',
      message: 'URL inválida',
    });
    expect(describePlaylistImportError(new ApiError('Playlist privada', 404))).toEqual({
      status: 404,
      title: 'Playlist não encontrada ou privada',
      message: 'Playlist privada',
    });
    expect(describePlaylistImportError(new ApiError('Acima do limite de 50 faixas', 422))).toEqual({
      status: 422,
      title: 'Playlist fora do limite permitido',
      message: 'Acima do limite de 50 faixas',
    });
  });
});

describe('Playlist import UI rendering', () => {
  it('renders detected playlist banner in idle and loading states', () => {
    const idleHtml = renderToStaticMarkup(
      <PlaylistImportDetectedCard
        detected={{ source: 'spotify', id: '37i9dQZF1DXcBWIGoYBM5M', url: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' }}
        importing={false}
        onImport={() => {}}
      />,
    );
    expect(idleHtml).toContain('Spotify');
    expect(idleHtml).toContain('Playlist do Spotify detectada');
    expect(idleHtml).toContain('Importar Playlist');
    expect(idleHtml).not.toContain('disabled=""');

    const loadingHtml = renderToStaticMarkup(
      <PlaylistImportDetectedCard
        detected={{ source: 'youtube', id: 'PL123', url: 'https://www.youtube.com/playlist?list=PL123' }}
        importing
        onImport={() => {}}
      />,
    );
    expect(loadingHtml).toContain('YouTube');
    expect(loadingHtml).toContain('Importando…');
    expect(loadingHtml).toContain('disabled=""');
  });

  it('renders import summary banner and HTTP 400/404/422 error alerts', () => {
    const summaryHtml = renderToStaticMarkup(
      <PlaylistImportFeedback
        result={makeImportResult()}
        error={null}
        onOpenPlaylist={() => {}}
        onDismissResult={() => {}}
        onDismissError={() => {}}
      />,
    );
    expect(summaryHtml).toContain('Playlist &quot;Churrasco Hits&quot; importada');
    expect(summaryHtml).toContain('12 importadas, 4 já em cache, 8 baixando');
    expect(summaryHtml).toContain('YouTube');
    expect(summaryHtml).toContain('https://img.example.com/pl.jpg');
    expect(summaryHtml).toContain('Abrir no Catálogo');

    for (const status of [400, 404, 422] as const) {
      const errInfo = describePlaylistImportError(new ApiError(`Erro simulado ${status}`, status));
      const errHtml = renderToStaticMarkup(
        <PlaylistImportFeedback
          result={null}
          error={errInfo}
          onDismissResult={() => {}}
          onDismissError={() => {}}
        />,
      );
      expect(errHtml).toContain(`HTTP ${status}`);
      expect(errHtml).toContain(`Erro simulado ${status}`);
      expect(errHtml).toContain('role="alert"');
    }
  });

  it('renders imported playlist origin badge in PlaylistManagerPanel', () => {
    const html = renderToStaticMarkup(
      <PlaylistManagerPanel
        playlists={[
          makePlaylistSummary({ id: '1', name: 'Pagode YT', source: 'youtube' }),
          makePlaylistSummary({ id: '2', name: 'Sertanejo SP', source: 'spotify' }),
          makePlaylistSummary({ id: '3', name: 'Manual', source: null }),
        ]}
        onChanged={() => {}}
        onToast={() => {}}
      />,
    );
    expect(html).toContain('Pagode YT');
    expect(html).toContain('YouTube');
    expect(html).toContain('Sertanejo SP');
    expect(html).toContain('Spotify');
    expect(html).toContain('Manual');
  });

  it('renders mobile-safe responsive classes on ToastBanner for long import messages', () => {
    const html = renderToStaticMarkup(
      <ToastBanner text='Playlist "Churrasco Hits" importada: 12 importadas, 4 já em cache, 8 baixando' />,
    );
    expect(html).toContain('w-max');
    expect(html).toContain('max-w-[calc(100vw-2rem)]');
    expect(html).toContain('rounded-2xl');
    expect(html).toContain('text-center');
    expect(html).toContain('role="status"');
  });
});
