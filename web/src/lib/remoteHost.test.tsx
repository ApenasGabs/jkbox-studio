import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { RemoteHostPanel, type RemoteHostPanelProps } from '../components/RemoteHostPanel';
import { activateHostPin, buildHostControllerUrl, takePinFromUrl } from './hostPin';
import { REMOTE_HOST_TABS, resolveRemoteRole } from './remoteRole';
import type { AppConfig } from './types';

function fakeEnv(href: string) {
  const replaceState = vi.fn();
  return { env: { location: { href }, history: { replaceState, state: { k: 1 } } }, replaceState };
}

describe('takePinFromUrl (?pin= do QR do Controlador Principal)', () => {
  it('lê o PIN e limpa ?pin= da barra de endereço preservando outros parâmetros e o hash', () => {
    const { env, replaceState } = fakeEnv('http://jkbox.local:8080/remote?pin=4321&spotify=ok#fila');
    expect(takePinFromUrl(env)).toBe('4321');
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/remote?spotify=ok#fila');
  });

  it('remove o parâmetro mesmo vazio e retorna null', () => {
    const { env, replaceState } = fakeEnv('http://jkbox.local/remote?pin=%20');
    expect(takePinFromUrl(env)).toBeNull();
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/remote');
  });

  it('não mexe no histórico quando não há ?pin=', () => {
    const { env, replaceState } = fakeEnv('http://jkbox.local/remote');
    expect(takePinFromUrl(env)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('activateHostPin', () => {
  it('salva o PIN apenas quando o servidor valida', async () => {
    let stored = 'old';
    const deps = { getPin: () => stored, setPin: (pin: string) => void (stored = pin), verify: vi.fn() };
    deps.verify.mockResolvedValueOnce({ ok: true });
    expect(await activateHostPin('1234', deps)).toBe(true);
    expect(deps.verify).toHaveBeenCalledWith('1234');
    expect(stored).toBe('1234');

    deps.verify.mockResolvedValueOnce({ ok: false });
    expect(await activateHostPin('9999', deps)).toBe(false);
    expect(stored).toBe('1234');

    deps.verify.mockRejectedValueOnce(new Error('offline'));
    expect(await activateHostPin('0000', deps)).toBe(false);
    expect(stored).toBe('1234');
  });
});

describe('buildHostControllerUrl', () => {
  it('aponta o QR exclusivo para /remote?pin=<PIN>', () => {
    expect(buildHostControllerUrl('http://jkbox.local:8080/remote', '0042')).toBe('http://jkbox.local:8080/remote?pin=0042');
    expect(buildHostControllerUrl('/remote?x=1', '12 34')).toBe('/remote?x=1&pin=12%2034');
  });
});

describe('Host vs Convidado no /remote', () => {
  it('convidado nunca recebe poderes de Host enquanto o PIN é exigido', () => {
    expect(resolveRemoteRole(null, true)).toBe('guest');
    expect(resolveRemoteRole({ hostPinRequired: true }, false)).toBe('guest');
    expect(resolveRemoteRole({ hostPinRequired: true }, true)).toBe('host');
    // PIN explicitamente desativado pelo Host no painel ⚙︎ Host.
    expect(resolveRemoteRole({ hostPinRequired: false }, false)).toBe('host');
  });

  const config: AppConfig = {
    publicUrl: null,
    hostPinRequired: true,
    audioFormat: 'mp3',
    videoMode: 'off',
    autoDjEnabled: true,
    autoDjMode: 'vibe',
    playbackOutput: { type: 'local' },
    spotify: { configured: true, connected: true, playbackAuthorized: true, playlistUrl: null, redirectUri: 'http://x/cb' },
    mdns: null,
  } as unknown as AppConfig;

  const baseProps: RemoteHostPanelProps = {
    config,
    playbackOutput: { type: 'local' } as RemoteHostPanelProps['playbackOutput'],
    paused: false,
    currentTitle: 'Evidências',
    spotifyVolume: 80,
    onSpotifyVolumeChange: () => {},
    playlists: [],
    reloadKey: 0,
    mdns: null,
    onMdnsUpdated: () => {},
    onToast: () => {},
    onConfigChanged: () => {},
    onCatalogChanged: () => {},
    onPlaylistsChanged: () => {},
    onOpenCatalog: () => {},
    onOpenPlaylistsTab: () => {},
    onDiscoverVibe: () => {},
    onAddCurrentToPlaylist: () => {},
    onClose: () => {},
  };

  it('organiza o painel do Controlador Principal em abas Player & TV, Auto-DJ, Spotify e Acervo & Rede', () => {
    const html = renderToStaticMarkup(<RemoteHostPanel {...baseProps} />);
    for (const tab of REMOTE_HOST_TABS) expect(html).toContain(tab.label.replace('&', '&amp;'));
    expect(html).toContain('Play / Pause na TV');
    expect(html).toContain('Volume do player local da TV');
    for (const view of ['Capa', 'Letra', 'Clipe', 'Cinema']) expect(html).toContain(`>${view}<`);
    expect(html).toContain('Reações ao vivo na TV');
    expect(html).toContain('Pular faixa');
  });

  it('expõe Auto-DJ completo, gestão do Spotify e acervo nas demais abas', () => {
    const autodj = renderToStaticMarkup(<RemoteHostPanel {...baseProps} initialTab="autodj" />);
    for (const mode of ['Seguir clima atual', 'Travar em Categoria/Subcategoria', 'Travar em Playlist Interna', 'Aleatório']) {
      expect(autodj).toContain(mode);
    }
    expect(autodj).toContain('aria-label="Ativar Auto-DJ"');

    const spotify = renderToStaticMarkup(<RemoteHostPanel {...baseProps} initialTab="spotify" />);
    expect(spotify).toContain('Vincular');
    expect(spotify).toContain('Sincronizar fila');
    expect(spotify).toContain('Importar da playlist');
    expect(spotify).toContain('Desconectar');

    const library = renderToStaticMarkup(<RemoteHostPanel {...baseProps} initialTab="library" />);
    expect(library).toContain('Reescanear acervo');
    expect(library).toContain('Auto-categorizar acervo');
    expect(library).toContain('Forçar recategorização');
    expect(library).toContain('Popular semelhantes');
    expect(library).toContain('Atualização do Sistema');
    expect(library).toContain('Procurar atualizações');
  });
});
