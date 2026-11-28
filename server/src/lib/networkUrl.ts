import fs from 'node:fs';
import os from 'node:os';

const VIRTUAL_IFACE_RE =
  /^(?:lo\d*$|docker|veth|br-|virbr|cni|flannel|cali|kube|podman|lxcbr|lxdbr|vboxnet|vmnet)/i;

const VPN_OVERLAY_IFACE_RE = /^(?:tailscale|wg\d|tun\d|tap\d|utun\d|zt)/i;
const ETHERNET_IFACE_RE = /^(?:eth[a-z0-9._:-]*|en[a-z0-9._:-]*)$/i;
const WIFI_IFACE_RE = /^(?:wlan[a-z0-9._:-]*|wl[a-z0-9._:-]*|wifi[a-z0-9._:-]*|ath[a-z0-9._:-]*)$/i;

export interface LanDetectionOptions {
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  routeTable?: string | null;
}

export interface EffectivePublicUrlResult {
  publicUrl: string | null;
  lanIps: string[];
  lanUrl: string | null;
  publicUrlWarning: string | null;
}

export interface ResolveEffectivePublicUrlOptions extends LanDetectionOptions {
  publicUrl: string | null | undefined;
  port: number;
  lanIps?: string[];
}

export const parseIpv4Octets = (ip: string): [number, number, number, number] | null => {
  const trimmed = ip.trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return null;
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number.parseInt(part, 10);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
};

/** Checks whether `host` is an RFC 1918 private IPv4 literal (10/8, 172.16/12, 192.168/16). */
export const isPrivateIpv4 = (host: string): boolean => {
  const octets = parseIpv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
};

export const isValidUnicastLanIpv4 = (ip: string): boolean => {
  const octets = parseIpv4Octets(ip);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0 || a === 127 || a >= 224) return false;
  if (a === 169 && b === 254) return false;
  return true;
};

export const isExcludedVirtualInterface = (name: string): boolean => VIRTUAL_IFACE_RE.test(name.trim());

/** Parses `/proc/net/route` content and returns interface names carrying an active IPv4 default route, ordered by metric. */
export const parseDefaultRouteInterfaces = (routeTable: string | null | undefined): string[] => {
  if (!routeTable) return [];
  const matches: Array<{ iface: string; metric: number; order: number }> = [];
  const lines = routeTable.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    const iface = cols[0];
    const destination = cols[1];
    const flagsHex = cols[3];
    const metricRaw = cols[6];
    if (!iface || !destination || !flagsHex) continue;
    if (destination !== '00000000') continue;
    const flags = Number.parseInt(flagsHex, 16);
    if (!Number.isFinite(flags) || (flags & 0x1) === 0) continue;
    if (isExcludedVirtualInterface(iface)) continue;
    const parsedMetric = Number.parseInt(metricRaw ?? '0', 10);
    matches.push({
      iface,
      metric: Number.isFinite(parsedMetric) ? parsedMetric : 0,
      order: i,
    });
  }
  matches.sort((a, b) => a.metric - b.metric || a.order - b.order);
  return [...new Set(matches.map((m) => m.iface))];
};

const readLinuxRouteTable = (): string | null => {
  try {
    return fs.readFileSync('/proc/net/route', 'utf8');
  } catch {
    // Non-Linux OS or restricted procfs: fall back to interface name heuristics.
    return null;
  }
};

const scoreInterfacePriority = (ifaceName: string, defaultRouteIfaces: readonly string[]): number => {
  const clean = ifaceName.trim();
  if (VPN_OVERLAY_IFACE_RE.test(clean)) return 400;
  const routeIdx = defaultRouteIfaces.indexOf(clean);
  if (routeIdx >= 0) return routeIdx;
  if (ETHERNET_IFACE_RE.test(clean)) return 100;
  if (WIFI_IFACE_RE.test(clean)) return 101;
  return 200;
};

/**
 * Lists active IPv4 LAN addresses, filtering virtual/container bridges (`lo`, `docker0`, `veth*`, `br-*`, etc.)
 * and prioritizing the Linux default-route interface and physical Ethernet/Wi-Fi adapters over VPN overlays.
 */
