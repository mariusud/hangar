import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start } from './harness.ts';

const run = promisify(execFile);
const real = Boolean(process.env.HANGAR_REAL);
const app = process.env.HANGAR_E2E_APP;

async function hasApp(udidPrefix: string, bundleId: string): Promise<boolean> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '-j']);
  const devices = Object.values((JSON.parse(stdout) as { devices: Record<string, { udid: string; name: string; state: string }[]> }).devices).flat();
  for (const d of devices.filter((x) => x.name.startsWith(udidPrefix) && x.state === 'Booted' && !x.name.includes('golden'))) {
    const found = await run('xcrun', ['simctl', 'get_app_container', d.udid, bundleId]).then(() => true, () => false);
    if (found) {
      return true;
    }
  }
  return false;
}

test('lease, screenshot, tree, tap by label; a second client queues; release wipes', { skip: !real && 'set HANGAR_REAL=1', timeout: 600_000 }, async () => {
  const h = await start(1);
  try {
    const alice = h.client('alice').hangar;
    const bob = h.client('bob').hangar;

    const step = (s: string): void => console.error(`[e2e] ${s}`);
    step('leasing');
    const lease = await alice.lease({ model: 'iPhone 17' }, { autoRenew: false });
    step('leased');
    assert.equal(lease.info.state, 'active');

    const bobLease = bob.lease({ model: 'iPhone 17' }, { autoRenew: false });
    bobLease.catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    const bobs = await bob.leases();
    assert.equal(bobs[0]?.state, 'queued');

    step('screenshot');
    const png = await lease.screenshot();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    await lease.language('com.apple.Preferences', 'nb-NO');
    await lease.launch('com.apple.Preferences');
    await lease.waitFor({ label: 'Generelt', role: 'button' }, 10_000);
    const ui = await lease.ui();
    assert.ok(ui.nodes.length > 5);
    step('tap');
    await lease.tap({ label: 'Generelt', role: 'button' });
    await lease.waitFor({ label: 'Om' }, 5000);

    step('appearance');
    await lease.appearance('dark');
    await lease.appearance('light');
    step('location');
    await lease.location({ lat: 59.91, lon: 10.75 });
    await lease.location(null);
    step('permission');
    await lease.permission('com.apple.Maps', 'location', 'grant');
    step('push');
    await lease.push('com.apple.Preferences', { aps: { alert: 'Hangar e2e' } });
    step('presets work');

    let bundleId: string | null = null;
    if (app) {
      bundleId = (await lease.install(app)).bundleId;
      assert.ok(await hasApp('hangar-', bundleId), 'the app is installed on the leased device');
    }

    step('releasing');
    await lease.release();
    step('released; waiting for bob');

    const second = await bobLease;
    step('bob active');
    assert.equal(second.info.state, 'active');
    if (bundleId) {
      assert.equal(await hasApp('hangar-', bundleId), false, 'the released device was wiped');
    }
    await second.release();
  } finally {
    await h.stop();
  }
});
