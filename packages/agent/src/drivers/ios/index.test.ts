import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sim from './index.ts';

test('toNodes normalizes frames against the application frame', () => {
  const { screen, nodes } = sim.toNodes([
    { type: 'Application', role: 'AXApplication', AXLabel: 'Settings', AXValue: null, AXUniqueId: null, enabled: true, frame: { x: 0, y: 0, width: 400, height: 800 } },
    { type: 'Button', role: 'AXButton', AXLabel: 'Sign in', AXValue: null, AXUniqueId: 'signin', enabled: true, frame: { x: 100, y: 200, width: 200, height: 40 } },
  ]);
  assert.deepEqual(screen, { x: 0, y: 0, width: 400, height: 800 });
  assert.deepEqual(nodes[1], {
    role: 'button',
    label: 'Sign in',
    value: null,
    identifier: 'signin',
    enabled: true,
    frame: { x: 100, y: 200, width: 200, height: 40 },
    normalized: { x: 0.25, y: 0.25, width: 0.5, height: 0.05 },
  });
});

test('real simulator: golden, clone, boot, drive, delete', { skip: !process.env.HANGAR_REAL && 'set HANGAR_REAL=1', timeout: 300_000 }, async () => {
  const rt = (await sim.runtimes()).at(-1);
  assert.ok(rt, 'no iOS runtime installed');
  const type = (await sim.deviceTypes()).find((d) => d.name === 'iPhone 17') ?? (await sim.deviceTypes())[0];
  assert.ok(type);
  const golden = await sim.create(`${sim.NAME_PREFIX}test-golden`, type.identifier, rt.identifier);
  let udid: string | null = null;
  try {
    await sim.prepareGolden(golden);
    udid = await sim.clone(golden, `${sim.NAME_PREFIX}test`);
    await sim.boot(udid);
    const png = await sim.screenshot(udid, 'png');
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    await sim.launch(udid, 'com.apple.Preferences');
    let nodes = (await sim.describe(udid)).nodes;
    for (let i = 0; i < 10 && nodes.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 500));
      nodes = (await sim.describe(udid)).nodes;
    }
    assert.ok(nodes.length > 3, `expected a real tree, got ${nodes.length} nodes`);
    assert.ok(nodes.some((n) => n.label === 'Settings'), 'the golden device should be in English');
    const info = await sim.info(udid, type.name, rt.version);
    assert.ok(info.screen.scale >= 2);
    await sim.button(udid, 'home');
  } finally {
    if (udid) {
      await sim.remove(udid);
    }
    await sim.remove(golden);
  }
});
