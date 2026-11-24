import { ApiError } from './api';
import type { PlaybackOutput } from './types';

const DEVICE_ICONS: Record<string, string> = {
  Speaker: '🔊',
  CastAudio: '🔊',
  AVR: '🔊',
  AudioDongle: '🔊',
  TV: '📺',
  CastVideo: '📺',
  STB: '📺',
  Smartphone: '📱',
  Tablet: '📱',
  Computer: '💻',
  GameConsole: '🎮',
  Automobile: '🚗',
};

const DEVICE_LABELS: Record<string, string> = {
  Speaker: 'Caixa Wi-Fi',
  CastAudio: 'Chromecast Audio',
  AVR: 'Receiver',
  AudioDongle: 'Adaptador de áudio',
  TV: 'TV',
  CastVideo: 'Chromecast',
  STB: 'Set-top box',
  Smartphone: 'Celular',
  Tablet: 'Tablet',
  Computer: 'Computador',
  GameConsole: 'Console',
  Automobile: 'Automóvel',
};

/** Returns an emoji icon matching a Spotify Connect device type. */
export function spotifyDeviceIcon(type: string): string {
  return DEVICE_ICONS[type] ?? '🎵';
}

/** Returns a human-readable Portuguese label for a Spotify Connect device type. */
export function spotifyDeviceLabel(type: string): string {
  return DEVICE_LABELS[type] ?? (type || 'Spotify Connect');
}

/** Formats the active output badge when playing via Spotify Connect, or null for local playback. */
export function formatSpotifyOutputBadge(output: PlaybackOutput): string | null {
  if (output.type !== 'spotify') return null;
  return `🔊 ${output.deviceName} · Spotify Connect`;
}

/** Formats a discrete stage badge indicating muted video is synced with Spotify Connect audio. */
export function formatSpotifyVideoSyncBadge(output: PlaybackOutput): string | null {
  if (output.type !== 'spotify') return null;
  return `🔊 ${output.deviceName} · Vídeo sincronizado`;
}

/** Normalizes Spotify Connect API errors into actionable messages and error codes. */
export function describeSpotifyConnectError(err: unknown): { message: string; code?: string } {
  if (err instanceof ApiError) {
    if (err.code === 'PREMIUM_REQUIRED') {
      return {
        code: 'PREMIUM_REQUIRED',
        message: 'Conta Spotify Premium necessária para controlar dispositivos Spotify Connect.',
      };
    }
    if (err.code === 'NO_ACTIVE_DEVICE') {
      return {
        code: 'NO_ACTIVE_DEVICE',
        message: 'Nenhum dispositivo Spotify Connect ativo. Abra o Spotify na caixa de som ou TV e atualize.',
      };
    }
    if (err.code === 'INSUFFICIENT_SCOPE') {
      return {
        code: 'INSUFFICIENT_SCOPE',
        message: 'Permissão de playback ausente no token. Clique em Reconectar Spotify.',
      };
    }
    return { code: err.code, message: err.message };
  }
  return { message: err instanceof Error ? err.message : 'Erro ao comunicar com o Spotify Connect' };
}
