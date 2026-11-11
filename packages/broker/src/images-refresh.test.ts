import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type BrokerMessage, type DeviceImage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { imageHosts, refreshApps } from './images.ts';
import { startBroker } from './index.ts';
import { ApiError } from './leases/service.ts';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ApiError);
    return err.code;
  }
  return 'none';
}

test('a new build replaces the app with the same build name', () => {
  const app = { sha256: 'a1', name: 'App.app' };
  const helper = { sha256: 'h1', name: 'Helper.app' };
  assert.deepEqual(refreshApps([app, helper], [{ sha256: 'a2', name: 'App.app' }]), ['a2', 'h1']);
  assert.deepEqual(refreshApps([app, helper], [{ sha256: 'h2', name: 'Helper.app' }, { sha256: 'a2', name: 'App.app' }]), ['a2', 'h2']);
  assert.deepEqual(refreshApps([app], [{ sha256: 'a2', name: 'upload' }]), ['a2'], 'an image with one app takes any one build');
  assert.equal(code(() => refreshApps([app, helper], [{ sha256: 'x', name: 'Other.app' }])), 'WHICH_APP');
  assert.equal(code(() => refreshApps([app], [{ sha256: 'x', name: 'Other.app' }, { sha256: 'y', name: 'More.app' }])), 'WHICH_APP');
  assert.equal(code(() => refreshApps([app], [])), 'NO_BUILD');
});

test('an image is ready when every connected iOS host offers it', () => {
  const plain = { model: 'iPhone 17', os: '26.5' };
  const offering = [plain, { ...plain, image: 'nightly' }];
  assert.deepEqual(imageHosts('nightly', []), { state: 'no-hosts', hosts: [] });
  assert.deepEqual(imageHosts('nightly', [{ name: 'mac-1', connected: true, offers: [plain] }]), { state: 'pending', hosts: [{ host: 'mac-1', state: 'pending' }] });
  assert.deepEqual(
    imageHosts('Nightly', [
      { name: 'mac-1', connected: true, offers: offering },
      { name: 'mac-2', connected: false, offers: [plain] },
      { name: 'linux', connected: true, offers: [{ ...plain, platform: 'android-emulator' }] },
    ]),
    { state: 'ready', hosts: [{ host: 'mac-1', state: 'ready' }] },
    'disconnected Macs and Android-only hosts do not count',
  );
  assert.equal(imageHosts('nightly', [{ name: 'mac-1', connected: true, offers: offering }, { name: 'mac-2', connected: true, offers: [plain] }]).state, 'pending');
});

test('refreshing an image sends hosts a new image id and shows its builds and state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-image-refresh-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const messages: BrokerMessage[] = [];
    const handlers = broker.attach({ send: (m) => messages.push(m), close: () => {} });
    const hello = (offers: { model: string; os: string; image?: string }[]): void => {
      handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers, devices: [], leases: [] });
    };
    hello([{ model: 'iPhone 17', os: '26.5' }]);
    const op = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ops', 'operator').id });
    const qa = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'qa', 'member').id });
    broker.db.insertBuild('a'.repeat(64), 'App.app', join(dir, 'nothing'), 1);
    broker.db.insertBuild('b'.repeat(64), 'App.app', join(dir, 'nothing'), 1);
    const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
      const res = await fetch(`${broker.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const lastImages = (): DeviceImage[] => {
      const m = messages.filter((x) => x.type === 'images').at(-1);
      assert.ok(m?.type === 'images');
      return m.images;
    };
    const listed = async (): Promise<{ id: string; apps: string[]; builds: { sha256: string; name: string }[]; state: string; hosts: { host: string; state: string }[] }> => {
      const r = await call(qa, 'GET', '/v1/images');
      assert.equal(r.status, 200);
      assert.ok(Array.isArray(r.json));
      return r.json[0];
    };

    assert.equal((await call(op, 'PUT', '/v1/images/nightly', { apps: ['a'.repeat(64)], locale: 'nb_NO' })).status, 200);
    const first = lastImages()[0];
    let row = await listed();
    assert.deepEqual(row.builds, [{ sha256: 'a'.repeat(64), name: 'App.app' }]);
    assert.equal(row.state, 'pending', 'the host has not built it yet');
    hello([{ model: 'iPhone 17', os: '26.5' }, { model: 'iPhone 17', os: '26.5', image: 'nightly' }]);
    row = await listed();
    assert.equal(row.state, 'ready');
    assert.deepEqual(row.hosts, [{ host: 'fake-mac', state: 'ready' }]);

    assert.equal((await call(qa, 'POST', '/v1/images/nightly/refresh', { apps: ['b'.repeat(64)] })).status, 403);
    assert.equal((await call(op, 'POST', '/v1/images/missing/refresh', { apps: ['b'.repeat(64)] })).status, 404);
    assert.equal((await call(op, 'POST', '/v1/images/nightly/refresh', { apps: ['nope'] })).status, 404);
    assert.equal((await call(op, 'POST', '/v1/images/nightly/refresh', {})).status, 400);

    const sent = messages.length;
    const refreshed = await call(op, 'POST', '/v1/images/nightly/refresh', { apps: ['b'.repeat(64)] });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json && typeof refreshed.json === 'object' && 'changed' in refreshed.json);
    assert.equal(refreshed.json.changed, true);
    const second = lastImages()[0];
    assert.ok(messages.length > sent, 'hosts hear about the new build');
    assert.notEqual(second?.id, first?.id);
    assert.equal(second?.locale, 'nb_NO', 'the rest of the declaration stays');
    assert.deepEqual(second?.apps.map((a) => a.sha256), ['b'.repeat(64)]);
    row = await listed();
    assert.equal(row.id, second?.id);
    assert.deepEqual(row.apps, ['b'.repeat(64)]);

    const again = messages.length;
    const same = await call(op, 'POST', '/v1/images/nightly/refresh', { apps: ['b'.repeat(64)] });
    assert.ok(same.json && typeof same.json === 'object' && 'changed' in same.json);
    assert.equal(same.json.changed, false, 'the same build again is a no-op');
    assert.equal(messages.length, again, 'and hosts rebuild nothing');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
