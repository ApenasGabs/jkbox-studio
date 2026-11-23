import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  buildMdnsAResponse,
  buildMdnsServiceResponse,
  buildMdnsUrl,
  encodeDnsName,
  isValidMdnsHostname,
  matchesMdnsAQuery,
  matchesMdnsQuery,
  MdnsError,
  normalizeMdnsHostname,
  parseMdnsQuestions,
} from '../src/lib/mdns.js';
import { MdnsService } from '../src/services/mdns.js';
import { setup } from './helpers.js';

const buildQueryPacket = (name: string, qtype = 1): Buffer => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(0, 2); // QR=0
  header.writeUInt16BE(1, 4); // QDCOUNT=1
  const qname = encodeDnsName(name);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(qtype, 0);
  tail.writeUInt16BE(1, 2); // IN
  return Buffer.concat([header, qname, tail]);
};

describe('mDNS hostname validation & DNS packets', () => {
  it('accepts valid RFC 1123 hostnames and strips trailing .local', () => {
    expect(normalizeMdnsHostname('jkbox')).toBe('jkbox');
    expect(normalizeMdnsHostname('  Gabisa.LOCAL  ')).toBe('gabisa');
    expect(normalizeMdnsHostname('sala-churrasco-01')).toBe('sala-churrasco-01');
    expect(isValidMdnsHostname('servidor')).toBe(true);
  });

  it('rejects invalid hostnames and command-injection payloads', () => {
    const bad = [
      '',
      'a',
      '-jkbox',
      'jkbox-',
      'jk_box',
      'jk box',
      'foo;rm -rf /',
      'foo$(whoami)',
      'a'.repeat(64),
      'sub.domain',
      123,
    ];
    for (const value of bad) {
      expect(isValidMdnsHostname(value)).toBe(false);
      expect(() => normalizeMdnsHostname(value)).toThrow(MdnsError);
    }
  });

  it('builds URL omitting :80 when port is 80', () => {
    expect(buildMdnsUrl('gabisa', 3000)).toBe('http://gabisa.local:3000');
    expect(buildMdnsUrl('gabisa', 80)).toBe('http://gabisa.local');
  });

  it('parses mDNS A queries and builds valid A responses', () => {
    const query = buildQueryPacket('gabisa.local', 1);
    const questions = parseMdnsQuestions(query);
    expect(questions).toHaveLength(1);
    expect(matchesMdnsAQuery(questions, 'gabisa.local')).toBe(true);
    expect(matchesMdnsAQuery(questions, 'outro.local')).toBe(false);

    const response = buildMdnsAResponse('gabisa.local', ['192.168.31.6']);
    expect(response.readUInt16BE(2)).toBe(0x8400); // QR=1, AA=1
    expect(response.readUInt16BE(6)).toBe(1); // ANCOUNT=1
    // Last 4 bytes must be the IPv4 octets
    expect([...response.subarray(response.length - 4)]).toEqual([192, 168, 31, 6]);
    // Responses must not be parsed as queries
    expect(parseMdnsQuestions(response)).toEqual([]);
  });

  it('matches _http._tcp DNS-SD queries and builds PTR+SRV+TXT+A service responses', () => {
    const ptrQuery = buildQueryPacket('_http._tcp.local', 12);
    const metaQuery = buildQueryPacket('_services._dns-sd._udp.local', 12);
    const aQuery = buildQueryPacket('gabisa.local', 1);

    expect(matchesMdnsQuery(parseMdnsQuestions(ptrQuery), 'gabisa')).toBe('service');
    expect(matchesMdnsQuery(parseMdnsQuestions(metaQuery), 'gabisa')).toBe('service');
    expect(matchesMdnsQuery(parseMdnsQuestions(aQuery), 'gabisa')).toBe('a');
    expect(matchesMdnsQuery(parseMdnsQuestions(aQuery), 'outro')).toBeNull();

    const svcPacket = buildMdnsServiceResponse('gabisa', 3000, ['192.168.31.6']);
    expect(svcPacket.readUInt16BE(2)).toBe(0x8400); // QR=1, AA=1
    expect(svcPacket.readUInt16BE(6)).toBe(5); // PTR meta + PTR _http._tcp + SRV + TXT + A
    expect(svcPacket.toString('utf8')).toContain('path=/');
    expect([...svcPacket.subarray(svcPacket.length - 4)]).toEqual([192, 168, 31, 6]);
  });
});

describe('MdnsService & PATCH /api/config/hostname', () => {
  it('exposes mdns status in /api/config and updates hostname + useForQr', async () => {
    const { config, jukebox } = setup({ HOST_PIN: '1234' });
    const runHelper = vi.fn(async () => {});
    const mdns = new MdnsService({
      port: 3000,
      defaultHostname: 'jkbox',
      enabled: true,
      hostnameHelper: '/usr/local/bin/jkbox-hostname',
      settings: jukebox.settings,
      runHelper,
      detectDockerBridge: () => false,
    });
    mdns.start();
    const app = createApp({ config, jukebox, mdns });

    try {
      const initial = await request(app).get('/api/config').expect(200);
      expect(initial.body.mdns).toMatchObject({
        hostname: 'jkbox',
        fqdn: 'jkbox.local',
        url: 'http://jkbox.local:3000',
        mode: 'os-helper',
        active: true,
        useForQr: false,
      });

      // Rejected without HOST_PIN
      await request(app).patch('/api/config/hostname').send({ hostname: 'gabisa' }).expect(403);

      // Rejected with unsafe payload
      await request(app)
        .patch('/api/config/hostname')
        .set('x-host-pin', '1234')
        .send({ hostname: 'gabisa;id' })
        .expect(400);
      expect(runHelper).not.toHaveBeenCalled();

      const changedEvents: string[] = [];
      mdns.on('change', (status) => changedEvents.push(`${status.hostname}:${status.useForQr}`));

      // Valid update calls OS helper and persists
      const updated = await request(app)
        .patch('/api/config/hostname')
        .set('x-host-pin', '1234')
        .send({ hostname: 'Gabisa.local', useForQr: true })
        .expect(200);

      expect(runHelper).toHaveBeenCalledWith('/usr/local/bin/jkbox-hostname', 'gabisa');
      expect(changedEvents).toEqual(['gabisa:true']);
      expect(updated.body.mdns).toMatchObject({
        hostname: 'gabisa',
        fqdn: 'gabisa.local',
        url: 'http://gabisa.local:3000',
        useForQr: true,
      });
    } finally {
      mdns.stop();
      jukebox.stop();
    }
  });
});
