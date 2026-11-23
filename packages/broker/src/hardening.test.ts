import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { WebSocket } from 'ws';
import * as auth from './auth.ts';
import { Db, startCleanup } from './db.ts';
import { startBroker } from './index.ts';
import { ApiError } from './leases/service.ts';
import { accountFor, Oidc, oidcFromEnv, safeNext } from './oidc.ts';
import { parseViewerInput } from './stream.ts';
import { saveUpload } from './routes/uploads.ts';

async function withBroker(fn: (broker: Awaited<ReturnType<typeof startBroker>>) => Promise<void>, oidc?: Parameters<typeof startBroker>[0]['oidc']): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-hardening-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1', ...(oidc ? { oidc } : {}) });
  try {
    await fn(broker);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the limiter blocks a key after five failures for a minute, then lets it through', () => {
  let now = 1_000_000;
  const limiter = new auth.AttemptLimiter(() => now);
  for (let i = 0; i < 4; i += 1) {
    limiter.fail(['name:dana']);
  }
  limiter.assertOpen(['name:dana']);
  limiter.fail(['name:dana']);
  assert.throws(() => limiter.assertOpen(['ip:1', 'name:dana']), (err) => err instanceof ApiError && err.status === 429 && /60 seconds/.test(err.message));
  limiter.assertOpen(['name:eve']);
  now += 59_000;
  assert.throws(() => limiter.assertOpen(['name:dana']), (err) => err instanceof ApiError && /1 seconds/.test(err.message));
  now += 1_000;
  limiter.assertOpen(['name:dana']);
});

test('failures older than ten minutes stop counting, and the limiter keeps a bounded number of keys', () => {
  let now = 0;
  const limiter = new auth.AttemptLimiter(() => now, { maxEntries: 3 });
  for (let i = 0; i < 4; i += 1) {
    limiter.fail(['a']);
  }
  now += 11 * 60_000;
  limiter.fail(['a']);
  limiter.assertOpen(['a']);
  for (let i = 0; i < 5; i += 1) {
    limiter.fail(['a']);
  }
  assert.throws(() => limiter.assertOpen(['a']));
  for (const key of ['b', 'c', 'd']) {
    limiter.fail([key]);
  }
  limiter.assertOpen(['a']);
});

test('at most four password checks run at once and the queue is bounded', async () => {
  const jobs = Array.from({ length: 50 }, () => auth.checkPassword('x', auth.DUMMY_HASH));
  const results = await Promise.allSettled(jobs);
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(refused.length, 14);
  assert.ok(refused.every((r) => r.reason instanceof ApiError && r.reason.status === 429));
});

test('login is refused with 429 after five failures, even with the right password, and unknown names cost a password hash', async () => {
  await withBroker(async (broker) => {
    auth.createAccount(broker.db, 'dana', 'member', await auth.hashPassword('correct horse'));
    const login = (name: string, password: string): Promise<Response> => post(`${broker.url}/v1/login`, { name, password });
    const started = performance.now();
    assert.equal((await login('nobody', 'whatever')).status, 401);
    assert.ok(performance.now() - started > 8, 'an unknown name should run a password hash too');
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await login('dana', 'wrong')).status, 401);
    }
    const blocked = await login('dana', 'correct horse');
    assert.equal(blocked.status, 429);
    const message = (await blocked.json()).error.message;
    assert.match(message, /Wait \d+ seconds/);
  });
});

test('invite acceptance and SSO start share the limiter', async () => {
  await withBroker(async (broker) => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await post(`${broker.url}/v1/invites/dp_invite_nope/accept`, { name: 'x', password: 'correct horse' })).status, 404);
    }
    assert.equal((await post(`${broker.url}/v1/invites/dp_invite_nope/accept`, { name: 'x', password: 'correct horse' })).status, 429);
  });
});

test('next accepts only plain local paths', () => {
  assert.equal(safeNext('/runs?x=1'), '/runs?x=1');
  assert.equal(safeNext('/'), '/');
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil', '/a\\b', '/a\nb', '/a\u0000b', '']) {
    assert.equal(safeNext(bad), '/', JSON.stringify(bad));
  }
});

test('an OIDC domain list admits verified emails at those domains only', () => {
  const db = new Db(':memory:');
  const config = { issuer: 'https://idp.example', clientId: 'c', domains: ['example.com'] };
  const base = { iss: config.issuer, aud: 'c', exp: 0 };
  assert.ok(accountFor(db, config, { ...base, sub: '1', email: 'kim@Example.com', email_verified: true }));
  for (const claims of [
    { ...base, sub: '2', email: 'kim@evil.com', email_verified: true },
    { ...base, sub: '3', email: 'kim@example.com' },
    { ...base, sub: '4', email: 'kim@example.com', email_verified: false },
    { ...base, sub: '5' },
  ]) {
    assert.throws(() => accountFor(db, config, claims), (err) => err instanceof ApiError && err.status === 403 && err.code === 'OIDC_DOMAIN');
  }
  assert.equal(db.accounts().length, 1);
});

