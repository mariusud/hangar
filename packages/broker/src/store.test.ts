import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signV4 } from './store.ts';

test('SigV4 matches the AWS documentation example', () => {
  const headers = signV4({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
  );
});

test('with a bucket, a finished file moves there and is read back, ranges included', async () => {
  const { createServer } = await import('node:http');
  const { mkdtemp, mkdir, writeFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('./store.ts');
  const objects = new Map<string, Buffer>();
  const seen: string[] = [];
  const s3 = createServer(async (req, res) => {
    seen.push(`${req.method} ${req.url} ${/^AWS4-HMAC-SHA256 Credential=key\//.test(req.headers.authorization ?? '') ? 'signed' : 'unsigned'}`);
    const key = req.url ?? '';
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      objects.set(key, Buffer.concat(chunks));
      res.end();
      return;
    }
    const obj = objects.get(key);
    if (!obj) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
      return;
    }
    const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    const body = range ? obj.subarray(Number(range[1]), Number(range[2]) + 1) : obj;
    res.writeHead(range ? 206 : 200, { 'content-length': req.method === 'HEAD' ? obj.length : body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
  const address = s3.address();
  const dir = await mkdtemp(join(tmpdir(), 'hangar-store-'));
  try {
    const store = new Store(dir, { endpoint: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, bucket: 'hangar', region: 'eu-north-1', accessKey: 'key', secretKey: 'secret' });
    await mkdir(join(dir, 'recordings', 'r1'), { recursive: true });
    await writeFile(store.local('recordings/r1/video.mp4'), '0123456789');
    await store.saved('recordings/r1/video.mp4');
    assert.equal(await stat(store.local('recordings/r1/video.mp4')).catch(() => null), null, 'the local copy is removed');
    assert.equal(objects.get('/hangar/recordings/r1/video.mp4')?.toString(), '0123456789');

    assert.equal(await store.size('recordings/r1/video.mp4'), 10);
    const slice = await store.open('recordings/r1/video.mp4', { start: 2, end: 4 });
    const chunks: Buffer[] = [];
    for await (const c of slice!.stream) chunks.push(c as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), '234');

    await store.remove(['recordings/r1/video.mp4']);
    assert.equal(await store.open('recordings/r1/video.mp4'), null);
    assert.ok(seen.every((l) => l.endsWith('signed') && !l.endsWith('unsigned')));
  } finally {
    s3.close();
    await rm(dir, { recursive: true, force: true });
  }
});
