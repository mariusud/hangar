import { captureOf } from '@hangar/protocol';
import { json, route } from './util.ts';

route('GET', '/v1/devices', (_req, res, ctx) => {
  const held = new Map(ctx.db.leasesIn(['preparing', 'active']).map((l) => [l.deviceId, l]));
  json(
    res,
    200,
    ctx.hosts.devices().map((d) => ({
      platform: d.platform ?? 'ios-simulator',
      model: d.model,
      os: d.os,
      image: d.image ?? null,
      host: d.hostName,
      state: !d.connected ? 'offline' : held.has(d.deviceId) ? 'leased' : d.state,
      capture: captureOf(d),
    })),
  );
});