export const listLanIpv4Addresses = (options?: LanDetectionOptions): string[] => {
  const nets = options?.interfaces ?? os.networkInterfaces();
  const routeTable =
    options?.routeTable !== undefined ? options.routeTable : options?.interfaces ? null : readLinuxRouteTable();
  const defaultRouteIfaces = parseDefaultRouteInterfaces(routeTable);

  const candidates: Array<{ address: string; tier: number; privateRank: number; order: number }> = [];
  let order = 0;

  for (const [ifaceName, entries] of Object.entries(nets)) {
    if (isExcludedVirtualInterface(ifaceName)) continue;
    const tier = scoreInterfacePriority(ifaceName, defaultRouteIfaces);
    for (const entry of entries ?? []) {
      const isIpv4 = entry.family === 'IPv4' || String(entry.family) === '4';
      if (!isIpv4 || entry.internal || !entry.address) continue;
      const address = entry.address.trim();
      if (!isValidUnicastLanIpv4(address)) continue;
      candidates.push({
        address,
        tier,
        privateRank: isPrivateIpv4(address) ? 0 : 1,
        order: order++,
      });
    }
  }

  candidates.sort((a, b) => a.tier - b.tier || a.privateRank - b.privateRank || a.order - b.order);
  return [...new Set(candidates.map((c) => c.address))];
};

export const buildLanUrl = (ip: string | null | undefined, port: number): string | null => {
  const clean = ip?.trim();
  if (!clean) return null;
  return port === 80 ? `http://${clean}` : `http://${clean}:${port}`;
};

/**
 * Validates `PUBLIC_URL` against active host interfaces:
 * - Preserves external/HTTPS domains, `.local` hostnames, and RFC 1918 IPs owned by this machine.
 * - Discards orphan RFC 1918 private IPs belonging to another network/DHCP lease in favor of `lanUrl`.
 */
export const resolveEffectivePublicUrl = (options: ResolveEffectivePublicUrlOptions): EffectivePublicUrlResult => {
  const lanIps =
    options.lanIps ??
    listLanIpv4Addresses({
      interfaces: options.interfaces,
      routeTable: options.routeTable,
    });
  const lanUrl = buildLanUrl(lanIps[0] ?? null, options.port);
  const rawPublicUrl = (options.publicUrl ?? '').trim().replace(/\/+$/, '');

  if (!rawPublicUrl) {
    return {
      publicUrl: null,
      lanIps,
      lanUrl,
      publicUrlWarning: null,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawPublicUrl);
  } catch {
    // Malformed URL in env: ignore safely in favor of detected LAN URL.
    const fallbackNote = lanUrl ? `Usando ${lanUrl} automaticamente.` : 'Aguardando endereço ativo na rede.';
    return {
      publicUrl: lanUrl,
      lanIps,
      lanUrl,
      publicUrlWarning: `PUBLIC_URL inválido ("${rawPublicUrl}") foi ignorado. ${fallbackNote}`,
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const fallbackNote = lanUrl ? `Usando ${lanUrl} automaticamente.` : 'Aguardando endereço ativo na rede.';
    return {
      publicUrl: lanUrl,
      lanIps,
      lanUrl,
      publicUrlWarning: `PUBLIC_URL com protocolo não suportado ("${rawPublicUrl}") foi ignorado. ${fallbackNote}`,
    };
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateIpv4(hostname) && !lanIps.includes(hostname)) {
    const fallbackNote = lanUrl ? `Usando ${lanUrl} automaticamente.` : 'Aguardando conexão de rede ativa.';
    return {
      publicUrl: lanUrl,
      lanIps,
      lanUrl,
      publicUrlWarning: `PUBLIC_URL (${rawPublicUrl}) aponta para o IP privado ${hostname}, que não pertence a nenhuma interface ativa desta máquina. ${fallbackNote}`,
    };
  }

  return {
    publicUrl: rawPublicUrl,
    lanIps,
    lanUrl,
    publicUrlWarning: null,
  };
};
