import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Devicepool, DevicepoolError } from './index.ts';
import { buildRef } from './maestro.ts';

test('a refused folder upload fails with the server’s error instead of hanging', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-buildref-test-'));
  const server = createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UPLOAD_NOT_ALLOWED', message: 'Uploading a build needs the install:upload permission.' } }));
  });
  try {
    await mkdir(join(dir, 'Products'));
    await writeFile(join(dir, 'Products', 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 1));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const devicepool = new Devicepool({ url: `http://127.0.0.1:${port}`, token: 't' });
    await assert.rejects(buildRef(devicepool, join(dir, 'Products')), (err) => err instanceof DevicepoolError && err.code === 'UPLOAD_NOT_ALLOWED');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a build is uploaded under the name given, not its folder name', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-buildname-test-'));
  const urls: string[] = [];
  const server = createServer((req, res) => {
    urls.push(req.url ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha256: 'abc' }));
    });
  });
  try {
    await mkdir(join(dir, 'MyApp.app'));
    await writeFile(join(dir, 'MyApp.app', 'Info.plist'), 'x');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const devicepool = new Devicepool({ url: `http://127.0.0.1:${port}`, token: 't' });
    assert.equal(await buildRef(devicepool, join(dir, 'MyApp.app'), 'pr-42'), 'abc');
    assert.equal(await buildRef(devicepool, join(dir, 'MyApp.app')), 'abc');
    assert.deepEqual(urls, ['/v1/builds?name=pr-42', '/v1/builds?name=MyApp.app']);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mistyped path is reported as a missing file, not sent as a build name', async () => {
  const devicepool = new Devicepool({ url: 'http://127.0.0.1:1', token: 't' });
  await assert.rejects(buildRef(devicepool, './build/MyApp.app'), (err) => err instanceof DevicepoolError && err.code === 'NO_SUCH_FILE' && /^No such file: \.\/build\/MyApp\.app/.test(err.message));
  await assert.rejects(buildRef(devicepool, 'MyApp.apk'), /No such file: MyApp\.apk/);
});
