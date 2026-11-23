const MDNS_HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const DEFAULT_MDNS_HOSTNAME = 'jkbox';

export class MdnsError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Validates and normalizes an mDNS hostname (RFC 1123 label without `.local`).
 * Accepts optional trailing `.local` and strips it. Rejects anything unsafe
 * for DNS or shell/OS hostname commands.
 */
export const normalizeMdnsHostname = (raw: unknown): string => {
  if (typeof raw !== 'string') {
    throw new MdnsError('Hostname inválido');
  }
  const cleaned = raw.trim().toLowerCase().replace(/\.local\.?$/i, '');
  if (cleaned.length < 2 || cleaned.length > 63 || !MDNS_HOSTNAME_RE.test(cleaned)) {
    throw new MdnsError(
      'Use de 2 a 63 caracteres: apenas letras minúsculas, números e hífen (sem iniciar ou terminar com hífen).',
    );
  }
  return cleaned;
};

export const isValidMdnsHostname = (raw: unknown): boolean => {
  try {
    normalizeMdnsHostname(raw);
    return true;
  } catch {
    return false;
  }
};

export const buildMdnsUrl = (hostname: string, port: number): string => {
  const fqdn = `${hostname}.local`;
  return port === 80 ? `http://${fqdn}` : `http://${fqdn}:${port}`;
};

// --- Minimal RFC 6762 mDNS packet helpers (zero external dependencies) ---

export interface DnsQuestion {
  name: string;
  type: number;
  qclass: number;
}

const DNS_TYPE_A = 1;
const DNS_TYPE_PTR = 12;
const DNS_TYPE_TXT = 16;
const DNS_TYPE_SRV = 33;
const DNS_TYPE_ANY = 255;
const DNS_CLASS_IN = 1;
const DNS_CLASS_IN_FLUSH = 0x8001;

export const MDNS_HTTP_SERVICE = '_http._tcp.local';
export const MDNS_SERVICES_META = '_services._dns-sd._udp.local';

export const encodeDnsName = (name: string): Buffer => {
  const labels = name
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'utf8');
    if (buf.length === 0 || buf.length > 63) {
      throw new Error(`Invalid DNS label: ${label}`);
    }
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
};

const readDnsName = (buf: Buffer, startOffset: number): { name: string; nextOffset: number } | null => {
  const labels: string[] = [];
  let offset = startOffset;
  let jumped = false;
  let nextOffset = startOffset;
  let hops = 0;

  while (offset < buf.length && hops < 32) {
    hops += 1;
    const len = buf[offset];
    if (len === undefined) return null;
    if (len === 0) {
      if (!jumped) nextOffset = offset + 1;
      return { name: labels.join('.').toLowerCase(), nextOffset };
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length) return null;
      const ptr = ((len & 0x3f) << 8) | buf[offset + 1]!;
      if (!jumped) nextOffset = offset + 2;
      offset = ptr;
      jumped = true;
      continue;
    }
    if (offset + 1 + len > buf.length) return null;
    labels.push(buf.subarray(offset + 1, offset + 1 + len).toString('utf8'));
    offset += 1 + len;
  }
  return null;
};

/** Parses standard mDNS query packets (QR = 0) and extracts its questions. */
export const parseMdnsQuestions = (packet: Buffer): DnsQuestion[] => {
  if (packet.length < 12) return [];
  const flags = packet.readUInt16BE(2);
  // Ignore responses (QR bit set)
  if ((flags & 0x8000) !== 0) return [];
  const qdcount = packet.readUInt16BE(4);
  if (qdcount === 0 || qdcount > 64) return [];

  const questions: DnsQuestion[] = [];
  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    const parsed = readDnsName(packet, offset);
    if (!parsed || parsed.nextOffset + 4 > packet.length) break;
    const type = packet.readUInt16BE(parsed.nextOffset);
    const qclass = packet.readUInt16BE(parsed.nextOffset + 2) & 0x7fff;
    questions.push({ name: parsed.name, type, qclass });
    offset = parsed.nextOffset + 4;
  }
  return questions;
};

export const matchesMdnsAQuery = (questions: DnsQuestion[], fqdn: string): boolean => {
  const target = fqdn.toLowerCase().replace(/\.$/, '');
  return questions.some(
    (q) =>
      q.name === target &&
      (q.type === DNS_TYPE_A || q.type === DNS_TYPE_ANY) &&
      (q.qclass === DNS_CLASS_IN || q.qclass === DNS_TYPE_ANY),
  );
};

