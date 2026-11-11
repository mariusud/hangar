import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ApiError } from '../leases/service.ts';
import type { Ctx } from './util.ts';

const MAX_UPLOAD = 4 * 1024 * 1024 * 1024;

export async function saveUpload(req: IncomingMessage, ctx: Ctx, name: string): Promise<{ sha256: string; name: string; size: number }> {
  const dir = join(ctx.dataDir, 'builds');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.upload-${process.pid}-${Date.now()}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += (chunk as Buffer).length;
          if (size > MAX_UPLOAD) {
            throw new ApiError(413, 'BODY_TOO_LARGE', 'Builds are limited to 4 GB.');
          }
          hash.update(chunk as Buffer);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (size === 0) {
    await rm(tmp, { force: true });
    throw new ApiError(400, 'EMPTY_UPLOAD', 'The upload was empty. Send a zipped or tarred .app as the request body.');
  }
  const sha256 = hash.digest('hex');
  const path = join(dir, sha256);
  await rename(tmp, path);
  await ctx.store.saved(`builds/${sha256}`);
  ctx.db.insertBuild(sha256, name, path, size);
  return { sha256, name, size };
}