test('the OIDC settings warn once when nothing limits who can sign in, and read the domain list', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const open = oidcFromEnv({ DEVICEPOOL_OIDC_ISSUER: 'https://idp.example', DEVICEPOOL_OIDC_CLIENT_ID: 'c' });
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /Every account at https:\/\/idp\.example can sign in.*DEVICEPOOL_OIDC_DOMAINS/);
  assert.equal(open?.domains, undefined);
  const limited = oidcFromEnv({ DEVICEPOOL_OIDC_ISSUER: 'https://idp.example', DEVICEPOOL_OIDC_CLIENT_ID: 'c', DEVICEPOOL_OIDC_DOMAINS: 'Example.com, @corp.example' });
  assert.deepEqual(limited?.domains, ['example.com', 'corp.example']);
  oidcFromEnv({ DEVICEPOOL_OIDC_ISSUER: 'https://idp.example', DEVICEPOOL_OIDC_CLIENT_ID: 'c', DEVICEPOOL_OIDC_GROUPS: '{"a":"b"}' });
  assert.equal(warn.mock.callCount(), 1);
});

test('the SSO sign-in table keeps at most 1000 pending sign-ins', async () => {
  const idp = createServer((req, res) => {
    const base = `http://${req.headers.host}`;
    res.end(JSON.stringify({ issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` }));
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  try {
    const address = idp.address();
    const oidc = new Oidc({ issuer: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, clientId: 'c' });
    const first = await oidc.start('http://x/cb', '/');
    for (let i = 0; i < 1100; i += 1) {
      await oidc.start('http://x/cb', '/');
    }
    const pending = Reflect.get(oidc, 'pending');
    assert.equal(pending instanceof Map ? pending.size : -1, 1000);
    assert.equal(pending instanceof Map ? pending.has(first.state) : true, false);
  } finally {
    idp.close();
  }
});

test('a request with the session cookie from another origin is refused, bearer tokens and same-origin requests are not', async () => {
  await withBroker(async (broker) => {
    const account = auth.createAccount(broker.db, 'ops', 'operator');
    const cookie = `${auth.SESSION_COOKIE}=${auth.startSession(broker.db, account.id, Date.now())}`;
    const evil = { cookie, origin: 'https://evil.example' };
    const refused = await post(`${broker.url}/v1/tokens`, {}, evil);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error.message, /evil\.example/);
    assert.equal((await post(`${broker.url}/v1/tokens`, {}, { cookie, origin: broker.url })).status, 201);
    assert.equal((await post(`${broker.url}/v1/tokens`, {}, { cookie })).status, 201);
    assert.equal((await post(`${broker.url}/v1/tokens`, {}, { authorization: `Bearer ${broker.adminToken('t')}`, origin: 'https://evil.example' })).status, 201);
    assert.equal((await fetch(`${broker.url}/v1/me`, { headers: evil })).status, 200);
  });
});

test('a cookie-authenticated stream upgrade from another origin is refused with a message', async () => {
  await withBroker(async (broker) => {
    const account = auth.createAccount(broker.db, 'ops', 'operator');
    const cookie = `${auth.SESSION_COOKIE}=${auth.startSession(broker.db, account.id, Date.now())}`;
    const ws = new WebSocket(`${broker.url.replace('http', 'ws')}/v1/leases/nope/stream`, { headers: { cookie, origin: 'https://evil.example' } });
    const body = await new Promise<string>((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve(text));
      });
      ws.on('error', () => {});
      ws.on('open', () => reject(new Error('opened')));
    });
    assert.match(body, /evil\.example/);
  });
});

test('the session cookie is Secure behind a TLS-terminating proxy', async () => {
  await withBroker(async (broker) => {
    auth.createAccount(broker.db, 'dana', 'member', await auth.hashPassword('correct horse'));
    const plain = await post(`${broker.url}/v1/login`, { name: 'dana', password: 'correct horse' });
    assert.doesNotMatch(plain.headers.get('set-cookie') ?? '', /Secure/);
    const proxied = await post(`${broker.url}/v1/login`, { name: 'dana', password: 'correct horse' }, { 'x-forwarded-proto': 'https' });
    assert.match(proxied.headers.get('set-cookie') ?? '', /Secure/);
  });
});

test('the console is served with security headers', async () => {
  await withBroker(async (broker) => {
    const res = await fetch(`${broker.url}/`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, new RegExp(`connect-src 'self' ws://${new URL(broker.url).host}`));
    await res.arrayBuffer();
  });
});

test('a JSON body that is malformed, not an object or over 1 MB is refused with a clear error', async () => {
  await withBroker(async (broker) => {
    const headers = { authorization: `Bearer ${broker.adminToken('t')}` };
    const bad = await post(`${broker.url}/v1/invites`, '{nope', headers);
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'BAD_JSON');
    const list = await post(`${broker.url}/v1/invites`, '[1]', headers);
    assert.equal(list.status, 400);
    assert.match((await list.json()).error.message, /JSON object/);
    const big = await post(`${broker.url}/v1/invites`, JSON.stringify({ pad: 'x'.repeat(1_100_000) }), headers);
    assert.equal(big.status, 413);
  });
});

test('viewer input of the wrong shape is dropped', () => {
  assert.deepEqual(parseViewerInput('{"type":"tap","point":[0.5,0.5]}'), { type: 'tap', point: [0.5, 0.5] });
  assert.deepEqual(parseViewerInput('{"type":"key","key":"a","modifiers":["shift"]}'), { type: 'key', key: 'a', modifiers: ['shift'] });
  assert.deepEqual(parseViewerInput('{"type":"keyframe"}'), { type: 'keyframe' });
  assert.deepEqual(parseViewerInput('{"type":"touch","phase":"move","point":[0.2,0.8]}'), { type: 'touch', phase: 'move', point: [0.2, 0.8] });
  for (const bad of ['nope', 'null', '5', '[]', '{}', '{"type":"tap"}', '{"type":"tap","point":["a",1]}', '{"type":"tap","point":[1]}', '{"type":"swipe","from":[0,0],"to":[1,1],"durationMs":"x"}', '{"type":"type","text":5}', '{"type":"key","key":"a","modifiers":["meta"]}', '{"type":"button","button":"power"}', '{"type":"touch","phase":"hover","point":[0,0]}', '{"type":"touch","phase":"down"}', '{"type":"nuke"}']) {
    assert.equal(parseViewerInput(bad), null, bad);
  }
});

test('two uploads at once keep their own bytes, and a refused upload leaves no file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-upload-test-'));
  const db = new Db(':memory:');
  const ctx = { dataDir: dir, db, store: { saved: async (): Promise<void> => {} } };
  try {
    const a = Buffer.alloc(3_000_000, 1);
    const b = Buffer.alloc(3_000_000, 2);
    const [x, y] = await Promise.all([saveUpload(Readable.from([a]), ctx, 'a'), saveUpload(Readable.from([b]), ctx, 'b')]);
    for (const [saved, bytes] of [[x, a], [y, b]] as const) {
      assert.equal(saved.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(createHash('sha256').update(await readFile(join(dir, 'builds', saved.sha256))).digest('hex'), saved.sha256);
    }
    await assert.rejects(
      saveUpload(Readable.from([a]), ctx, 'c', () => {
        throw new ApiError(404, 'LEASE_NOT_FOUND', 'no');
      }),
      /no/,
    );
    assert.deepEqual((await readdir(join(dir, 'builds'))).filter((f) => f.startsWith('.')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a transaction rolls back every write when one fails, and nested ones join the outer', () => {
  const db = new Db(':memory:');
  assert.throws(() =>
    db.tx(() => {
      auth.createAccount(db, 'a', 'member');
      db.tx(() => auth.createAccount(db, 'b', 'member'));
      throw new Error('boom');
    }),
  );
  assert.equal(db.accounts().length, 0);
  db.tx(() => auth.createAccount(db, 'c', 'member'));
  assert.equal(db.accounts().length, 1);
});

test('the cleanup removes expired sessions and tokens with their limits and keeps the rest', () => {
  const db = new Db(':memory:');
  const account = auth.createAccount(db, 'a', 'member');
  const old = auth.mintToken(db, 'member', { accountId: account.id, expiresAt: 1000 });
  const fresh = auth.mintToken(db, 'member', { accountId: account.id, expiresAt: 9000 });
  const forever = auth.mintToken(db, 'member', { accountId: account.id });
  db.setTokenLimits(auth.sha256(old), { agent: true, idleMs: null, maxMs: null, graceMs: null });
  db.insertSession('s-old', account.id, 1000);
  db.insertSession('s-new', account.id, 9000);
  const stop = startCleanup(db, 3_600_000, () => 5000);
  stop();
  assert.equal(db.getToken(auth.sha256(old)), null);
  assert.equal(db.tokenLimits(auth.sha256(old)), null);
  assert.ok(db.getToken(auth.sha256(fresh)));
  assert.ok(db.getToken(auth.sha256(forever)));
  assert.equal(db.sessionAccount('s-old', 0), null);
  assert.equal(db.sessionAccount('s-new', 0), account.id);
});
