import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { AppConfig, AutoDjMode, CatalogCategory, PlaylistSummary, SpotifyStatus } from '../lib/types';

/** Shared Host controls used by the Kiosk (`⚙︎ Host`) and the Main Controller (`/remote`). */
export type RunFn = <T>(action: () => Promise<T>, ok?: string | ((result: T) => string)) => Promise<void>;

export function makeRun(onToast: (message: string, error?: boolean) => void): RunFn {
  return async (action, ok) => {
    try {
      const result = await action();
      const text = typeof ok === 'function' ? ok(result) : ok;
      if (text) onToast(text);
    } catch (err) {
      onToast((err as Error).message, true);
    }
  };
}

export const AUTO_DJ_MODES: { id: AutoDjMode; label: string; hint: string }[] = [
  { id: 'vibe', label: 'Seguir clima atual', hint: 'Mesma subcategoria → categoria → afinidade segura (Gospel isolado).' },
  { id: 'category', label: 'Travar em Categoria/Subcategoria', hint: 'Toca apenas faixas da categoria/subcategoria selecionada.' },
  { id: 'playlist', label: 'Travar em Playlist Interna', hint: 'Toca apenas faixas prontas da playlist interna selecionada.' },
  { id: 'random', label: 'Aleatório', hint: 'Sorteia qualquer faixa em cache evitando repetições recentes.' },
];

interface AutoDjPanelProps {
  config: AppConfig | null;
  playlists: PlaylistSummary[];
  reloadKey?: number;
  onDiscoverQueueVibe: () => void;
  onToast: (message: string, error?: boolean) => void;
  onChanged: () => void;
  run: RunFn;
}

