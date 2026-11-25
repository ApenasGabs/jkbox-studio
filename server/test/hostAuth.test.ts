import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { parseKioskControl } from '../src/lib/kioskControl.js';
import { attachRealtime } from '../src/realtime.js';
import { HostAuth, memorySettings } from '../src/services/hostAuth.js';
import { setup } from './helpers.js';

const REMOTE = { 'X-Forwarded-For': '192.168.0.50' };

function makeApp(env: Record<string, string> = {}) {
  const ctx = setup(env);
  return { ...ctx, app: createApp({ config: ctx.config, jukebox: ctx.jukebox }) };
}

describe('HostAuth (PIN automático do Controlador Principal)', () => {
  it('gera e persiste um PIN de 4 dígitos quando HOST_PIN está vazio', () => {
    const settings = memorySettings();
    const auth = new HostAuth('', settings, true);
    expect(auth.pin).toMatch(/^\d{4}$/);
    expect(auth.status()).toMatchObject({ source: 'auto', enabled: true, editable: true });
    // Persisted: a second instance (restart) reuses the same PIN.
    expect(new HostAuth('', settings, true).pin).toBe(auth.pin);
  });

  it('nunca sobrescreve o HOST_PIN do .env', () => {
    const settings = memorySettings();
    settings.set('host_pin', '1111');
    const auth = new HostAuth('9876', settings, true);
    expect(auth.status()).toEqual({ pin: '9876', source: 'env', enabled: true, editable: false });
    expect(auth.verify('9876')).toBe(true);
    expect(auth.verify('1111')).toBe(false);
    expect(() => auth.update({ pin: '2222' })).toThrow(/HOST_PIN/);
  });

  it('permite editar, desativar e reativar o PIN automático', () => {
    const auth = new HostAuth('', memorySettings(), true, () => '4242');
    expect(auth.pin).toBe('4242');
    expect(auth.update({ pin: '123456' }).pin).toBe('123456');
    expect(() => auth.update({ pin: '12' })).toThrow(/4 a 8/);
    expect(() => auth.update({ pin: 'abcd' })).toThrow(/4 a 8/);
    expect(auth.update({ enabled: false })).toMatchObject({ pin: '', source: 'none', enabled: false });
    expect(auth.verify(undefined)).toBe(true);
    expect(auth.update({ enabled: true })).toMatchObject({ pin: '123456', source: 'auto', enabled: true });
  });

  it('HOST_PIN_AUTO=false mantém o comportamento legado (sem PIN)', () => {
    const auth = new HostAuth('', memorySettings(), false);
    expect(auth.required).toBe(false);
    expect(auth.verify(undefined)).toBe(true);
  });
});

describe('Host vs Convidado na API', () => {
  it('convidados ficam sem poderes de Host quando o PIN é automático', async () => {
    const { app } = makeApp({ HOST_PIN_AUTO: 'true' });
    const cfg = (await request(app).get('/api/config').expect(200)).body;
    expect(cfg.hostPinRequired).toBe(true);

    await request(app).post('/api/player/skip').set(REMOTE).expect(403);
    await request(app).get('/api/host/pin').set(REMOTE).expect(403);
    expect((await request(app).post('/api/host/verify').set(REMOTE).expect(200)).body).toEqual({ ok: false });

    // The Kiosk on the same machine (loopback) can read the PIN to render the Main Controller QR.
    const { pin } = (await request(app).get('/api/host/pin').expect(200)).body;
    expect(pin).toMatch(/^\d{4}$/);
    expect((await request(app).post('/api/host/verify').set(REMOTE).send({ pin }).expect(200)).body).toEqual({ ok: true });
    await request(app).post('/api/player/skip').set(REMOTE).set('x-host-pin', pin).expect(200);
    await request(app).get('/api/host/pin').set(REMOTE).set('x-host-pin', pin).expect(200);
  });

  it('PATCH /api/host/pin edita o PIN e exige Host', async () => {
    const { app } = makeApp({ HOST_PIN_AUTO: 'true' });
    const { pin } = (await request(app).get('/api/host/pin').expect(200)).body;
    await request(app).patch('/api/host/pin').set(REMOTE).send({ pin: '5555' }).expect(403);
    await request(app).patch('/api/host/pin').set('x-host-pin', pin).send({ pin: '1' }).expect(400);
    const res = await request(app).patch('/api/host/pin').set('x-host-pin', pin).send({ pin: '5555' }).expect(200);
    expect(res.body).toMatchObject({ pin: '5555', source: 'auto' });
    await request(app).post('/api/player/skip').set(REMOTE).set('x-host-pin', pin).expect(403);
    await request(app).post('/api/player/skip').set(REMOTE).set('x-host-pin', '5555').expect(200);
  });

  it('PIN do .env é somente leitura no painel', async () => {
    const { app } = makeApp({ HOST_PIN: '1234' });
    await request(app).patch('/api/host/pin').set('x-host-pin', '1234').send({ pin: '9999' }).expect(409);
  });
});

describe('Controle remoto da TV (Kiosk) via /api/kiosk/control', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it('valida os comandos', () => {
    expect(parseKioskControl({ action: 'toggle' })).toEqual({ ok: true, control: { action: 'toggle' } });
    expect(parseKioskControl({ action: 'volume', value: 42.4 })).toEqual({ ok: true, control: { action: 'volume', value: 42 } });
    expect(parseKioskControl({ action: 'volume', value: 101 }).ok).toBe(false);
    expect(parseKioskControl({ action: 'stage', value: 'cinema' }).ok).toBe(true);
    expect(parseKioskControl({ action: 'stage', value: 'disco' }).ok).toBe(false);
    expect(parseKioskControl({ action: 'reactions', value: 'yes' }).ok).toBe(false);
    expect(parseKioskControl({ action: 'skip' }).ok).toBe(false);
    expect(parseKioskControl(null).ok).toBe(false);
  });

  it('exige Host e transmite kiosk_control por WebSocket', async () => {
    const { app, jukebox } = makeApp({ HOST_PIN: '1234' });
    const server = http.createServer(app);
    const wss = attachRealtime(server, jukebox);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      });
    const { port } = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received = new Promise<unknown>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'kiosk_control') resolve(msg);
      });
    });
    await new Promise((resolve) => ws.once('open', resolve));

    await request(server).post('/api/kiosk/control').send({ action: 'pause' }).expect(403);
    await request(server).post('/api/kiosk/control').set('x-host-pin', '1234').send({ action: 'stage', value: 'x' }).expect(400);
    await request(server)
      .post('/api/kiosk/control')
      .set('x-host-pin', '1234')
      .send({ action: 'stage', value: 'lyrics' })
      .expect(200, { ok: true, control: { action: 'stage', value: 'lyrics' } });
    expect(await received).toEqual({ type: 'kiosk_control', control: { action: 'stage', value: 'lyrics' } });
    ws.close();
  });
});