export const matchesMdnsQuery = (questions: DnsQuestion[], hostname: string): 'service' | 'a' | null => {
  const clean = hostname.toLowerCase().replace(/\.local\.?$/, '');
  const instance = `${clean}.${MDNS_HTTP_SERVICE}`;
  const isServiceMatch = questions.some(
    (q) =>
      (q.qclass === DNS_CLASS_IN || q.qclass === DNS_TYPE_ANY) &&
      ((q.name === MDNS_SERVICES_META && (q.type === DNS_TYPE_PTR || q.type === DNS_TYPE_ANY)) ||
        (q.name === MDNS_HTTP_SERVICE && (q.type === DNS_TYPE_PTR || q.type === DNS_TYPE_ANY)) ||
        (q.name === instance &&
          (q.type === DNS_TYPE_SRV || q.type === DNS_TYPE_TXT || q.type === DNS_TYPE_ANY))),
  );
  if (isServiceMatch) return 'service';
  return matchesMdnsAQuery(questions, `${clean}.local`) ? 'a' : null;
};

const buildDnsResponseHeader = (answerCount: number): Buffer => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // Transaction ID = 0 for mDNS
  header.writeUInt16BE(0x8400, 2); // QR=1, AA=1
  header.writeUInt16BE(0, 4); // QDCOUNT = 0
  header.writeUInt16BE(answerCount, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT
  return header;
};

const buildDnsRecord = (name: string, type: number, rrClass: number, ttlSec: number, rdata: Buffer): Buffer => {
  const meta = Buffer.alloc(10);
  meta.writeUInt16BE(type, 0);
  meta.writeUInt16BE(rrClass, 2);
  meta.writeUInt32BE(ttlSec, 4);
  meta.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeDnsName(name), meta, rdata]);
};

const filterValidIpv4 = (ipv4Addresses: string[]): string[] =>
  ipv4Addresses.filter((ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip));

const buildARecord = (fqdn: string, ip: string, ttlSec: number): Buffer => {
  const rdata = Buffer.from(ip.split('.').map((octet) => Number.parseInt(octet, 10) & 0xff));
  return buildDnsRecord(fqdn, DNS_TYPE_A, DNS_CLASS_IN_FLUSH, ttlSec, rdata);
};

/** Builds an mDNS authoritative response containing A records for `<fqdn>`. */
export const buildMdnsAResponse = (fqdn: string, ipv4Addresses: string[], ttlSec = 120): Buffer => {
  const validIps = filterValidIpv4(ipv4Addresses);
  const header = buildDnsResponseHeader(validIps.length);
  const records = validIps.map((ip) => buildARecord(fqdn, ip, ttlSec));
  return Buffer.concat([header, ...records]);
};

/**
 * Builds an RFC 6762 / 6763 DNS-SD response announcing `_http._tcp.local`
 * along with SRV, TXT and A records for `<hostname>.local:<port>`.
 */
export const buildMdnsServiceResponse = (
  hostname: string,
  port: number,
  ipv4Addresses: string[],
  ttlSec = 120,
): Buffer => {
  const clean = hostname.toLowerCase().replace(/\.local\.?$/, '');
  const fqdn = `${clean}.local`;
  const instance = `${clean}.${MDNS_HTTP_SERVICE}`;
  const validIps = filterValidIpv4(ipv4Addresses);

  const srvHead = Buffer.alloc(6);
  srvHead.writeUInt16BE(0, 0); // priority
  srvHead.writeUInt16BE(0, 2); // weight
  srvHead.writeUInt16BE(port & 0xffff, 4);
  const srvRdata = Buffer.concat([srvHead, encodeDnsName(fqdn)]);

  const txtEntries = ['path=/', 'app=jkbox'].map((entry) => {
    const buf = Buffer.from(entry, 'utf8');
    return Buffer.concat([Buffer.from([buf.length]), buf]);
  });

  const records = [
    buildDnsRecord(MDNS_SERVICES_META, DNS_TYPE_PTR, DNS_CLASS_IN, ttlSec, encodeDnsName(MDNS_HTTP_SERVICE)),
    buildDnsRecord(MDNS_HTTP_SERVICE, DNS_TYPE_PTR, DNS_CLASS_IN, ttlSec, encodeDnsName(instance)),
    buildDnsRecord(instance, DNS_TYPE_SRV, DNS_CLASS_IN_FLUSH, ttlSec, srvRdata),
    buildDnsRecord(instance, DNS_TYPE_TXT, DNS_CLASS_IN_FLUSH, ttlSec, Buffer.concat(txtEntries)),
    ...validIps.map((ip) => buildARecord(fqdn, ip, ttlSec)),
  ];

  return Buffer.concat([buildDnsResponseHeader(records.length), ...records]);
};
