import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as auth from './auth.ts';
import { startBroker } from './index.ts';

test("an operator's agent and CI tokens are members, and a prefix token uploads only builds under its prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-tokens-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: { token?: string; role?: string; error?: { code: string } } }> => {
      const res = await fetch(`${broker.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: await res.json() };
    };
    const admin = broker.adminToken('test');
    assert.equal((await call(admin, 'GET', '/v1/me')).json.role, 'operator');

    const agent = (await call(admin, 'POST', '/v1/tokens', { agent: true })).json.token ?? '';
    assert.equal((await call(agent, 'GET', '/v1/me')).json.role, 'member');
    assert.equal((await call(agent, 'POST', '/v1/builds?name=App.app')).json.error?.code, 'UPLOAD_NOT_ALLOWED');
    assert.equal((await call(agent, 'POST', '/v1/tokens', { scopes: ['install:upload'] })).status, 403);
    assert.equal((await call(admin, 'POST', '/v1/tokens', { agent: true, scopes: ['operator'] })).json.error?.code, 'BAD_SCOPE');

    const pr = (await call(admin, 'POST', '/v1/tokens', { scopes: ['install:upload:pr-'] })).json.token ?? '';
    assert.equal((await call(pr, 'GET', '/v1/me')).json.role, 'member');
    assert.equal((await call(pr, 'POST', '/v1/builds?name=App.app')).json.error?.code, 'UPLOAD_NOT_ALLOWED');
    // Allowed past the scope check, so the upload itself fails on the empty body.
    assert.notEqual((await call(pr, 'POST', '/v1/builds?name=pr-12')).json.error?.code, 'UPLOAD_NOT_ALLOWED');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("after the upgrade an operator's CLI token is still an operator's, and its other tokens are members", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-tokens-test-'));
  const first = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  const ops = auth.createAccount(first.db, 'ops', 'operator');
  const cli = auth.mintToken(first.db, 'member', { accountId: ops.id, label: 'CLI on laptop' });
  const bot = auth.mintToken(first.db, 'member', { accountId: ops.id, label: 'frode' });
  await first.close();
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    assert.equal(auth.authenticate(broker.db, { authorization: `Bearer ${cli}` }, Date.now())?.role, 'operator');
    assert.equal(auth.authenticate(broker.db, { authorization: `Bearer ${bot}` }, Date.now())?.role, 'member');
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
