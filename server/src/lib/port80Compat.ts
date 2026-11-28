import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const DEFAULT_PREFERRED_PORT = 80;
export const DEFAULT_FALLBACK_PORT = 3000;

const SAFE_HOST_RE = /^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?)$/;

export interface Port80CompatOptions {
  port: number;
  legacyRedirectPort?: number | null;
  kioskPreferPort80?: boolean;
  preferredPort?: number;
  fallbackPort?: number;
  host?: string;
  handler?: http.RequestListener;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  createServer?: (listener: http.RequestListener) => http.Server;
  listenServer?: (server: http.Server, port: number, host?: string) => Promise<number>;
}

export interface Port80CompatHandle {
  readonly effectivePort: number;
  readonly primaryPort: number;
  readonly secondaryPort: number | null;
  readonly primaryServer: http.Server;
  readonly secondaryServer: http.Server | null;
  attachApp: (handler: http.RequestListener) => void;
  closeAll: () => Promise<void>;
}

export const isRecoverableBindError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EADDRINUSE' || code === 'EPERM';
};

/**
 * Strips explicit `:80` or an inherited dev port (such as `:3000` from a copied `.env`)
 * from `PUBLIC_URL` when the Kiosk server is actively serving on port 80.
 */
export const normalizePublicUrlForPort = (
  publicUrl: string,
  configuredPort: number,
  effectivePort: number,
  preferredPort = DEFAULT_PREFERRED_PORT,
): string => {
  const trimmed = publicUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (effectivePort !== preferredPort) return trimmed;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return trimmed;
    const rawPortMatch = trimmed.match(/^http:\/\/(?:\[[^\]]+\]|[^/:?#]+):(\d+)(?=[/?#]|$)/i);
    const explicitPort = rawPortMatch?.[1] ?? parsed.port;
    if (
      explicitPort === String(preferredPort) ||
      (configuredPort !== effectivePort && explicitPort === String(configuredPort))
    ) {
      parsed.port = preferredPort === 80 ? '' : String(preferredPort);
    }
    const serialized = parsed.toString();
    return serialized.replace(/\/+$/, '');
  } catch {
    // Preserve unparseable strings unchanged so caller validation remains predictable.
    return trimmed;
  }
};

export const extractSafeHostname = (hostHeader: string | undefined): string | null => {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed || /[\s/@\\]/.test(trimmed)) return null;

  let host = trimmed;
  if (trimmed.startsWith('[')) {
    const closeIdx = trimmed.indexOf(']');
    if (closeIdx === -1) return null;
    const rest = trimmed.slice(closeIdx + 1);
    if (rest && !/^:\d+$/.test(rest)) return null;
    host = trimmed.slice(0, closeIdx + 1);
  } else {
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx !== -1) {
      const portPart = trimmed.slice(colonIdx + 1);
      if (!/^\d+$/.test(portPart)) return null;
      host = trimmed.slice(0, colonIdx);
    }
  }

  if (!host || host.includes('..') || !SAFE_HOST_RE.test(host)) return null;
  return host;
};

export const sanitizeRedirectPath = (rawUrl: string | undefined): string => {
  const cleaned = (rawUrl ?? '/').replace(/[\r\n]/g, '').trim();
  if (!cleaned) return '/';
  const qIdx = cleaned.indexOf('?');
  const rawPath = qIdx === -1 ? cleaned : cleaned.slice(0, qIdx);
  const query = qIdx === -1 ? '' : cleaned.slice(qIdx);
  const normalizedPath = `/${rawPath.replace(/^[/\\]+/, '')}`;
  return `${normalizedPath}${query}`;
};

export const buildLegacyRedirectLocation = (
  hostHeader: string | undefined,
  rawUrl: string | undefined,
  targetPort = DEFAULT_PREFERRED_PORT,
): string | null => {
  const safeHost = extractSafeHostname(hostHeader);
  if (!safeHost) return null;
  const safePath = sanitizeRedirectPath(rawUrl);
  const authority = targetPort === 80 ? safeHost : `${safeHost}:${targetPort}`;
  return `http://${authority}${safePath}`;
};

