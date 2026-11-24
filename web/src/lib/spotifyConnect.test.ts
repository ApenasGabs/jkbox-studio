import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import {
  describeSpotifyConnectError,
  formatSpotifyOutputBadge,
  formatSpotifyVideoSyncBadge,
  spotifyDeviceIcon,
  spotifyDeviceLabel,
} from './spotifyConnect';

describe('spotifyConnect helpers', () => {
  it('maps Spotify device types to icons and Portuguese labels', () => {
    expect(spotifyDeviceIcon('Speaker')).toBe('🔊');
    expect(spotifyDeviceIcon('TV')).toBe('📺');
    expect(spotifyDeviceIcon('Computer')).toBe('💻');
    expect(spotifyDeviceIcon('Smartphone')).toBe('📱');
    expect(spotifyDeviceIcon('Unknown')).toBe('🎵');

    expect(spotifyDeviceLabel('Speaker')).toBe('Caixa Wi-Fi');
    expect(spotifyDeviceLabel('TV')).toBe('TV');
    expect(spotifyDeviceLabel('CastAudio')).toBe('Chromecast Audio');
  });

  it('formats output badge only when Spotify Connect is active', () => {
    expect(formatSpotifyOutputBadge({ type: 'local' })).toBeNull();
    expect(
      formatSpotifyOutputBadge({ type: 'spotify', deviceId: 'dev-1', deviceName: 'Sala' }),
    ).toBe('🔊 Sala · Spotify Connect');
    expect(formatSpotifyVideoSyncBadge({ type: 'local' })).toBeNull();
    expect(
      formatSpotifyVideoSyncBadge({ type: 'spotify', deviceId: 'dev-2', deviceName: 'Home Theater 2' }),
    ).toBe('🔊 Home Theater 2 · Vídeo sincronizado');
  });

  it('describes Spotify Connect API errors clearly', () => {
    expect(describeSpotifyConnectError(new ApiError('raw', 403, 'PREMIUM_REQUIRED'))).toEqual({
      code: 'PREMIUM_REQUIRED',
      message: 'Conta Spotify Premium necessária para controlar dispositivos Spotify Connect.',
    });
    expect(describeSpotifyConnectError(new ApiError('raw', 404, 'NO_ACTIVE_DEVICE'))).toEqual({
      code: 'NO_ACTIVE_DEVICE',
      message: 'Nenhum dispositivo Spotify Connect ativo. Abra o Spotify na caixa de som ou TV e atualize.',
    });
    expect(describeSpotifyConnectError(new ApiError('raw', 403, 'INSUFFICIENT_SCOPE'))).toEqual({
      code: 'INSUFFICIENT_SCOPE',
      message: 'Permissão de playback ausente no token. Clique em Reconectar Spotify.',
    });
    expect(describeSpotifyConnectError(new Error('Falha de rede'))).toEqual({
      message: 'Falha de rede',
    });
  });
});
