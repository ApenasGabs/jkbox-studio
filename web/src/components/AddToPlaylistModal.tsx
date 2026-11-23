import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatTrackCount, type PlaylistPickerTrack } from '../lib/catalog';
import type { PlaylistSummary } from '../lib/types';
import { Cover } from './Cover';

interface Props {
  track: PlaylistPickerTrack | null;
  onClose: () => void;
  onChanged: () => void;
  onToast: (message: string, error?: boolean) => void;
}

export function AddToPlaylistModal({ track, onClose, onChanged, onToast }: Props) {
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!track) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.playlists(track.id, signal);
        setPlaylists(res.playlists);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError((err as Error).message);
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [track],
  );

  useEffect(() => {
    if (!track) return;
    setNewName('');
    setError(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [track, load]);

  useEffect(() => {
    if (!track) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !creating && !busyId) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [track, creating, busyId, onClose]);

  if (!track) return null;

  const togglePlaylist = async (playlist: PlaylistSummary) => {
    setBusyId(playlist.id);
    setError(null);
    try {
      if (playlist.containsTrack) {
        await api.removeTrackFromPlaylist(playlist.id, track.id);
        onToast(`Removida de "${playlist.name}"`);
      } else {
        await api.addTrackToPlaylist(playlist.id, track.id);
        onToast(`Adicionada em "${playlist.name}"`);
      }
      await load();
      onChanged();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      onToast(msg, true);
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateAndAdd = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setError('Informe um nome para a nova playlist.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const created = await api.createPlaylist({ name: trimmed });
      await api.addTrackToPlaylist(created.id, track.id);
      setNewName('');
      onToast(`Playlist "${created.name}" criada com a faixa`);
      await load();
      onChanged();
    } catch (err) {
      const msg = (err as Error).message;
      setError(msg);
      onToast(msg, true);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => !creating && !busyId && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="playlist-picker-title"
        data-kiosk-scope="playlist-picker"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[88dvh] w-full max-w-md flex-col gap-4 overflow-y-auto rounded-t-3xl border border-white/15 bg-panel p-5 shadow-2xl sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Cover src={track.thumbnail} alt={track.title} className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0">
              <h2 id="playlist-picker-title" className="text-lg font-bold leading-tight">
                Adicionar à playlist
              </h2>
              <p className="truncate text-xs text-zinc-400">
                {track.title}
                {track.artist ? ` · ${track.artist}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-kiosk-default={playlists.length === 0 ? 'true' : undefined}
            onClick={onClose}
            disabled={creating || Boolean(busyId)}
            aria-label="Fechar"
            className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        {error && <p className="rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-200">{error}</p>}

        {loading && playlists.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-400">Carregando playlists…</p>
        ) : playlists.length === 0 ? (
          <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-4 text-center text-xs text-zinc-300">
            Nenhuma playlist interna criada ainda. Crie uma abaixo (ex: Churrasco, Festa, Esquenta).
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col gap-2 overflow-y-auto pr-1">
            {playlists.map((pl, index) => {
              const inPlaylist = Boolean(pl.containsTrack);
              const busy = busyId === pl.id;
              return (
                <li key={pl.id}>
                  <button
                    type="button"
                    data-kiosk-default={index === 0 ? 'true' : undefined}
                    disabled={busy || creating}
                    onClick={() => void togglePlaylist(pl)}
                    className={`flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                      inPlaylist
                        ? 'border-accent/60 bg-accent/20 text-white'
                        : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
                    } disabled:opacity-50`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{pl.name}</p>
                      <p className="truncate text-[11px] text-zinc-400">{formatTrackCount(pl.trackCount)}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        inPlaylist ? 'bg-accent text-white' : 'bg-white/10 text-zinc-200'
                      }`}
                    >
                      {busy ? '…' : inPlaylist ? '✓ Na playlist' : '+ Adicionar'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <form onSubmit={handleCreateAndAdd} className="flex flex-col gap-2 border-t border-white/10 pt-3">
          <span className="text-xs font-semibold text-zinc-300">Criar nova playlist com esta música</span>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={80}
              placeholder="Ex.: Churrasco, Festa, Esquenta"
              className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              type="submit"
              disabled={creating || Boolean(busyId)}
              className="shrink-0 rounded-xl bg-accent px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {creating ? '…' : 'Criar +'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
