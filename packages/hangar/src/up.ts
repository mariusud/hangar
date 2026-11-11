import { execFile, spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Agent, AndroidAgent, join as joinFleet } from '@hangar/agent';
import { Db, mintHostToken, oidcFromEnv, s3FromEnv, startBroker, type OidcConfig, type S3Config } from '@hangar/broker';
import type { AgentMessage, BrokerMessage } from '@hangar/protocol';
import { CONFIG_FILE } from './client/index.ts';
import { doctor, printChecks, smokeCheck } from './doctor.ts';

const run = promisify(execFile);

export const DEFAULT_PORT = 7420;

export function dataDir(): string {
  return process.env.HANGAR_HOME ?? join(homedir(), '.hangar');
}

export { doctor, printChecks, type Check } from './doctor.ts';

async function lanName(): Promise<string> {
  try {
    return `${(await run('scutil', ['--get', 'LocalHostName'])).stdout.trim()}.local`;
  } catch {
    return 'localhost';
  }
}

function fromEnv(): { oidc?: OidcConfig; s3?: S3Config } {
  const oidc = oidcFromEnv();
  const s3 = s3FromEnv();
  if (oidc) {
    console.log(`Sign-in through ${oidc.issuer}${oidc.disablePasswords ? ' only' : ''}.`);
  }
  if (s3) {
    console.log(`Builds and recordings are kept in the bucket ${s3.bucket} at ${s3.endpoint}.`);
  }
  return { ...(oidc ? { oidc } : {}), ...(s3 ? { s3 } : {}) };
}

export async function up(opts: { port?: number; warm?: number; max?: number; url?: string; android?: string }): Promise<void> {
  console.log('Checking this Mac...');
  const checks = await doctor({ smoke: false });
  printChecks(checks);
  if (checks.some((c) => !c.ok)) {
    console.log('\nFix the items marked NO, then run `npx hangar up` again.');
    process.exitCode = 1;
    return;
  }

  const port = opts.port ?? DEFAULT_PORT;
  const publicUrl = opts.url?.replace(/\/$/, '') ?? `http://${await lanName()}:${port}`;
  const broker = await startBroker({ dataDir: dataDir(), port, publicUrl, ...fromEnv() }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\nPort ${port} is in use. Is Hangar already running? Try \`hangar status\`, or pass --port.`);
      process.exit(1);
    }
    throw err;
  });

  const smoke = await smokeCheck();
  let agent: Agent | null = null;
  if (smoke.ok) {
    let toAgent: (m: BrokerMessage) => void = () => {};
    const handlers = broker.attach({ send: (m) => setImmediate(() => toAgent(m)), close: () => {} });
    const ios = new Agent({
      send: (m: AgentMessage) => setImmediate(() => handlers.message(m)),
      brokerUrl: `http://127.0.0.1:${port}`,
      log: (line) => console.log(`  ${line}`),
      ...(opts.warm !== undefined ? { warm: opts.warm } : {}),
      ...(opts.max !== undefined ? { maxDevices: opts.max } : {}),
    });
    toAgent = (m) => ios.receive(m);
    agent = ios;
    console.log(`\nStarting devices (up to ${ios.maxDevices}, ${ios.warm} kept ready)...`);
    await ios.start();
  } else {
    console.log(`\nNo simulators on this Mac: ${smoke.detail}.\n  fix: ${smoke.fix ?? ''}`);
  }

  let androidAgent: AndroidAgent | null = null;
  if (opts.android) {
    let toAndroid: (m: BrokerMessage) => void = () => {};
    const link = broker.attach({ send: (m) => setImmediate(() => toAndroid(m)), close: () => {} });
    androidAgent = new AndroidAgent({ send: (m) => setImmediate(() => link.message(m)), brokerUrl: `http://127.0.0.1:${port}`, avd: opts.android, log: (line) => console.log(`  ${line}`) });
    toAndroid = (m) => androidAgent?.receive(m);
    console.log(`Starting Android emulators from ${opts.android}...`);
    await androidAgent.start();
  }

  const bonjour = spawn('dns-sd', ['-R', 'Hangar', '_hangar._tcp', 'local', String(port)], { stdio: 'ignore' });

  const signedIn = await access(CONFIG_FILE).then(() => false, async () => {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify({ url: publicUrl, token: broker.adminToken(`hangar up on ${hostname()}`) }, null, 2), { mode: 0o600 });
    return true;
  });

  console.log(`
Hangar is running at ${publicUrl}

  Sign in as admin:   ${broker.welcomeLink()}   (one use, 30 min)
  Connect an agent:   hangar connect claude   (or cursor)
  Connect CI:         hangar connect ci
${signedIn ? '\n  The hangar commands on this Mac are signed in as admin.\n' : ''}
${publicUrl.startsWith('https:') ? '' : '  Traffic is plain HTTP on your network. Set up TLS before using Hangar beyond a trusted LAN.\n'}
  Press Ctrl-C to stop. Leased devices are deleted when Hangar stops.
`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log('\nStopping: deleting devices...');
    bonjour.kill();
    await androidAgent?.stop();
    await agent?.stop();
    await broker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

export async function brokerOnly(opts: { port?: number; url?: string; host?: string }): Promise<void> {
  const port = opts.port ?? DEFAULT_PORT;
  const broker = await startBroker({ dataDir: dataDir(), port, ...fromEnv(), ...(opts.host ? { host: opts.host } : {}), ...(opts.url ? { publicUrl: opts.url.replace(/\/$/, '') } : {}) });
  console.log(`Hangar broker is running at ${broker.url}

  Sign in as admin:   ${broker.welcomeLink()}   (one use, 30 min)
  Add a Mac:          hangar join ${broker.url} --token ${broker.joinToken()}
`);
  const stop = async (): Promise<void> => {
    await broker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

export function joinToken(): string {
  const db = new Db(join(dataDir(), 'hangar.db'));
  try {
    return mintHostToken(db);
  } finally {
    db.sql.close();
  }
}

export async function joinBroker(opts: { url: string; token: string; warm?: number; max?: number; android?: string }): Promise<void> {
  console.log('Checking this Mac...');
  const checks = await doctor();
  printChecks(checks);
  if (checks.some((c) => !c.ok)) {
    console.log('\nFix the items marked NO, then run `hangar join` again.');
    process.exitCode = 1;
    return;
  }
  const log = (line: string): void => console.log(`  ${line}`);
  const fail = (err: Error): never => {
    console.log(`\n${err.message}`);
    process.exit(1);
  };
  const ios = await joinFleet({
    url: opts.url,
    token: opts.token,
    log,
    make: (send, brokerUrl) => new Agent({ send, brokerUrl, log, ...(opts.warm !== undefined ? { warm: opts.warm } : {}), ...(opts.max !== undefined ? { maxDevices: opts.max } : {}) }),
  }).catch(fail);
  const avd = opts.android;
  const droid = avd ? await joinFleet({ url: opts.url, token: opts.token, log, make: (send, brokerUrl) => new AndroidAgent({ send, brokerUrl, avd, log }) }).catch(fail) : null;
  console.log(`\nThis Mac offers up to ${ios.agent.maxDevices} simulators${droid ? ` and ${droid.agent.maxDevices} Android emulators` : ''} to ${opts.url}. Press Ctrl-C to stop; leased devices are deleted.`);
  const stop = async (): Promise<void> => {
    console.log('\nStopping: deleting devices...');
    await droid?.stop();
    await ios.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
