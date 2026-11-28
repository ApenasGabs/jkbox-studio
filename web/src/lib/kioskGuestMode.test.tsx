import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Kiosk, KioskGuestOverlay } from '../pages/Kiosk';
import { Remote } from '../pages/Remote';
import { createKioskInputController, mapKeyToKioskCommand, SELECT_LONG_PRESS_MS } from './kioskInput';
import {
  EMBEDDED_GUEST_RETURN_LABEL,
  hasFromKioskQuery,
  resolveEffectiveRemoteRole,
  resolveGuestModeAfterCommand,
  shouldShowReturnToKiosk,
  STANDALONE_KIOSK_RETURN_HREF,
  STANDALONE_KIOSK_RETURN_LABEL,
} from './kioskGuestMode';

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubKioskBrowserGlobals = () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
  vi.stubGlobal('window', {
    location: {
      origin: 'http://127.0.0.1:3000',
      href: 'http://127.0.0.1:3000/',
      search: '',
    },
  });
};

describe('shouldShowReturnToKiosk (proteção contra armadilha em /remote)', () => {
  it('detecta loopback (127.0.0.1, localhost, [::1]) e exibe retorno ao Kiosk', () => {
    expect(shouldShowReturnToKiosk('http://127.0.0.1:3000/remote')).toBe(true);
    expect(shouldShowReturnToKiosk('http://127.0.1.1:8080/remote')).toBe(true);
    expect(shouldShowReturnToKiosk('http://localhost:5173/remote')).toBe(true);
    expect(shouldShowReturnToKiosk('http://[::1]:3000/remote')).toBe(true);
  });

  it('detecta query ?from=kiosk mesmo fora de loopback', () => {
    expect(hasFromKioskQuery('http://192.168.31.50:3000/remote?from=kiosk')).toBe(true);
    expect(shouldShowReturnToKiosk('http://192.168.31.50:3000/remote?from=kiosk')).toBe(true);
    expect(shouldShowReturnToKiosk('http://jkbox.local:3000/remote?from=KIOSK&tab=queue')).toBe(true);
    expect(shouldShowReturnToKiosk('/remote?from=kiosk')).toBe(true);
  });

  it('oculta retorno ao Kiosk para celulares de convidados comuns na LAN ou mDNS', () => {
    expect(shouldShowReturnToKiosk('http://192.168.31.50:3000/remote')).toBe(false);
    expect(shouldShowReturnToKiosk('http://10.0.0.15:3000/remote')).toBe(false);
    expect(shouldShowReturnToKiosk('http://jkbox.local:3000/remote')).toBe(false);
    expect(shouldShowReturnToKiosk('https://festa.example.com/remote?pin=1234')).toBe(false);
    expect(shouldShowReturnToKiosk('')).toBe(false);
    expect(shouldShowReturnToKiosk('http://[invalid')).toBe(false);
  });
});

describe('resolveEffectiveRemoteRole e fechamento por Esc / BACK no Kiosk', () => {
  it('força papel de convidado quando Remote está embutido sobre o Kiosk', () => {
    expect(resolveEffectiveRemoteRole({ hostPinRequired: false }, true, true)).toBe('guest');
    expect(resolveEffectiveRemoteRole({ hostPinRequired: true }, true, true)).toBe('guest');
    expect(resolveEffectiveRemoteRole({ hostPinRequired: true }, true, false)).toBe('host');
    expect(resolveEffectiveRemoteRole({ hostPinRequired: false }, false, false)).toBe('host');
  });

  it('fecha o modo convidado automaticamente via Esc (BACK), clique longo em SELECT (jkbox-buttons) ou MENU', () => {
    const escCmd = mapKeyToKioskCommand('Escape');
    expect(escCmd).toBe('BACK');
    expect(resolveGuestModeAfterCommand(true, escCmd!)).toBe(false);
    expect(resolveGuestModeAfterCommand(true, 'MENU')).toBe(false);
    expect(resolveGuestModeAfterCommand(true, 'DOWN')).toBe(true);
    expect(resolveGuestModeAfterCommand(true, 'SELECT')).toBe(true);
    expect(resolveGuestModeAfterCommand(true, 'PLAY')).toBe(true);
    expect(resolveGuestModeAfterCommand(false, 'BACK')).toBe(false);

    vi.useFakeTimers();
    let guestModeOpen = true;
    const controller = createKioskInputController({
      onCommand: (cmd) => {
        guestModeOpen = resolveGuestModeAfterCommand(guestModeOpen, cmd);
      },
    });
    controller.handlePhase('SELECT', 'down');
    vi.advanceTimersByTime(SELECT_LONG_PRESS_MS);
    controller.handlePhase('SELECT', 'up');
    expect(guestModeOpen).toBe(false);
    vi.useRealTimers();
  });
});

