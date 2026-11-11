import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@hangar/protocol';
import { startBroker, type Broker } from '@hangar/broker';
import * as auth from '../packages/broker/src/auth.ts';
import { OpError } from '../packages/agent/src/index.ts';
import { xcuitest } from '../packages/agent/src/xcuitest.ts';

const run = promisify(execFile);
const real = Boolean(process.env.HANGAR_REAL);
const root = new URL('..', import.meta.url).pathname;
const fixture = join(root, 'e2e/fixtures/xcuitest');
// The simulator this test makes and deletes. It is not named like the agent's own devices.
const simName = process.env.HANGAR_E2E_SIMULATOR ?? 'xcuitest-e2e';

// A host with one simulator that runs XCUITest ops with the agent's own xcuitest code. It does not record, and
// it does not wipe the simulator between leases: it only reports it under a new id, as the broker leases a
// device again only after a wipe.
function xcuitestHost(broker: Broker, udid: string): void {
  let n = 1;
  let device: AgentDevice = { deviceId: `sim-${n}`, model: 'iPhone 17', os: '26.5', state: 'ready', platform: 'ios-simulator' };
  const handlers = broker.attach({
    send: (m: BrokerMessage) => {
      queueMicrotask(async () => {
        if (m.type === 'lease.prepare') {
          handlers.message({ type: 'inventory', devices: [{ ...device, state: 'busy' }] });
          handlers.message({ type: 'response', id: m.id, ok: true });
        } else if (m.type === 'op' && m.body.op === 'xcuitest') {
          const { artifactUrl, sha256, tests } = m.body;
          try {
            const result = await xcuitest(udid, new URL(artifactUrl, broker.url).toString(), sha256, tests);
            handlers.message({ type: 'response', id: m.id, ok: true, result });
          } catch (err) {
            const code = err instanceof OpError ? err.code : 'XCUITEST_FAILED';
            handlers.message({ type: 'response', id: m.id, ok: false, error: { code, message: err instanceof Error ? err.message : String(err) } });
          }
        } else if (m.type === 'op') {
          handlers.message({ type: 'response', id: m.id, ok: false, error: { code: 'UNSUPPORTED', message: `This test host does not do ${m.body.op}.` } });
        } else if (m.type === 'lease.end') {
          n += 1;
          device = { ...device, deviceId: `sim-${n}` };
          handlers.message({ type: 'inventory', devices: [device] });
        }
      });
    },
    close: () => {},
  });
  handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'xcuitest-e2e', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5', platform: 'ios-simulator' }], devices: [device], leases: [] });
}

async function hangar(url: string, token: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env, HANGAR_URL: url, HANGAR_TOKEN: token };
  return run('node', ['--disable-warning=ExperimentalWarning', join(root, 'packages/hangar/src/main.ts'), ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then(
    (r) => ({ code: 0, stderr: r.stderr }),
    (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? '' }),
  );
}

test('hangar run xcuitest runs a real UI test target on a simulator, with JUnit for a pass and a failure', { skip: !real && 'set HANGAR_REAL=1', timeout: 900_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-e2e-xcuitest-'));
  let udid: string | null = null;
  let broker: Broker | null = null;
  try {
    await run('xcodebuild', ['build-for-testing', '-project', join(fixture, 'HangarFixture.xcodeproj'), '-scheme', 'HangarFixture', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', join(dir, 'dd')], { maxBuffer: 64 * 1024 * 1024 });
    const products = join(dir, 'dd/Build/Products');

    udid = (await run('xcrun', ['simctl', 'create', simName, 'iPhone 17'])).stdout.trim();
    await run('xcrun', ['simctl', 'boot', udid]);
    await run('xcrun', ['simctl', 'bootstatus', udid, '-b']);

    broker = await startBroker({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
    xcuitestHost(broker, udid);
    const account = auth.createAccount(broker.db, 'ci', 'member');
    const token = auth.mintToken(broker.db, 'member', { accountId: account.id, scopes: ['install:upload'] });

    const pass = await hangar(broker.url, token, ['run', 'xcuitest', products, '--tests', 'HangarFixtureUITests/CounterTests', '--retries', '0', '--junit', join(dir, 'pass.xml')]);
    assert.equal(pass.code, 0, pass.stderr);
    const passXml = await readFile(join(dir, 'pass.xml'), 'utf8');
    assert.match(passXml, /<testsuite name="xcuitest" tests="1" failures="0"/);
    assert.match(passXml, /<testcase classname="xcuitest" name="HangarFixtureUITests\/CounterTests"><properties>[^]*?<\/properties><\/testcase>/);

    // No --tests: the targets come from the .xctestrun, and the whole target fails on BrokenTests.
    const fail = await hangar(broker.url, token, ['run', 'xcuitest', products, '--retries', '0', '--junit', join(dir, 'fail.xml')]);
    assert.equal(fail.code, 1, fail.stderr);
    const failXml = await readFile(join(dir, 'fail.xml'), 'utf8');
    assert.match(failXml, /<testcase classname="xcuitest" name="HangarFixtureUITests">/);
    assert.match(failXml, /<failure message="BrokenTests\.testMissingButton: [^"]*The missing button is not there/);
    assert.doesNotMatch(failXml, /CounterTests\.testAddOne/, 'the passing test is not in the failure');
  } finally {
    await broker?.close();
    if (udid) {
      await run('xcrun', ['simctl', 'shutdown', udid]).catch(() => {});
      await run('xcrun', ['simctl', 'delete', udid]).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }
});
