import { type FormEvent, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { buildMetadataPatch, DEFAULT_CATEGORY_SUGGESTIONS, type EditableTrack } from '../lib/catalog';
import type { Track } from '../lib/types';
import { Cover } from './Cover';

interface Props {
  track: EditableTrack | null;
  categorySuggestions?: string[];
  onClose: () => void;
  onSaved: (updated: Track) => void;
}

export function TrackMetadataModal({ track, categorySuggestions, onClose, onSaved }: Props) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [album, setAlbum] = useState('');
  const [genre, setGenre] = useState('');
  const [year, setYear] = useState('');
  const [trackNumber, setTrackNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!track) return;
    setTitle(track.title);
    setArtist(track.artist);
    setAlbum(track.album ?? '');
    setGenre(track.genre ?? '');
    setYear(track.year != null ? String(track.year) : '');
    setTrackNumber(track.trackNumber != null ? String(track.trackNumber) : '');
    setError(null);
    setSaving(false);
  }, [track]);

  useEffect(() => {
    if (!track) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [track, saving, onClose]);

  if (!track) return null;

  const suggestions = categorySuggestions?.length ? categorySuggestions : [...DEFAULT_CATEGORY_SUGGESTIONS];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = buildMetadataPatch({ title, artist, album, genre, year, trackNumber });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateTrackMetadata(track.id, parsed.patch);
      onSaved(updated);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => !saving && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="metadata-modal-title"
        data-kiosk-scope="metadata"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90dvh] w-full max-w-lg flex-col gap-4 overflow-y-auto rounded-t-3xl border border-white/15 bg-panel p-5 shadow-2xl sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Cover src={track.thumbnail} alt={track.title} className="h-12 w-12 shrink-0 rounded-xl" />
            <div className="min-w-0">
              <h2 id="metadata-modal-title" className="text-lg font-bold leading-tight">
                Organizar faixa
              </h2>
              <p className="truncate text-xs text-zinc-400">{track.title}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Fechar"
            className="rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
            Título *
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
              placeholder="Nome da música"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
            Artista
            <input
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              maxLength={200}
              className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
              placeholder="Ex.: Djavan"
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
              Categoria / Gênero
              <input
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                maxLength={100}
                className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                placeholder="Ex.: Rock, MPB, Sertanejo, Karaokê (vazio para remover)"
              />
            </label>
            <div className="flex flex-wrap gap-1.5" aria-label="Sugestões de categoria">
              {suggestions.slice(0, 12).map((item) => {
                const active = genre.trim().toLowerCase() === item.toLowerCase();
                return (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setGenre(active ? '' : item)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                      active
                        ? 'border-accent bg-accent/30 font-semibold text-white'
                        : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/15 hover:text-white'
                    }`}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
            Álbum
            <input
              value={album}
              onChange={(e) => setAlbum(e.target.value)}
              maxLength={200}
              className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
              placeholder="Nome do álbum (vazio para remover)"
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
              Ano
              <input
                value={year}
                onChange={(e) => setYear(e.target.value)}
                inputMode="numeric"
                maxLength={4}
                className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                placeholder="Ex.: 1991"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-300">
              Nº da faixa
              <input
                value={trackNumber}
                onChange={(e) => setTrackNumber(e.target.value)}
                inputMode="numeric"
                maxLength={3}
                className="rounded-xl bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
                placeholder="Ex.: 1"
              />
            </label>
          </div>

          {error && <p className="rounded-xl bg-red-500/15 px-3 py-2 text-xs text-red-200">{error}</p>}

          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-white/20 disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-50"
            >
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