export const shouldRedirectLegacyRequest = (
  req: Pick<http.IncomingMessage, 'method' | 'url' | 'headers'>,
): boolean => {
  if (req.headers.upgrade) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = ((req.url ?? '/').split('?')[0] ?? '/').trim() || '/';
  if (pathname === '/api' || pathname.startsWith('/api/')) return false;
  if (pathname === '/ws' || pathname.startsWith('/ws/')) return false;
  return true;
};

const closeServerSafe = (server: http.Server | null): Promise<void> =>
  new Promise((resolve) => {
    if (!server || !server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

const defaultListenServer = (server: http.Server, port: number, host?: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('listening', onListening);
      try {
        server.close();
      } catch {
        // Ignore close errors on a socket that never finished binding.
      }
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr !== null ? (addr as AddressInfo).port : port;
      resolve(boundPort);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (host) {
      server.listen(port, host);
    } else {
      server.listen(port);
    }
  });

/**
 * Starts the primary HTTP server (preferring port 80 on Kiosk OS) plus an optional
 * compatibility listener on the legacy port (e.g. `:3000`), forwarding `/api/*` and
 * `/ws` upgrades seamlessly while redirecting legacy browser URLs to clean port 80.
 */
export const startPort80CompatServers = async (options: Port80CompatOptions): Promise<Port80CompatHandle> => {
  const configuredPort = options.port;
  const preferredPort = options.preferredPort ?? DEFAULT_PREFERRED_PORT;
  const legacyRedirectPort = options.legacyRedirectPort ?? null;
  const fallbackPort = options.fallbackPort ?? legacyRedirectPort ?? DEFAULT_FALLBACK_PORT;
  const preferPort80 = Boolean(options.kioskPreferPort80);
  const log = options.log ?? ((msg: string) => process.stdout.write(`${msg}\n`));
  const warn = options.warn ?? console.warn;
  const createServer = options.createServer ?? ((listener: http.RequestListener) => http.createServer(listener));
  const listenServer = options.listenServer ?? defaultListenServer;

  let currentHandler: http.RequestListener | null = options.handler ?? null;

  const dispatchToApp: http.RequestListener = (req, res) => {
    if (currentHandler) {
      currentHandler(req, res);
      return;
    }
    res.statusCode = 503;
    res.end('Starting');
  };

  const attachRuntimeErrorGuard = (server: http.Server, label: string): void => {
    server.on('error', (err) => {
      warn(`[jkbox] AVISO: erro em ${label}: ${err.message}`);
    });
  };

  const createLegacyCompatServer = (primary: http.Server, targetPort: number): http.Server => {
    const secondary = createServer((req, res) => {
      if (shouldRedirectLegacyRequest(req)) {
        const location = buildLegacyRedirectLocation(req.headers.host, req.url, targetPort);
        if (location) {
          res.writeHead(302, { Location: location });
          res.end();
          return;
        }
      }
      dispatchToApp(req, res);
    });
    secondary.on('upgrade', (req, socket, head) => {
      primary.emit('upgrade', req, socket, head);
    });
    return secondary;
  };

  const tryBindSecondary = async (
    primary: http.Server,
    targetPort: number,
    candidateSecondaryPort: number | null,
  ): Promise<{ server: http.Server | null; port: number | null }> => {
    if (candidateSecondaryPort === null || candidateSecondaryPort <= 0 || candidateSecondaryPort === targetPort) {
      return { server: null, port: null };
    }
    const candidate = createLegacyCompatServer(primary, targetPort);
    try {
      const boundPort = await listenServer(candidate, candidateSecondaryPort, options.host);
      attachRuntimeErrorGuard(candidate, `listener de compatibilidade :${boundPort}`);
      log(`[jkbox] compatibilidade ativa em http://0.0.0.0:${boundPort} -> porta ${targetPort}`);
      return { server: candidate, port: boundPort };
    } catch (err) {
      if (isRecoverableBindError(err)) {
        warn(
          `[jkbox] AVISO: porta de compatibilidade ${candidateSecondaryPort} indisponível (${(err as Error).message}); seguindo apenas na porta ${targetPort}`,
        );
        return { server: null, port: null };
      }
      await closeServerSafe(primary);
      throw err;
    }
  };

  let primaryServer: http.Server;
  let primaryPort: number;
  let secondaryServer: http.Server | null = null;
  let secondaryPort: number | null = null;

  if (configuredPort === preferredPort) {
    const candidatePrimary = createServer(dispatchToApp);
    try {
      primaryPort = await listenServer(candidatePrimary, preferredPort, options.host);
      primaryServer = candidatePrimary;
      attachRuntimeErrorGuard(primaryServer, `listener principal :${primaryPort}`);
      const secondary = await tryBindSecondary(primaryServer, primaryPort, legacyRedirectPort);
      secondaryServer = secondary.server;
      secondaryPort = secondary.port;
    } catch (err) {
      const canFallback = (preferPort80 || legacyRedirectPort !== null) && fallbackPort !== preferredPort;
      if (!canFallback || !isRecoverableBindError(err)) {
        throw err;
      }
      warn(
        `[jkbox] AVISO: não foi possível abrir a porta ${preferredPort} (${(err as Error).message}); usando fallback na porta ${fallbackPort}`,
      );
      const fallbackServer = createServer(dispatchToApp);
      primaryPort = await listenServer(fallbackServer, fallbackPort, options.host);
      primaryServer = fallbackServer;
      attachRuntimeErrorGuard(primaryServer, `listener fallback :${primaryPort}`);
    }
  } else if (preferPort80) {
    const opportunisticPrimary = createServer(dispatchToApp);
    try {
      primaryPort = await listenServer(opportunisticPrimary, preferredPort, options.host);
      primaryServer = opportunisticPrimary;
      attachRuntimeErrorGuard(primaryServer, `listener principal :${primaryPort}`);
      log(`[jkbox] porta ${primaryPort} habilitada no Kiosk OS (priorizando URL limpa sem :${configuredPort})`);
      const secondary = await tryBindSecondary(primaryServer, primaryPort, configuredPort);
      secondaryServer = secondary.server;
      secondaryPort = secondary.port;
    } catch (err) {
      if (!isRecoverableBindError(err)) {
        throw err;
      }
      warn(
        `[jkbox] AVISO: porta ${preferredPort} indisponível (${(err as Error).message}); mantendo PORT=${configuredPort}`,
      );
      const configuredServer = createServer(dispatchToApp);
      primaryPort = await listenServer(configuredServer, configuredPort, options.host);
      primaryServer = configuredServer;
      attachRuntimeErrorGuard(primaryServer, `listener principal :${primaryPort}`);
    }
  } else {
    const configuredServer = createServer(dispatchToApp);
    primaryPort = await listenServer(configuredServer, configuredPort, options.host);
    primaryServer = configuredServer;
    attachRuntimeErrorGuard(primaryServer, `listener principal :${primaryPort}`);
    const secondary = await tryBindSecondary(primaryServer, primaryPort, legacyRedirectPort);
    secondaryServer = secondary.server;
    secondaryPort = secondary.port;
  }

  return {
    effectivePort: primaryPort,
    primaryPort,
    secondaryPort,
    primaryServer,
    secondaryServer,
    attachApp: (handler: http.RequestListener) => {
      currentHandler = handler;
    },
    closeAll: async () => {
      await Promise.all([closeServerSafe(secondaryServer), closeServerSafe(primaryServer)]);
    },
  };
};
