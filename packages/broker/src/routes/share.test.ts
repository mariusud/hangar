import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as auth from '../auth.ts';
import { startBroker } from '../index.ts';
import { checkViewLink, signViewLink } from './recordings.ts';

test('a view link is good for one recording until it expires, and a changed one is refused', () => {
  const key = Buffer.alloc(32, 7);
  const view = signViewLink(key, 'rec-1', 2_000);
  assert.equal(checkViewLink(key, 'rec-1', view, 1_999), true);
  assert.equal(checkViewLink(key, 'rec-1', view, 2_000), false);
  assert.equal(checkViewLink(key, 'rec-2', view, 1_000), false);
  assert.equal(checkViewLink(Buffer.alloc(32, 8), 'rec-1', view, 1_000), false);
  assert.equal(checkViewLink(key, 'rec-1', view.replace(/^2000/, '9000'), 1_000), false);
  assert.equal(checkViewLink(key, 'rec-1', 'nonsense', 1_000), false);
});

test('someone without an account opens a shared recording, and can do nothing else with the link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-share-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const member = (name: string): string => auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, name, 'member').id });
    const alice = member('alice');
    const admin = auth.createAccount(broker.db, 'ops', 'operator');
    const op = auth.mintToken(broker.db, 'member', { accountId: admin.id, scopes: ['operator'] });
    await fetch(`${broker.url}/v1/teams`, { method: 'POST', headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Other' }) });
    const outsider = member('mallory');
    await fetch(`${broker.url}/v1/people/mallory/team`, { method: 'PUT', headers: { authorization: `Bearer ${op}`, 'content-type': 'application/json' }, body: JSON.stringify({ team: 'other' }) });
    const owner = broker.db.accountByName('alice');
    assert.ok(owner);
    for (const id of ['rec-1', 'rec-2']) {
      broker.db.insertRecording({ id, leaseId: `l-${id}`, accountId: owner.id, state: 'ready', startedAt: 1, endedAt: 2, bytes: 0, error: null, device: 'iPhone 17, iOS 26.5' });
    }
    await mkdir(join(dir, 'recordings', 'rec-1'), { recursive: true });
    await writeFile(join(dir, 'recordings', 'rec-1', 'timeline.json'), '[{"at":0,"what":"Tap"}]');

    const share = (token: string | null, id: string, body?: unknown): Promise<Response> =>
      fetch(`${broker.url}/v1/recordings/${id}/share`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    assert.equal((await share(null, 'rec-1')).status, 401);
    assert.equal((await share(outsider, 'rec-1')).status, 404);
    assert.equal((await share(alice, 'rec-1', { days: 90 })).status, 400);
    const before = Date.now();
    const made = await share(alice, 'rec-1');
    assert.equal(made.status, 201);
    const link = (await made.json()) as { url: string; view: string; expiresAt: number };
    assert.ok(link.expiresAt >= before + 7 * 24 * 60 * 60_000 && link.expiresAt <= Date.now() + 7 * 24 * 60 * 60_000);
    assert.match(link.url, /\/recordings\/rec-1\?view=\d+\.[\w-]+$/);
    const view = encodeURIComponent(link.view);

    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1`)).status, 401);
    const opened = await fetch(`${broker.url}/v1/recordings/rec-1?view=${view}`);
    assert.equal(opened.status, 200);
    assert.equal(((await opened.json()) as { device: string }).device, 'iPhone 17, iOS 26.5');
    const timeline = await fetch(`${broker.url}/v1/recordings/rec-1/timeline.json?view=${view}`);
    assert.deepEqual(await timeline.json(), [{ at: 0, what: 'Tap' }]);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1/timeline.json`)).status, 401);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1/timeline.json?view=${view}x`)).status, 401);

    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-2?view=${view}`)).status, 401);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1?view=${view}`, { headers: { authorization: `Bearer ${outsider}` } })).status, 200);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1`, { headers: { authorization: `Bearer ${outsider}` } })).status, 404);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1?view=${view}`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1/share?view=${view}`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${broker.url}/v1/recordings?all=1&view=${view}`)).status, 401);

    const deleted = await fetch(`${broker.url}/v1/recordings/rec-1`, { method: 'DELETE', headers: { authorization: `Bearer ${alice}` } });
    assert.equal(deleted.status, 204);
    assert.equal((await fetch(`${broker.url}/v1/recordings/rec-1?view=${view}`)).status, 404);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
