// Device images (milestone 4): a declared state each host builds once and keeps clones of warm.
// The broker stores only the declaration; the builds it names are already in the build store.

import { createHash } from 'node:crypto';
import type { BrokerMessage, DeviceImage } from '@hangar/protocol';
import * as auth from './auth.ts';
import type { Db, ImageSpec } from './db.ts';

export function imageId(spec: ImageSpec): string {
  const canonical = JSON.stringify([spec.name.toLowerCase(), spec.apps, spec.locale ?? null, spec.appearance ?? null]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

// Download links are minted per message: each is good for one download within an hour, which
// covers a host building every image right after it connects.
export function imagesMessage(db: Db, internalUrl: string): BrokerMessage {
  const images: DeviceImage[] = db.images().map((spec) => {
    const image: DeviceImage = {
      id: imageId(spec),
      name: spec.name,
      apps: spec.apps.map((sha256) => ({ sha256, url: `${internalUrl}/v1/artifacts/${sha256}?t=${auth.mintToken(db, 'artifact', { expiresAt: Date.now() + 60 * 60_000 })}` })),
    };
    if (spec.locale) {
      image.locale = spec.locale;
    }
    if (spec.appearance) {
      image.appearance = spec.appearance;
    }
    return image;
  });
  return { type: 'images', images };
}
