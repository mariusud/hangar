// Where builds and recordings live. Files are always written to the data folder first. With an
// S3-compatible bucket set (AWS S3, MinIO, R2, Ceph), a finished file is uploaded and the local
// copy removed, so the broker's disk only holds what is in flight. Reads go through the broker
// either way, so agents and browsers never need bucket credentials.

import { createHash, createHmac } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

export type S3Config = { endpoint: string; bucket: string; region: string; accessKey: string; secretKey: string };

// HANGAR_S3_ENDPOINT (such as https://s3.eu-north-1.amazonaws.com or http://minio:9000),
// HANGAR_S3_BUCKET, HANGAR_S3_ACCESS_KEY, HANGAR_S3_SECRET_KEY and HANGAR_S3_REGION.
export function s3FromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | undefined {
  if (!env.HANGAR_S3_BUCKET) {
    return undefined;
  }
  const missing = ['HANGAR_S3_ENDPOINT', 'HANGAR_S3_ACCESS_KEY', 'HANGAR_S3_SECRET_KEY'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`HANGAR_S3_BUCKET is set, so ${missing.join(', ')} must be too.`);
  }
  return {
    endpoint: env.HANGAR_S3_ENDPOINT!.replace(/\/$/, ''),
    bucket: env.HANGAR_S3_BUCKET,
    region: env.HANGAR_S3_REGION ?? 'us-east-1',
    accessKey: env.HANGAR_S3_ACCESS_KEY!,
    secretKey: env.HANGAR_S3_SECRET_KEY!,
  };
}

const hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const encodeKey = (key: string): string => key.split('/').map((p) => encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// AWS Signature Version 4 for one request. Returns the headers to send, Authorization included.
export function signV4(opts: { method: string; url: URL; headers: Record<string, string>; payloadHash: string; region: string; accessKey: string; secretKey: string; now?: Date }): Record<string, string> {
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...opts.headers, host: opts.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': opts.payloadHash };
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const query = [...opts.url.searchParams].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [opts.method, opts.url.pathname, query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), opts.payloadHash].join('\n');
  const scope = `${day}/${opts.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${opts.secretKey}`, day), opts.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export type Opened = { stream: Readable; size: number; start: number; end: number };

export class Store {
  private dataDir: string;
  private s3: S3Config | null;

  constructor(dataDir: string, s3?: S3Config) {
    this.dataDir = dataDir;
    this.s3 = s3 ?? null;
  }

  // Where to write a file under `key` (such as builds/<sha> or recordings/<id>/video.mp4).
  local(key: string): string {
    return join(this.dataDir, key);
  }

  // Call once the file at local(key) is complete.
  async saved(key: string): Promise<void> {
    if (!this.s3) {
      return;
    }
    const path = this.local(key);
    const { size } = await stat(path);
    const res = await this.request('PUT', key, { 'content-length': String(size) }, Readable.toWeb(createReadStream(path)) as ReadableStream);
    if (!res.ok) {
      throw new Error(`The bucket refused ${key} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    await rm(path, { force: true });
  }

  async size(key: string): Promise<number | null> {
    const local = await stat(this.local(key)).then((s) => s.size, () => null);
    if (local !== null || !this.s3) {
      return local;
    }
    const head = await this.request('HEAD', key);
    return head.ok ? Number(head.headers.get('content-length') ?? 0) : null;
  }

  // The file, or a byte range of it, from disk if it is still there, else from the bucket.
  async open(key: string, range?: { start?: number; end?: number }): Promise<Opened | null> {
    const path = this.local(key);
    const size = await stat(path).then((s) => s.size, () => null);
    if (size !== null) {
      const { start, end } = clamp(range, size);
      return { stream: createReadStream(path, { start, end }), size, start, end };
    }
    if (!this.s3) {
      return null;
    }
    const total = await this.size(key);
    if (total === null) {
      return null;
    }
    const { start, end } = clamp(range, total);
    const res = await this.request('GET', key, range ? { range: `bytes=${start}-${end}` } : {});
    if (!res.ok || !res.body) {
      return null;
    }
    return { stream: Readable.fromWeb(res.body as WebReadableStream), size: total, start, end };
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.local(key), { recursive: true, force: true });
      if (this.s3) {
        await this.request('DELETE', key).catch(() => {});
      }
    }
  }

  private request(method: string, key: string, headers: Record<string, string> = {}, body?: ReadableStream): Promise<Response> {
    const s3 = this.s3!;
    // Path-style addressing, which MinIO and most S3-compatible stores need.
    const url = new URL(`${s3.endpoint}/${s3.bucket}/${encodeKey(key)}`);
    const signed = signV4({ method, url, headers, payloadHash: body ? 'UNSIGNED-PAYLOAD' : hex(''), region: s3.region, accessKey: s3.accessKey, secretKey: s3.secretKey });
    delete signed.host;
    const init: RequestInit & { duplex?: 'half' } = { method, headers: signed };
    if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    return fetch(url, init);
  }
}

function clamp(range: { start?: number; end?: number } | undefined, size: number): { start: number; end: number } {
  const start = Math.max(0, range?.start ?? 0);
  return { start, end: Math.min(range?.end ?? size - 1, size - 1) };
}
