import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import {
  describeSpotifyConnectError,
  spotifyDeviceIcon,
  spotifyDeviceLabel,
} from '../lib/spotifyConnect';
import type { AppConfig, PlaybackOutput, SpotifyDevice } from '../lib/types';
import { useSpotifyVolumeControl } from '../lib/useSpotifyVolume';

interface SpotifyConnectSelectorProps {
  config: AppConfig | null;
  playbackOutput: PlaybackOutput;
  volume: number;
  onVolumeChange: (volume: number) => void;
  onToast?: (message: string, error?: boolean) => void;
}

export function SpotifyConnectSelector({
  config,
  playbackOutput,
  volume,
  onVolumeChange,
  onToast,
}: SpotifyConnectSelectorProps) {
  const [devices, setDevices] = useState<SpotifyDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<{ message: string; code?: string } | null>(null);
  const mountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const onVolumeChangeRef = useRef(onVolumeChange);
  onVolumeChangeRef.current = onVolumeChange;

  const spotify = config?.spotify;
  const canQueryDevices = Boolean(spotify?.configured && spotify.connected && spotify.playbackAuthorized);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadDevices = useCallback(async () => {
    const reqSeq = ++loadSeqRef.current;
    if (!canQueryDevices) {
      setDevices([]);
      return;
    }
    setLoading(true);
    setErrorInfo(null);
    try {
      const res = await api.spotifyDevices();
      if (!mountedRef.current || reqSeq !== loadSeqRef.current) return;
      setDevices(res.devices);
      const outputDeviceId = res.playbackOutput.type === 'spotify' ? res.playbackOutput.deviceId : null;
      if (outputDeviceId) {
        const active = res.devices.find((d) => d.id === outputDeviceId);
        if (active?.volumePercent != null) {
          onVolumeChangeRef.current(active.volumePercent);
        }
      }
    } catch (err) {
      if (!mountedRef.current || reqSeq !== loadSeqRef.current) return;
      setErrorInfo(describeSpotifyConnectError(err));
    } finally {
      if (mountedRef.current && reqSeq === loadSeqRef.current) {
        setLoading(false);
      }
    }
  }, [canQueryDevices]);

  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  const selectDevice = async (deviceId: string | null, label: string) => {
    setSwitchingId(deviceId ?? 'local');
    setErrorInfo(null);
    try {
      const res = await api.setSpotifyDevice(deviceId);
      const selected = deviceId ? devices.find((d) => d.id === deviceId) : null;
      if (selected?.volumePercent != null) {
        onVolumeChangeRef.current(selected.volumePercent);
      }
      onToast?.(
        res.playbackOutput.type === 'local'
          ? 'Saída alterada para Player Local (Jukebox)'
          : `Tocando em ${label} via Spotify Connect`,
      );
      if (canQueryDevices) {
        void loadDevices();
      }
    } catch (err) {
      const info = describeSpotifyConnectError(err);
      setErrorInfo(info);
      onToast?.(info.message, true);
    } finally {
      setSwitchingId(null);
    }
  };

  const handleVolumeError = useCallback(
    (info: { message: string; code?: string }) => {
      setErrorInfo(info);
      onToast?.(info.message, true);
    },
    [onToast],
  );
  const applyVolume = useSpotifyVolumeControl(onVolumeChange, handleVolumeError);

  const activeSpotifyDevice =
    playbackOutput.type === 'spotify' ? devices.find((d) => d.id === playbackOutput.deviceId) : undefined;

  return (
    <section className="glass flex flex-col gap-3 p-4" aria-label="Onde tocar">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Onde tocar</h3>
          <p className="text-xs text-zinc-400">Escolha entre o Player Local ou uma caixa Spotify Connect.</p>
        </div>
        {canQueryDevices && (
          <button
            type="button"
            onClick={() => void loadDevices()}
            disabled={loading}
            className="shrink-0 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs font-medium text-zinc-200 transition hover:bg-white/20 disabled:opacity-50"
          >
            {loading ? 'Atualizando…' : '↻ Atualizar'}
          </button>
        )}
      </div>

      {spotify?.configured && !spotify.connected && (
        <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-zinc-300">
          <p>Conecte uma conta Spotify Premium para enviar o áudio para caixas Wi-Fi ou TVs.</p>
          <a
            href={api.spotifyAuthUrl()}
            className="rounded-lg bg-green-500 px-3 py-2 text-center font-semibold text-black transition hover:brightness-105"
          >
            Conectar Spotify
          </a>
        </div>
      )}

      {spotify?.configured && spotify.connected && !spotify.playbackAuthorized && (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 text-xs text-amber-100">
          <p>
            Sua conexão Spotify ainda não possui permissão de playback para controlar caixas Spotify Connect.
          </p>
          <a
            href={api.spotifyAuthUrl()}
            className="rounded-lg bg-amber-400 px-3 py-2 text-center font-semibold text-zinc-950 transition hover:brightness-105"
          >
            Reconectar Spotify
          </a>
        </div>
      )}

      {errorInfo && (
        <div
          role="alert"
          className={`flex flex-col gap-2 rounded-xl border px-3 py-2 text-xs ${
            errorInfo.code === 'PREMIUM_REQUIRED'
              ? 'border-amber-400/40 bg-amber-500/15 text-amber-100'
              : 'border-red-400/35 bg-red-500/15 text-red-200'
          }`}
        >
          <p>{errorInfo.message}</p>
          {errorInfo.code === 'INSUFFICIENT_SCOPE' && (
            <a
              href={api.spotifyAuthUrl()}
              className="rounded-lg bg-amber-400 px-3 py-1.5 text-center font-semibold text-zinc-950"
            >
              Reconectar Spotify
            </a>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void selectDevice(null, 'Player Local')}
          disabled={switchingId !== null}
          className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
            playbackOutput.type === 'local'
              ? 'border-accent bg-accent/20 text-white'
              : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
          } disabled:opacity-50`}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="text-lg">🖥️</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Player Local (Jukebox)</p>
              <p className="text-[11px] text-zinc-400">Áudio e clipe direto neste equipamento</p>
            </div>
          </div>
          {playbackOutput.type === 'local' && (
            <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              Ativo
            </span>
          )}
        </button>

        {canQueryDevices &&
          devices.map((device) => {
            const isSelected = playbackOutput.type === 'spotify' && playbackOutput.deviceId === device.id;
            return (
              <button
                key={device.id}
                type="button"
                disabled={device.isRestricted || switchingId !== null}
                title={device.isRestricted ? 'Este dispositivo não permite controle remoto' : undefined}
                onClick={() => void selectDevice(device.id, device.name)}
                className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition ${
                  isSelected
                    ? 'border-green-400/70 bg-green-500/20 text-white'
                    : 'border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="text-lg">{spotifyDeviceIcon(device.type)}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{device.name}</p>
                    <p className="truncate text-[11px] text-zinc-400">
                      {spotifyDeviceLabel(device.type)}
                      {device.volumePercent != null ? ` · ${device.volumePercent}%` : ''}
                      {device.isRestricted ? ' · Restrito' : ''}
                    </p>
                  </div>
                </div>
                {isSelected ? (
                  <span className="shrink-0 rounded-full bg-green-500 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-black">
                    Ativo
                  </span>
                ) : device.isActive ? (
                  <span className="shrink-0 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium text-zinc-200">
                    Em uso
                  </span>
                ) : null}
              </button>
            );
          })}

        {canQueryDevices && !loading && devices.length === 0 && !errorInfo && (
          <p className="rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-xs text-zinc-400">
            Nenhuma caixa Spotify Connect disponível agora. Abra o app do Spotify no alto-falante ou TV e clique em Atualizar.
          </p>
        )}
      </div>

      {playbackOutput.type === 'spotify' && (
        <div className="flex flex-col gap-2 rounded-xl border border-green-400/25 bg-green-500/10 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-green-200">Volume · {playbackOutput.deviceName}</span>
            <span className="tabular-nums text-zinc-300">{volume}%</span>
          </div>
          {activeSpotifyDevice && !activeSpotifyDevice.supportsVolume ? (
            <p className="text-[11px] text-zinc-400">Este dispositivo controla o volume apenas no aparelho físico.</p>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => applyVolume(volume - 10, true)}
                aria-label="Diminuir volume do Spotify Connect"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold hover:bg-white/20"
              >
                🔉-
              </button>
              <input
                type="range"
                data-kiosk-focus="skip"
                min={0}
                max={100}
                step={5}
                value={volume}
                onChange={(e) => applyVolume(Number(e.target.value), false)}
                aria-label="Volume do Spotify Connect"
                className="min-w-0 flex-1 accent-green-400"
              />
              <button
                type="button"
                onClick={() => applyVolume(volume + 10, true)}
                aria-label="Aumentar volume do Spotify Connect"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-bold hover:bg-white/20"
              >
                🔊+
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