/** Auto-DJ on/off + mode (vibe, category/subcategory lock, internal playlist lock, random). */
export function AutoDjPanel({ config, playlists, reloadKey, onDiscoverQueueVibe, onToast, onChanged, run }: AutoDjPanelProps) {
  const [categories, setCategories] = useState<CatalogCategory[]>([]);
  const [pickingCategory, setPickingCategory] = useState(false);
  const [pickingPlaylist, setPickingPlaylist] = useState(false);
  const activeMode: AutoDjMode = config?.autoDjMode ?? 'vibe';
  const showCategoryPicker = activeMode === 'category' || pickingCategory;
  const showPlaylistPicker = activeMode === 'playlist' || pickingPlaylist;
  const activeCategoryName = config?.autoDjCategory ?? '';
  const activeSubcategoryName = config?.autoDjSubgenre ?? '';
  const activePlaylistId = config?.autoDjPlaylistId ?? '';
  const activeCategoryObj = categories.find((c) => c.name.toLowerCase() === activeCategoryName.toLowerCase());

  useEffect(() => {
    const controller = new AbortController();
    api
      .catalogCategories(controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setCategories(res.categories);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [reloadKey]);

  return (
    <section className="glass flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">Auto-DJ</h3>
          <p className="text-xs text-zinc-400">
            Quando a fila esvaziar, escolhe automaticamente a próxima faixa em cache sem repetir as últimas tocadas.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Ativar Auto-DJ"
          aria-checked={Boolean(config?.autoDjEnabled)}
          disabled={!config}
          onClick={() => {
            if (!config) return;
            const next = !config.autoDjEnabled;
            void run(
              () => api.updateAutoDjConfig({ enabled: next }),
              next ? 'Auto-DJ ativado' : 'Auto-DJ desativado',
            ).then(onChanged);
          }}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition ${
            config?.autoDjEnabled ? 'bg-accent' : 'bg-white/20'
          } disabled:opacity-50`}
        >
          <span
            className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
              config?.autoDjEnabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      <div className="flex flex-col gap-1.5" role="group" aria-label="Modo do Auto-DJ">
        {AUTO_DJ_MODES.map((option) => {
          const selected =
            (pickingCategory && option.id === 'category') ||
            (pickingPlaylist && option.id === 'playlist') ||
            (!pickingCategory && !pickingPlaylist && activeMode === option.id);
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              disabled={!config}
              onClick={() => {
                if (!config) return;
                if (option.id === 'category') {
                  const targetCat = activeCategoryName || categories[0]?.name || '';
                  if (!targetCat) {
                    setPickingPlaylist(false);
                    setPickingCategory(true);
                    onToast('Nenhuma categoria no acervo ainda — auto-categorize ou edite uma faixa.', true);
                    return;
                  }
                  void run(async () => {
                    await api.updateAutoDjConfig({
                      mode: 'category',
                      category: targetCat,
                      subgenre: activeCategoryName ? activeSubcategoryName || null : null,
                    });
                    setPickingPlaylist(false);
                    setPickingCategory(true);
                    onChanged();
                  }, `Auto-DJ travado em ${targetCat}`);
                  return;
                }
                if (option.id === 'playlist') {
                  const targetPlaylist =
                    playlists.find((p) => p.id === activePlaylistId) ?? playlists[0] ?? null;
                  if (!targetPlaylist) {
                    setPickingCategory(false);
                    setPickingPlaylist(true);
                    onToast('Nenhuma playlist interna criada ainda — crie uma abaixo.', true);
                    return;
                  }
                  void run(async () => {
                    await api.updateAutoDjConfig({
                      mode: 'playlist',
                      playlistId: targetPlaylist.id,
                    });
                    setPickingCategory(false);
                    setPickingPlaylist(true);
                    onChanged();
                  }, `Auto-DJ travado na playlist ${targetPlaylist.name}`);
                  return;
                }
                void run(async () => {
                  await api.updateAutoDjConfig({ mode: option.id });
                  setPickingCategory(false);
                  setPickingPlaylist(false);
                  onChanged();
                }, `Modo Auto-DJ: ${option.label}`);
              }}
              className={`flex flex-col rounded-xl border px-3 py-2 text-left transition ${
                selected
                  ? 'border-accent bg-accent/20 text-white'
                  : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
              } disabled:opacity-50`}
            >
              <span className="text-xs font-semibold">{option.label}</span>
              <span className="text-[11px] text-zinc-400">{option.hint}</span>
            </button>
          );
        })}
      </div>

      {showPlaylistPicker && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
            Playlist interna travada
          </span>
          {playlists.length === 0 ? (
            <p className="text-xs text-zinc-400">
              Nenhuma playlist criada ainda. Use a seção &ldquo;Playlists internas&rdquo; abaixo para criar.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {playlists.map((pl) => {
                const active = activePlaylistId === pl.id;
                return (
                  <button
                    key={pl.id}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      void run(
                        () =>
                          api.updateAutoDjConfig({
                            mode: 'playlist',
                            playlistId: pl.id,
                          }),
                        `Auto-DJ travado na playlist ${pl.name}`,
                      ).then(onChanged);
                    }}
                    className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? 'border-accent bg-accent text-white'
                        : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                    }`}
                  >
                    {pl.name} ({pl.trackCount})
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showCategoryPicker && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/25 p-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Categoria travada
            </span>
            {categories.length === 0 ? (
              <p className="text-xs text-zinc-400">
                Nenhuma categoria encontrada. Use &ldquo;Auto-categorizar acervo&rdquo; abaixo primeiro.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {categories.map((cat) => {
                  const active = activeCategoryName.toLowerCase() === cat.name.toLowerCase();
                  return (
                    <button
                      key={cat.name}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        void run(
                          () =>
                            api.updateAutoDjConfig({
                              mode: 'category',
                              category: cat.name,
                              subgenre: null,
                            }),
                          `Auto-DJ travado em ${cat.name}`,
                        ).then(onChanged);
                      }}
                      className={`rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        active
                          ? 'border-accent bg-accent text-white'
                          : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                      }`}
                    >
                      {cat.name} ({cat.trackCount})
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {activeCategoryObj && (activeCategoryObj.subcategories?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                Subcategoria (opcional)
              </span>
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  aria-pressed={!activeSubcategoryName}
                  onClick={() => {
                    void run(
                      () =>
                        api.updateAutoDjConfig({
                          mode: 'category',
                          category: activeCategoryObj.name,
                          subgenre: null,
                        }),
                      `Auto-DJ: todas de ${activeCategoryObj.name}`,
                    ).then(onChanged);
                  }}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                    !activeSubcategoryName
                      ? 'border-accent-2 bg-accent-2/25 font-semibold text-white'
                      : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                  }`}
                >
                  Todas da categoria
                </button>
                {activeCategoryObj.subcategories!.map((sub) => {
                  const active = activeSubcategoryName.toLowerCase() === sub.name.toLowerCase();
                  return (
                    <button
                      key={sub.name}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        void run(
                          () =>
                            api.updateAutoDjConfig({
                              mode: 'category',
                              category: activeCategoryObj.name,
                              subgenre: sub.name,
                            }),
                          `Auto-DJ travado em ${sub.name}`,
                        ).then(onChanged);
                      }}
                      className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                        active
                          ? 'border-accent-2 bg-accent-2/25 font-semibold text-white'
                          : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15'
                      }`}
                    >
                      {sub.name} ({sub.trackCount})
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={onDiscoverQueueVibe}
        className="rounded-xl border border-accent/40 bg-accent/20 px-3 py-2 text-xs font-semibold text-purple-100 transition hover:bg-accent/30"
      >
        ✨ Completar fila na vibe atual
      </button>
    </section>
  );
}

interface SpotifyAccountPanelProps {
  spotify: SpotifyStatus | undefined;
  onChanged: () => void;
  run: RunFn;
}

/** Spotify account: connect/reconnect/disconnect, shared playlist link, sync and import. */
export function SpotifyAccountPanel({ spotify, onChanged, run }: SpotifyAccountPanelProps) {
  const [playlist, setPlaylist] = useState('');
  return (
    <section className="glass flex flex-col gap-3 p-4">
      <h3 className="font-semibold">Spotify</h3>
      {!spotify?.configured && (
        <p className="text-sm text-zinc-400">
          Desativado. Preencha <code>SPOTIFY_CLIENT_ID</code> e <code>SPOTIFY_CLIENT_SECRET</code> no <code>.env</code> para habilitar busca,
          Spotify Connect e playlist compartilhada. YouTube e Acervo Local continuam funcionando normalmente.
        </p>
      )}
      {spotify?.configured && !spotify.connected && (
        <>
          <p className="text-sm text-zinc-400">Busca no catálogo ativa. Conecte uma conta para criar a playlist compartilhada e usar o Spotify Connect.</p>
          <a href={api.spotifyAuthUrl()} className="rounded-lg bg-green-500 px-3 py-2 text-center font-semibold text-black">
            Conectar Spotify
          </a>
          <p className="break-all text-xs text-zinc-500">Redirect URI: {spotify.redirectUri}</p>
        </>
      )}
      {spotify?.connected && (
        <>
          {!spotify.playbackAuthorized && (
            <a
              href={api.spotifyAuthUrl()}
              className="rounded-lg bg-amber-400 px-3 py-2 text-center text-sm font-semibold text-zinc-950"
            >
              Reconectar Spotify (liberar Spotify Connect)
            </a>
          )}
          {spotify.playlistUrl && (
            <a href={spotify.playlistUrl} target="_blank" rel="noreferrer" className="text-sm text-green-300 underline">
              Abrir playlist compartilhada ↗
            </a>
          )}
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!playlist.trim()) return;
              run(() => api.spotifyLinkPlaylist(playlist.trim()), 'Playlist vinculada').then(() => {
                setPlaylist('');
                onChanged();
              });
            }}
          >
            <input
              value={playlist}
              onChange={(e) => setPlaylist(e.target.value)}
              className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-accent"
              placeholder="Link de uma playlist existente"
              aria-label="Link ou ID de uma playlist existente do Spotify"
            />
            <button type="submit" className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/20">
              Vincular
            </button>
          </form>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => run(api.spotifySync, 'Fila sincronizada com o Spotify')} className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20">
              Sincronizar fila
            </button>
            <button
              onClick={() =>
                run(api.spotifyImport, ({ imported }) =>
                  imported ? `${imported} faixa(s) importada(s) para a fila` : 'Nenhuma faixa nova na playlist',
                )
              }
              className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
            >
              Importar da playlist
            </button>
          </div>
          <button
            onClick={() => run(api.spotifyDisconnect, 'Spotify desconectado').then(onChanged)}
            className="text-left text-xs text-zinc-400 underline"
          >
            Desconectar
          </button>
        </>
      )}
    </section>
  );
}

interface LibraryMaintenancePanelProps {
  onCatalogChanged: () => void;
  onOpenCatalog: () => void;
  onDiscoverQueueVibe?: () => void;
  run: RunFn;
  children?: ReactNode;
}

/** Local library: rescan, auto-categorize (normal and forced) and "populate similar" discovery. */
export function LibraryMaintenancePanel({ onCatalogChanged, onOpenCatalog, onDiscoverQueueVibe, run, children }: LibraryMaintenancePanelProps) {
  const [autocategorizing, setAutocategorizing] = useState(false);
  const autocategorize = (force: boolean) => {
    setAutocategorizing(true);
    void run(
      () => api.autocategorizeLibrary(force ? { force: true } : undefined),
      ({ updated, skippedManual }) => {
        onCatalogChanged();
        if (updated > 0) {
          return `${updated} faixa(s) auto-categorizada(s)${skippedManual > 0 ? ` (${skippedManual} manuais preservadas)` : ''}`;
        }
        return 'Nenhuma faixa pendente para auto-categorizar';
      },
    ).finally(() => setAutocategorizing(false));
  };
  return (
    <section className="glass flex flex-col gap-2 p-4">
      <h3 className="font-semibold">Acervo local &amp; catálogo</h3>
      <p className="text-sm text-zinc-400">
        Coloque arquivos de áudio em <code>./data/music</code> (formato sugerido: <code>Categoria/Artista/Álbum/01 - Título.mp3</code>) ou organize categorias e álbuns pela interface.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={onOpenCatalog}
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          📚 Explorar catálogo
        </button>
        <button
          type="button"
          onClick={() =>
            run(api.rescanLibrary, ({ added }) => {
              if (added) onCatalogChanged();
              return added ? `${added} arquivo(s) adicionados ao acervo` : 'Nenhum arquivo novo encontrado';
            })
          }
          className="rounded-lg bg-white/10 px-3 py-2 text-sm hover:bg-white/20"
        >
          Reescanear acervo
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <button
          type="button"
          disabled={autocategorizing}
          onClick={() => autocategorize(false)}
          className="rounded-lg border border-accent/35 bg-accent/15 px-3 py-2 text-sm font-semibold text-purple-100 transition hover:bg-accent/25 disabled:opacity-50"
        >
          {autocategorizing ? 'Categorizando acervo…' : '✨ Auto-categorizar acervo'}
        </button>
        <button
          type="button"
          disabled={autocategorizing}
          onClick={() => autocategorize(true)}
          title="Recalcula a categoria de todas as faixas (preserva as editadas manualmente)"
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm font-medium text-zinc-200 transition hover:bg-white/15 disabled:opacity-50"
        >
          ♻️ Forçar recategorização
        </button>
      </div>
      {onDiscoverQueueVibe && (
        <button
          type="button"
          onClick={onDiscoverQueueVibe}
          className="rounded-lg border border-accent/40 bg-accent/20 px-3 py-2 text-sm font-semibold text-purple-100 transition hover:bg-accent/25"
        >
          ✨ Popular semelhantes na vibe atual
        </button>
      )}
      {children}
    </section>
  );
}
