// Milestone 1 done list, on real simulators on this Mac. Run with `pnpm e2e`.
// Set HANGAR_E2E_APP to a simulator .app to also check install and the wipe.

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

    // With one device, a second client queues instead of getting the same device.
    const bobLease = bob.lease({ model: 'iPhone 17' }, { autoRenew: false });
    await new Promise((r) => setTimeout(r, 1500));
    const bobs = await bob.leases();
    assert.equal(bobs[0]?.state, 'queued');

    const png = await lease.screenshot();
    assert.equal(png.subarray(1, 4).toString(), 'PNG');

    await lease.launch('com.apple.Preferences');
    await lease.waitFor({ label: 'General', role: 'button' }, 10_000);
    const ui = await lease.ui();
    assert.ok(ui.nodes.length > 5);
    await lease.tap({ label: 'General', role: 'button' });
    await lease.waitFor({ label: 'About' }, 5000);

    let bundleId: string | null = null;
    if (app) {
      bundleId = (await lease.install(app)).bundleId;
      assert.ok(await hasApp('hangar-', bundleId), 'the app is installed on the leased device');
    }

    step('releasing');
    await lease.release();
    step('released; waiting for bob');

    // Bob gets a fresh device once Alice's is wiped and replaced.
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
