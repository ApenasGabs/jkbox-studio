import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { REMOTE_HOST_TABS, type RemoteHostTab } from '../lib/remoteRole';
import { describeSpotifyConnectError } from '../lib/spotifyConnect';
import type { AppConfig, KioskControl, MdnsStatus, PlaybackOutput, PlaylistSummary } from '../lib/types';
import { AutoDjPanel, LibraryMaintenancePanel, makeRun, SpotifyAccountPanel } from './HostControls';
import { KioskRemoteControls } from './KioskRemoteControls';
import { MdnsHostnamePanel } from './MdnsHostnamePanel';
import { PlaylistManagerPanel } from './PlaylistManagerPanel';
import { SpotifyConnectSelector } from './SpotifyConnectSelector';

export interface RemoteHostPanelProps {
  config: AppConfig | null;
  playbackOutput: PlaybackOutput;
  paused: boolean;
  currentTitle: string | null;
  spotifyVolume: number;
  onSpotifyVolumeChange: (volume: number) => void;
  playlists: PlaylistSummary[];
  reloadKey: number;
  mdns: MdnsStatus | null | undefined;
  onMdnsUpdated: (mdns: MdnsStatus) => void;
  onToast: (message: string, error?: boolean) => void;
  onConfigChanged: () => void;
  onCatalogChanged: () => void;
  onPlaylistsChanged: () => void;
  onOpenCatalog: () => void;
  onOpenPlaylistsTab: () => void;
  onDiscoverVibe: () => void;
  onAddCurrentToPlaylist: () => void;
  onClose: () => void;
  initialTab?: RemoteHostTab;
  /** Overrides the TV transport (tests). */
  kioskSend?: (control: KioskControl) => Promise<unknown>;
}

/** Main Controller panel on `/remote`: full parity with the Kiosk `⚙︎ Host`, split in phone-friendly tabs. */
export function RemoteHostPanel({
  config,
  playbackOutput,
  paused,
  currentTitle,
  spotifyVolume,
  onSpotifyVolumeChange,
  playlists,
  reloadKey,
  mdns,
  onMdnsUpdated,
  onToast,
  onConfigChanged,
  onCatalogChanged,
  onPlaylistsChanged,
  onOpenCatalog,
  onOpenPlaylistsTab,
  onDiscoverVibe,
  onAddCurrentToPlaylist,
  onClose,
  initialTab = 'player',
  kioskSend,
}: RemoteHostPanelProps) {
  const [tab, setTab] = useState<RemoteHostTab>(initialTab);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const run = useMemo(() => makeRun(onToast), [onToast]);

  const playback = (action: () => Promise<unknown>) => {
    setPlaybackBusy(true);
    void action()
      .catch((err) => onToast(describeSpotifyConnectError(err).message, true))
      .finally(() => setPlaybackBusy(false));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-host-panel-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-white/15 bg-panel shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-4">
          <h2 id="remote-host-panel-title" className="min-w-0 truncate text-base font-bold">
            Controlador Principal
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar controles do host"
            className="shrink-0 rounded-lg px-2 py-1 text-zinc-400 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-4 gap-1 px-4 pt-3" role="tablist" aria-label="Seções do Controlador Principal">
          {REMOTE_HOST_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={`min-w-0 rounded-lg px-1 py-2 text-[11px] font-semibold leading-tight transition sm:text-xs ${
                tab === item.id ? 'bg-white text-zinc-900' : 'bg-white/5 text-zinc-300 hover:text-white'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" role="tabpanel">
          {tab === 'player' && (
            <>
              {currentTitle && (
                <section className="glass flex flex-col gap-2 p-3">
                  <p className="truncate text-xs text-zinc-400">
                    Tocando agora: <span className="font-semibold text-white">{currentTitle}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    {playbackOutput.type === 'spotify' && (
                      <button
                        type="button"
                        disabled={playbackBusy}
                        onClick={() => playback(paused ? api.spotifyResume : api.spotifyPause)}
                        className="min-w-0 flex-1 rounded-xl bg-white px-3 py-2 text-xs font-semibold text-zinc-900 disabled:opacity-50"
                      >
                        {paused ? '▶ Tocar no Spotify' : '❚❚ Pausar Spotify'}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={playbackBusy}
                      onClick={() => playback(api.skip)}
                      className="min-w-0 flex-1 rounded-xl bg-white/10 px-3 py-2 text-xs font-semibold text-white hover:bg-white/20 disabled:opacity-50"
                    >
                      ⏭ Pular faixa
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={onAddCurrentToPlaylist}
                    className="truncate rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-left text-xs font-medium text-zinc-200 hover:bg-white/15"
                  >
                    + Playlist na faixa atual ({currentTitle})
                  </button>
                </section>
              )}
              <KioskRemoteControls onToast={onToast} send={kioskSend} />
              <SpotifyConnectSelector
                config={config}
                playbackOutput={playbackOutput}
                volume={spotifyVolume}
                onVolumeChange={onSpotifyVolumeChange}
                onToast={onToast}
              />
            </>
          )}

          {tab === 'autodj' && (
            <AutoDjPanel
              config={config}
              playlists={playlists}
              reloadKey={reloadKey}
              onDiscoverQueueVibe={onDiscoverVibe}
              onToast={onToast}
              onChanged={onConfigChanged}
              run={run}
            />
          )}

          {tab === 'spotify' && (
            <>
              <SpotifyAccountPanel spotify={config?.spotify} onChanged={onConfigChanged} run={run} />
              <SpotifyConnectSelector
                config={config}
                playbackOutput={playbackOutput}
                volume={spotifyVolume}
                onVolumeChange={onSpotifyVolumeChange}
                onToast={onToast}
              />
            </>
          )}

          {tab === 'library' && (
            <>
              <LibraryMaintenancePanel
                onCatalogChanged={onCatalogChanged}
                onOpenCatalog={onOpenCatalog}
                onDiscoverQueueVibe={onDiscoverVibe}
                run={run}
              />
              <PlaylistManagerPanel
                playlists={playlists}
                onChanged={onPlaylistsChanged}
                onToast={onToast}
                onOpenPlaylistsTab={onOpenPlaylistsTab}
              />
              <MdnsHostnamePanel mdns={mdns ?? config?.mdns} onUpdated={onMdnsUpdated} onToast={onToast} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
