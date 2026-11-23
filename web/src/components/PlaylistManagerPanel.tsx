import { type FormEvent, useState } from 'react';
import { api } from '../lib/api';
import { formatTrackCount } from '../lib/catalog';
import type { PlaylistSummary } from '../lib/types';

interface Props {
  playlists: PlaylistSummary[];
  onChanged: () => void;
  onToast: (message: string, error?: boolean) => void;
  onOpenPlaylistsTab?: () => void;
}

export function PlaylistManagerPanel({ playlists, onChanged, onToast, onOpenPlaylistsTab }: Props) {
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingId, setSavingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) {
      onToast('Informe o nome da playlist', true);
      return;
    }
    setCreating(true);
    try {
      const created = await api.createPlaylist({
        name,
        description: newDescription.trim() || null,
      });
      setNewName('');
      setNewDescription('');
      onToast(`Playlist "${created.name}" criada`);
      onChanged();
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (pl: PlaylistSummary) => {
    setConfirmDeleteId(null);
    setEditingId(pl.id);
    setEditName(pl.name);
    setEditDescription(pl.description ?? '');
  };

  const handleSaveEdit = async (e: FormEvent, id: string) => {
    e.preventDefault();
    const name = editName.trim();
    if (!name) {
      onToast('Informe o nome da playlist', true);
      return;
    }
    setSavingId(id);
    try {
      const updated = await api.updatePlaylist(id, {
        name,
        description: editDescription.trim() || null,
      });
      setEditingId(null);
      onToast(`Playlist "${updated.name}" atualizada`);
      onChanged();
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setSavingId(null);
    }
  };

  const handleDelete = async (pl: PlaylistSummary) => {
    setSavingId(pl.id);
    try {
      await api.deletePlaylist(pl.id);
      setConfirmDeleteId(null);
      if (editingId === pl.id) setEditingId(null);
      onToast(`Playlist "${pl.name}" excluída`);
      onChanged();
    } catch (err) {
      onToast((err as Error).message, true);
    } finally {
      setSavingId(null);
    }
  };

  return (
    <section className="glass flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold">Playlists internas</h3>
          <p className="text-xs text-zinc-400">
            Agrupe músicas temáticas (Churrasco, Festa, Esquenta) para tocar na fila ou travar no Auto-DJ.
          </p>
        </div>
        {onOpenPlaylistsTab && (
          <button
            type="button"
            onClick={onOpenPlaylistsTab}
            className="shrink-0 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-white/20"
          >
            Explorar
          </button>
        )}
      </div>

      <form onSubmit={handleCreate} className="flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={80}
            placeholder="Nova playlist (ex.: Churrasco)"
            aria-label="Nome da nova playlist"
            className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="submit"
            disabled={creating}
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50"
          >
            {creating ? '…' : '+ Criar'}
          </button>
        </div>
        {newName.trim().length > 0 && (
          <input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            maxLength={300}
            placeholder="Descrição opcional"
            aria-label="Descrição da nova playlist"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white outline-none focus:ring-2 focus:ring-accent"
          />
        )}
      </form>

      {playlists.length === 0 ? (
        <p className="text-xs text-zinc-400">Nenhuma playlist interna criada ainda.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {playlists.map((pl) => {
            const isEditing = editingId === pl.id;
            const isConfirmingDelete = confirmDeleteId === pl.id;
            const busy = savingId === pl.id;

            if (isEditing) {
              return (
                <li key={pl.id} className="rounded-xl border border-accent/40 bg-black/30 p-2.5">
                  <form onSubmit={(e) => void handleSaveEdit(e, pl.id)} className="flex flex-col gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      maxLength={80}
                      placeholder="Nome da playlist"
                      aria-label={`Renomear playlist ${pl.name}`}
                      className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-white outline-none focus:ring-2 focus:ring-accent"
                    />
                    <input
                      value={editDescription}
                      onChange={(e) => setEditDescription(e.target.value)}
                      maxLength={300}
                      placeholder="Descrição (opcional)"
                      aria-label={`Descrição da playlist ${pl.name}`}
                      className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-white outline-none focus:ring-2 focus:ring-accent"
                    />
                    <div className="flex justify-end gap-1.5">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                        className="rounded-lg bg-white/10 px-2.5 py-1 text-[11px] font-semibold hover:bg-white/20"
                      >
                        Cancelar
                      </button>
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-lg bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
                      >
                        {busy ? 'Salvando…' : 'Salvar'}
                      </button>
                    </div>
                  </form>
                </li>
              );
            }

            return (
              <li
                key={pl.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{pl.name}</p>
                  <p className="truncate text-[11px] text-zinc-400">
                    {formatTrackCount(pl.trackCount)}
                    {pl.description ? ` · ${pl.description}` : ''}
                  </p>
                </div>
                {isConfirmingDelete ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleDelete(pl)}
                      className="rounded-lg bg-red-500 px-2 py-1 text-[11px] font-semibold text-white hover:bg-red-400 disabled:opacity-50"
                    >
                      {busy ? '…' : 'Excluir'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmDeleteId(null)}
                      className="rounded-lg bg-white/10 px-2 py-1 text-[11px] font-semibold hover:bg-white/20"
                    >
                      Não
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEdit(pl)}
                      aria-label={`Renomear playlist ${pl.name}`}
                      title="Renomear ou editar descrição"
                      className="rounded-lg bg-white/10 px-2 py-1 text-xs text-zinc-200 hover:bg-white/20"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(null);
                        setConfirmDeleteId(pl.id);
                      }}
                      aria-label={`Excluir playlist ${pl.name}`}
                      title="Excluir playlist"
                      className="rounded-lg bg-white/10 px-2 py-1 text-xs text-red-300 hover:bg-red-500/20"
                    >
                      🗑
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
