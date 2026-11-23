import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROTOCOL_VERSION, type AgentDevice, type BrokerMessage } from '@devicepool/protocol';
import { startBroker, type Broker } from '@devicepool/broker';
import * as auth from '../packages/broker/src/auth.ts';
import { OpError } from '../packages/agent/src/index.ts';
import { xcuitest } from '../packages/agent/src/xcuitest.ts';

const run = promisify(execFile);
const isReal = Boolean(process.env.DEVICEPOOL_REAL);
const root = new URL('..', import.meta.url).pathname;
const fixture = join(root, 'e2e/fixtures/xcuitest');
const simName = process.env.DEVICEPOOL_E2E_SIMULATOR ?? 'xcuitest-e2e';

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

async function devicepool(url: string, token: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const env = { ...process.env, DEVICEPOOL_URL: url, DEVICEPOOL_TOKEN: token };
  return run('node', ['--disable-warning=ExperimentalWarning', join(root, 'packages/devicepool/src/main.ts'), ...args], { env, maxBuffer: 16 * 1024 * 1024 }).then(
    (r) => ({ code: 0, stderr: r.stderr }),
    (err: { code?: number; stderr?: string }) => ({ code: err.code ?? 1, stderr: err.stderr ?? '' }),
  );
}

test('devicepool run xcuitest runs a real UI test target on a simulator, with JUnit for a pass and a failure', { skip: !isReal && 'set DEVICEPOOL_REAL=1', timeout: 900_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'devicepool-e2e-xcuitest-'));
  let udid: string | null = null;
  let broker: Broker | null = null;
  try {
    await run('xcodebuild', ['build-for-testing', '-project', join(fixture, 'DevicepoolFixture.xcodeproj'), '-scheme', 'DevicepoolFixture', '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', join(dir, 'dd')], { maxBuffer: 64 * 1024 * 1024 });
    const products = join(dir, 'dd/Build/Products');

    udid = (await run('xcrun', ['simctl', 'create', simName, 'iPhone 17'])).stdout.trim();
    await run('xcrun', ['simctl', 'boot', udid]);
    await run('xcrun', ['simctl', 'bootstatus', udid, '-b']);

    broker = await startBroker({ dataDir: join(dir, 'data'), port: 0, host: '127.0.0.1' });
    xcuitestHost(broker, udid);
    const account = auth.createAccount(broker.db, 'ci', 'member');
    const token = auth.mintToken(broker.db, 'member', { accountId: account.id, scopes: ['install:upload'] });

    const pass = await devicepool(broker.url, token, ['run', 'xcuitest', products, '--tests', 'DevicepoolFixtureUITests/CounterTests', '--retries', '0', '--junit', join(dir, 'pass.xml')]);
    assert.equal(pass.code, 0, pass.stderr);
    const passXml = await readFile(join(dir, 'pass.xml'), 'utf8');
    assert.match(passXml, /<testsuite name="xcuitest" tests="1" failures="0"/);
    assert.match(passXml, /<testcase classname="xcuitest" name="DevicepoolFixtureUITests\/CounterTests"><properties>[^]*?<\/properties><\/testcase>/);

    // No --tests: the targets come from the .xctestrun, and the whole target fails on BrokenTests.
    const fail = await devicepool(broker.url, token, ['run', 'xcuitest', products, '--retries', '0', '--junit', join(dir, 'fail.xml')]);
    assert.equal(fail.code, 1, fail.stderr);
    const failXml = await readFile(join(dir, 'fail.xml'), 'utf8');
    assert.match(failXml, /<testcase classname="xcuitest" name="DevicepoolFixtureUITests">/);
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
