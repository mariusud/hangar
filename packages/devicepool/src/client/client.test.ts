import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Devicepool, DevicepoolError, isStaleLogin, leaseEndMessage, refusedMessage, waitLine } from './index.ts';
import { deviceBuildProblem, missingFile } from './local.ts';

test('a path-looking argument that does not exist is a missing file, a plain name is a build', () => {
  assert.equal(missingFile('MyApp-pr-42'), null);
  assert.equal(missingFile('3f2a9c'), null);
  for (const arg of ['./build/MyApp.app', 'build/MyApp', 'MyApp.app', 'app-debug.apk', 'out.zip', 'x.TAR']) {
    assert.match(missingFile(arg)?.message ?? '', new RegExp(`^No such file: ${arg.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  }
});

test('a device build is refused with the flag that fixes it', () => {
  assert.equal(deviceBuildProblem('a.app', 'iphonesimulator'), null);
  assert.equal(deviceBuildProblem('a.app', null), null);
  const problem = deviceBuildProblem('build/MyApp.app', 'iphoneos');
  assert.equal(problem?.message, 'build/MyApp.app is a device build. Build for the simulator: -sdk iphonesimulator.');
});

test('a refused token is described by where it came from', () => {
  assert.equal(refusedMessage('saved', 'http://a:7420'), 'Your saved token was refused by http://a:7420. Run `devicepool login http://a:7420`.');
  assert.equal(refusedMessage('env', 'http://a:7420'), 'DEVICEPOOL_TOKEN was refused by http://a:7420.');
  assert.equal(refusedMessage(undefined, 'http://a:7420'), null);
});

test('a 401 reaches the user as a sentence about their token', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Token not valid.' } }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    await assert.rejects(new Devicepool({ url, token: 't', source: 'saved' }).devices(), (err) => err instanceof DevicepoolError && err.status === 401 && err.message === `Your saved token was refused by ${url}. Run \`devicepool login ${url}\`.`);
    await assert.rejects(new Devicepool({ url, token: 't', source: 'env' }).devices(), (err) => err instanceof DevicepoolError && err.message === `DEVICEPOOL_TOKEN was refused by ${url}.`);
    await assert.rejects(new Devicepool({ url, token: 't' }).devices(), (err) => err instanceof DevicepoolError && err.message === 'Token not valid.');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test('a saved sign-in is stale only for this address when the server refuses its token', () => {
  const saved = { url: 'http://a.local:7420/', token: 'old' };
  assert.equal(isStaleLogin(saved, 'http://a.local:7420', 401), true);
  assert.equal(isStaleLogin(saved, 'http://a.local:7420', 200), false);
  assert.equal(isStaleLogin(saved, 'http://a.local:7420', null), false);
  assert.equal(isStaleLogin(saved, 'http://b.local:7420', 401), false);
  assert.equal(isStaleLogin({ url: 'http://a.local:7420' }, 'http://a.local:7420', 401), false);
});

test('waiting for a device says the position, or the time when there is none', () => {
  assert.equal(waitLine({ state: 'queued', queuePosition: 2 }, 30_000), 'All devices are busy. You are number 2 in the queue (30 s so far).');
  assert.equal(waitLine({ state: 'queued', queuePosition: null }, 150_000), 'All devices are busy. Waiting for one (3 min so far).');
  assert.equal(waitLine({ state: 'preparing', queuePosition: null }, 60_000), 'Preparing the device (60 s so far).');
});

test('a lease that timed out in the queue says why and what to do', () => {
  assert.equal(leaseEndMessage('queue_timeout'), 'All devices were busy for 10 minutes. Try again, or ask an operator to add devices.');
  assert.equal(leaseEndMessage('released'), 'The lease ended before it started (released).');
});

test('lease prints a wait line each time the server answers while queued, and none without a log', async () => {
  let polls = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    const state = req.method === 'POST' ? 'queued' : ++polls < 2 ? 'queued' : 'active';
    res.end(JSON.stringify({ id: 'l1', state, reason: null, device: null, queuePosition: state === 'queued' ? 1 : null, expiresAt: null }));
  });
  try {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const client = new Devicepool({ url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, token: 't' });
    const lines: string[] = [];
    const lease = await client.lease({}, { autoRenew: false, log: (line) => lines.push(line) });
    assert.equal(lease.id, 'l1');
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? '', /^All devices are busy\. You are number 1 in the queue \(\d+ s so far\)\.$/);
    polls = 0;
    await client.lease({}, { autoRenew: false });
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
