import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type AgentMessage, type BrokerMessage, type DeviceImage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { Db } from './db.ts';
import { imageHosts, openSecret, sealSecret, type ImageStatus } from './images.ts';
import { startBroker, type Broker } from './index.ts';

type Call = (token: string, method: string, path: string, body?: unknown) => Promise<{ status: number; json: unknown }>;

function caller(broker: Broker): Call {
  return async (token, method, path, body) => {
    const res = await fetch(`${broker.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && key in value ? Object.entries(value).find(([k]) => k === key)?.[1] : undefined;
}

test('a sealed secret opens only with its key and under its name', () => {
  const key = randomBytes(32);
  const sealed = sealSecret(key, 'USER_PASSWORD', 'hunter2');
  assert.ok(!sealed.includes('hunter2'));
  assert.notEqual(sealSecret(key, 'USER_PASSWORD', 'hunter2'), sealed, 'each seal uses a new nonce');
  assert.equal(openSecret(key, 'USER_PASSWORD', sealed), 'hunter2');
  assert.equal(openSecret(key, 'USER_EMAIL', sealed), null, 'a value moved to another name does not open');
  assert.equal(openSecret(randomBytes(32), 'USER_PASSWORD', sealed), null);
  assert.equal(openSecret(key, 'USER_PASSWORD', 'hunter2'), null, 'plaintext is not a sealed value');
  assert.equal(openSecret(key, 'USER_PASSWORD', `${sealed.slice(0, -2)}AA`), null, 'a changed value does not open');
});

test('plaintext secrets are encrypted when the broker starts, and hosts still get the values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-secrets-test-'));
  const old = new Db(join(dir, 'hangar.db'));
  old.saveImageSecret('USER_PASSWORD', 'hunter2', 1000);
  old.sql.close();
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const key = await stat(join(dir, 'image-secrets.key'));
    assert.equal(key.mode & 0o777, 0o600);
    assert.equal((await readFile(join(dir, 'image-secrets.key'))).length, 32);
    const stored = broker.db.imageSecretValues(['USER_PASSWORD']).USER_PASSWORD ?? '';
    assert.ok(stored.startsWith('aes-256-gcm:'), 'the row is encrypted');
    assert.ok(!stored.includes('hunter2'));
    assert.deepEqual(broker.db.imageSecrets(), [{ name: 'USER_PASSWORD', updatedAt: 1000 }], 'migrating keeps the time it was set');

    const call = caller(broker);
    const op = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ops', 'operator').id, scopes: ['operator', 'install:upload'] });
    broker.db.insertBuild('a'.repeat(64), 'App.app', join(dir, 'nothing'), 1);
    assert.equal((await call(op, 'PUT', '/v1/image-secrets/USER_EMAIL', { value: 'qa@example.com' })).status, 204);
    assert.ok(!(broker.db.imageSecretValues(['USER_EMAIL']).USER_EMAIL ?? '').includes('qa@example.com'), 'new values are stored encrypted');
    const listed = await call(op, 'GET', '/v1/image-secrets');
    assert.ok(!JSON.stringify(listed.json).includes('hunter2'));
    assert.ok(!JSON.stringify(listed.json).includes('aes-256-gcm'), 'not even the sealed value comes back');

    const flow = 'appId: com.example.app\n---\n- launchApp\n';
    assert.equal((await call(op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'], signIn: { flow, env: ['USER_EMAIL', 'USER_PASSWORD'] } })).status, 200);
    const messages: BrokerMessage[] = [];
    broker.attach({ send: (m) => messages.push(m), close: () => {} }).message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }], devices: [], leases: [] });
    const images = messages.find((m) => m.type === 'images');
    assert.ok(images?.type === 'images');
    assert.deepEqual(images.images[0]?.setup?.signIn?.values, { USER_EMAIL: 'qa@example.com', USER_PASSWORD: 'hunter2' });

    // A value sealed under a lost key is listed as unreadable and not sent to hosts.
    broker.db.saveImageSecret('USER_PASSWORD', sealSecret(randomBytes(32), 'USER_PASSWORD', 'other'), 2000);
    const after = await call(op, 'GET', '/v1/image-secrets');
    assert.deepEqual(after.json, [
      { name: 'USER_EMAIL', updatedAt: field(Array.isArray(after.json) ? after.json[0] : null, 'updatedAt') },
      { name: 'USER_PASSWORD', updatedAt: 2000, unreadable: true },
    ]);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an image declared with follow takes a new upload of its app, and other images do not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-follow-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const call = caller(broker);
    const op = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ops', 'operator').id, scopes: ['operator', 'install:upload'] });
    const messages: BrokerMessage[] = [];
    broker.attach({ send: (m) => messages.push(m), close: () => {} }).message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }], devices: [], leases: [] });
    const upload = async (name: string, body: string): Promise<{ sha256: string; images: string[] }> => {
      const res = await fetch(`${broker.url}/v1/builds?name=${name}`, { method: 'POST', headers: { authorization: `Bearer ${op}` }, body });
      assert.equal(res.status, 201);
      const json: unknown = await res.json();
      const images = field(json, 'images');
      return { sha256: String(field(json, 'sha256')), images: Array.isArray(images) ? images.map(String) : [] };
    };
    const first = await upload('App.app', 'build one');
    const helper = await upload('Helper.app', 'helper');
    assert.equal((await call(op, 'PUT', '/v1/images/nightly', { apps: ['App.app', 'Helper.app'], follow: true })).status, 200);
    assert.equal((await call(op, 'PUT', '/v1/images/pinned', { apps: [first.sha256] })).status, 200);
    assert.equal((await call(op, 'PUT', '/v1/images/empty', { follow: true })).status, 400, 'following needs an app to follow');
    assert.equal((await call(op, 'PUT', '/v1/images/bad', { apps: ['App.app'], follow: 'yes' })).status, 400);
    const sent = messages.length;

    assert.deepEqual((await upload('Other.app', 'other')).images, [], 'a build under another name changes nothing');
    assert.equal(messages.length, sent);

    const second = await upload('App.app', 'build two');
    assert.deepEqual(second.images, ['nightly']);
    assert.ok(messages.length > sent, 'hosts hear about the new build');
    const last = messages.filter((m) => m.type === 'images').at(-1);
    assert.ok(last?.type === 'images');
    const byName = (name: string): DeviceImage | undefined => last.images.find((i) => i.name === name);
    assert.deepEqual(byName('nightly')?.apps.map((a) => a.sha256), [second.sha256, helper.sha256], 'only the app with the same build name is replaced');
    assert.deepEqual(byName('pinned')?.apps.map((a) => a.sha256), [first.sha256], 'an image without follow keeps its build');

    const listed = await call(op, 'GET', '/v1/images');
    assert.ok(Array.isArray(listed.json));
    assert.equal(field(listed.json.find((i) => field(i, 'name') === 'nightly'), 'follow'), true);
    assert.equal(field(listed.json.find((i) => field(i, 'name') === 'pinned'), 'follow'), undefined);
    assert.deepEqual((await upload('App.app', 'build two')).images, [], 'the same build again is a no-op');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a host image status shows per host, and a failed image refuses new leases with what to do', () => {
  const plain = { model: 'iPhone 17', os: '26.5' };
  const failed = new Map<string, ImageStatus>([['id1', { state: 'failed', message: 'SIGN_IN_ENV_MISSING' }]]);
  assert.deepEqual(imageHosts('nightly', [{ name: 'mac-1', connected: true, offers: [plain], images: failed }], 'id1'), {
    state: 'failed',
    hosts: [{ host: 'mac-1', state: 'failed', message: 'SIGN_IN_ENV_MISSING' }],
  });
  assert.equal(imageHosts('nightly', [{ name: 'mac-1', connected: true, offers: [plain], images: failed }], 'id2').state, 'pending', 'a status for an older declaration does not count');
  assert.deepEqual(
    imageHosts('nightly', [
      { name: 'mac-1', connected: true, offers: [plain], images: failed },
      { name: 'mac-2', connected: true, offers: [plain], images: new Map<string, ImageStatus>([['id1', { state: 'building' }]]) },
    ], 'id1'),
    { state: 'pending', hosts: [{ host: 'mac-1', state: 'failed', message: 'SIGN_IN_ENV_MISSING' }, { host: 'mac-2', state: 'building' }] },
  );
  assert.equal(imageHosts('nightly', [{ name: 'mac-1', connected: true, offers: [plain, { ...plain, image: 'nightly' }], images: failed }], 'id1').state, 'ready', 'an offered image is ready');
});

test('a failed golden build is shown as failed and new leases on it get IMAGE_FAILED', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-image-status-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const call = caller(broker);
    const op = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ops', 'operator').id, scopes: ['operator', 'install:upload'] });
    const qa = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'qa', 'member').id });
    broker.db.insertBuild('a'.repeat(64), 'App.app', join(dir, 'nothing'), 1);
    const messages: BrokerMessage[] = [];
    const host = broker.attach({ send: (m) => messages.push(m), close: () => {} });
    const send = (m: AgentMessage): void => host.message(m);
    const plain = { model: 'iPhone 17', os: '26.5' };
    send({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [plain], devices: [], leases: [] });
    assert.equal((await call(op, 'PUT', '/v1/images/nightly', { apps: ['App.app'] })).status, 200);
    const declared = messages.filter((m) => m.type === 'images').at(-1);
    assert.ok(declared?.type === 'images');
    const id = declared.images[0]?.id ?? '';
    assert.ok(id);
    const row = async (): Promise<unknown> => {
      const r = await call(qa, 'GET', '/v1/images');
      assert.ok(Array.isArray(r.json));
      return r.json[0];
    };

    send({ type: 'images.status', image: 'nightly', id, state: 'building' });
    assert.deepEqual(field(await row(), 'hosts'), [{ host: 'fake-mac', state: 'building' }]);
    assert.equal(field(await row(), 'state'), 'pending');

    send({ type: 'images.status', image: 'nightly', id, state: 'failed', message: 'App.app is not built for the simulator.' });
    assert.equal(field(await row(), 'state'), 'failed');
    assert.deepEqual(field(await row(), 'hosts'), [{ host: 'fake-mac', state: 'failed', message: 'App.app is not built for the simulator.' }]);
    const lease = await call(qa, 'POST', '/v1/leases', { class: { image: 'nightly' } });
    assert.equal(lease.status, 409);
    const error = field(lease.json, 'error');
    assert.equal(field(error, 'code'), 'IMAGE_FAILED');
    assert.match(String(field(error, 'message')), /fake-mac: App\.app is not built for the simulator\./);
    assert.match(String(field(error, 'hint')), /hangar image set/);

    // The status survives a reconnect hello, and a new build attempt clears it.
    send({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [plain], devices: [], leases: [] });
    assert.equal(field(await row(), 'state'), 'failed');
    send({ type: 'images.status', image: 'nightly', id, state: 'building' });
    assert.equal((await call(qa, 'POST', '/v1/leases', { class: { image: 'nightly' } })).status, 201, 'a lease waits while the image builds');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
