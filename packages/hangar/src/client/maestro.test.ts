import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hangar, HangarError } from './index.ts';
import { buildRef } from './maestro.ts';

test('a refused folder upload fails with the server’s error instead of hanging', { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-buildref-test-'));
  // Like the broker without install:upload: it answers before it reads the body.
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
    const hangar = new Hangar({ url: `http://127.0.0.1:${port}`, token: 't' });
    await assert.rejects(buildRef(hangar, join(dir, 'Products')), (err) => err instanceof HangarError && err.code === 'UPLOAD_NOT_ALLOWED');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