describe('Renderização SSR de Remote e KioskGuestOverlay sem desmontar o Kiosk', () => {
  it('renderiza cabeçalho fixo "✕ Voltar para a TV (Kiosk)" com data-kiosk-default no modo embutido sem target="_blank"', () => {
    const html = renderToStaticMarkup(<Remote embedded onClose={() => {}} locationHref="http://127.0.0.1:3000/" />);
    expect(html).toContain(EMBEDDED_GUEST_RETURN_LABEL);
    expect(html).toContain('data-kiosk-default="true"');
    expect(html).not.toContain(STANDALONE_KIOSK_RETURN_LABEL);
    expect(html).not.toContain('🔒 Host');
    expect(html).not.toContain('target="_blank"');
  });

  it('renderiza link fixo "← Voltar ao Kiosk" na mesma aba (href="/") em /remote standalone via loopback ou ?from=kiosk', () => {
    const loopbackHtml = renderToStaticMarkup(<Remote locationHref="http://127.0.0.1:3000/remote" />);
    expect(loopbackHtml).toContain(STANDALONE_KIOSK_RETURN_LABEL);
    expect(loopbackHtml).toContain(`href="${STANDALONE_KIOSK_RETURN_HREF}"`);
    expect(loopbackHtml).not.toContain(EMBEDDED_GUEST_RETURN_LABEL);
    expect(loopbackHtml).not.toContain('target="_blank"');

    const queryHtml = renderToStaticMarkup(<Remote locationHref="http://192.168.31.50:3000/remote?from=kiosk" />);
    expect(queryHtml).toContain(STANDALONE_KIOSK_RETURN_LABEL);
    expect(queryHtml).toContain(`href="${STANDALONE_KIOSK_RETURN_HREF}"`);
    expect(queryHtml).not.toContain('target="_blank"');
  });

  it('não renderiza botão de retorno ao Kiosk quando convidado acessa /remote pelo IP da LAN', () => {
    const lanGuestHtml = renderToStaticMarkup(<Remote locationHref="http://192.168.31.50:3000/remote" />);
    expect(lanGuestHtml).not.toContain(STANDALONE_KIOSK_RETURN_LABEL);
    expect(lanGuestHtml).not.toContain(EMBEDDED_GUEST_RETURN_LABEL);
    expect(lanGuestHtml).not.toContain('target="_blank"');
  });

  it('abre e fecha KioskGuestOverlay sobre o Kiosk preservando <audio> montado e sem links target="_blank"', () => {
    stubKioskBrowserGlobals();
    const closedHtml = renderToStaticMarkup(
      <>
        <Kiosk />
        <KioskGuestOverlay open={false} onClose={() => {}} />
      </>,
    );
    expect(closedHtml).toContain('<audio');
    expect(closedHtml).not.toContain('data-kiosk-scope="guest-remote"');
    expect(closedHtml).not.toContain('target="_blank"');

    const openHtml = renderToStaticMarkup(
      <>
        <Kiosk />
        <KioskGuestOverlay open={true} onClose={() => {}} />
      </>,
    );
    expect(openHtml).toContain('<audio');
    expect(openHtml).toContain('data-kiosk-scope="guest-remote"');
    expect(openHtml).toContain(EMBEDDED_GUEST_RETURN_LABEL);
    expect(openHtml).not.toContain('target="_blank"');
  });

  it('garante classes responsivas sem overflow para viewports 375x812, 768x1024 e 1440x900 (compatível com npm run typecheck, npm test e npm run build)', () => {
    const overlayHtml = renderToStaticMarkup(<KioskGuestOverlay open={true} onClose={() => {}} />);
    expect(overlayHtml).toContain('overflow-x-hidden');
    expect(overlayHtml).toContain('overflow-y-auto');
    expect(overlayHtml).toContain('w-full');
    expect(overlayHtml).toContain('sm:w-auto');

    const standaloneLoopbackHtml = renderToStaticMarkup(<Remote locationHref="http://127.0.0.1:3000/remote" />);
    expect(standaloneLoopbackHtml).toContain('w-full');
    expect(standaloneLoopbackHtml).toContain('sm:w-auto');
    expect(standaloneLoopbackHtml).toContain('max-w-3xl');
    expect(standaloneLoopbackHtml).toContain('lg:max-w-4xl');
  });
});
