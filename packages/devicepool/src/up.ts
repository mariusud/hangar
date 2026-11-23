import { execFile, spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Agent, AndroidAgent, join as joinFleet } from '@devicepool/agent';
import { Db, mintHostToken, oidcFromEnv, s3FromEnv, startBroker, type OidcConfig, type S3Config } from '@devicepool/broker';
import type { AgentMessage, BrokerMessage } from '@devicepool/protocol';
import { CONFIG_FILE } from './client/index.ts';
import { doctor, printChecks, smokeCheck } from './doctor.ts';

const run = promisify(execFile);

export const DEFAULT_PORT = 7420;

export function dataDir(): string {
  return process.env.DEVICEPOOL_HOME ?? join(homedir(), '.devicepool');
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

export async function up(opts: { port?: number; warm?: number; max?: number; url?: string; android?: string; phones?: boolean }): Promise<void> {
  console.log('Checking this Mac...');
  const checks = await doctor({ smoke: false });
  printChecks(checks);
  if (checks.some((c) => !c.ok)) {
    console.log('\nFix the items marked NO, then run `npx devicepool up` again.');
    process.exitCode = 1;
    return;
  }

  const port = opts.port ?? DEFAULT_PORT;
  const publicUrl = opts.url?.replace(/\/$/, '') ?? `http://${await lanName()}:${port}`;
  const broker = await startBroker({ dataDir: dataDir(), port, publicUrl, ...fromEnv() }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`\nPort ${port} is in use. Is Devicepool already running? Try \`devicepool status\`, or pass --port.`);
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
  if (opts.android || opts.phones) {
    let toAndroid: (m: BrokerMessage) => void = () => {};
    const link = broker.attach({ send: (m) => setImmediate(() => toAndroid(m)), close: () => {} });
    androidAgent = new AndroidAgent({ send: (m) => setImmediate(() => link.message(m)), brokerUrl: `http://127.0.0.1:${port}`, ...(opts.android ? { avd: opts.android } : {}), ...(opts.phones ? { phones: true } : {}), log: (line) => console.log(`  ${line}`) });
    toAndroid = (m) => androidAgent?.receive(m);
    console.log(opts.android ? `Starting Android emulators from ${opts.android}...` : 'Looking for Android phones on USB...');
    await androidAgent.start();
  }

  const bonjour = spawn('dns-sd', ['-R', 'Devicepool', '_devicepool._tcp', 'local', String(port)], { stdio: 'ignore' });

  const hasSignedInCommands = await access(CONFIG_FILE).then(() => false, async () => {
    await mkdir(dirname(CONFIG_FILE), { recursive: true });
    await writeFile(CONFIG_FILE, JSON.stringify({ url: publicUrl, token: broker.adminToken(`devicepool up on ${hostname()}`) }, null, 2), { mode: 0o600 });
    return true;
  });

  console.log(`
Devicepool is running at ${publicUrl}

  Sign in as admin:   ${broker.welcomeLink()}   (one use, 30 min)
  Connect an agent:   devicepool connect claude   (or cursor)
  Connect CI:         devicepool connect ci
${hasSignedInCommands ? '\n  The devicepool commands on this Mac are signed in as admin.\n' : ''}
${publicUrl.startsWith('https:') ? '' : '  Traffic is plain HTTP on your network. Set up TLS before using Devicepool beyond a trusted LAN.\n'}
  Press Ctrl-C to stop. Leased devices are deleted when Devicepool stops.
`);

  let isStopping = false;
  const stop = async (): Promise<void> => {
    if (isStopping) {
      return;
    }
    isStopping = true;
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
  console.log(`Devicepool broker is running at ${broker.url}

  Sign in as admin:   ${broker.welcomeLink()}   (one use, 30 min)
  Add a Mac:          devicepool join ${broker.url} --token ${broker.joinToken()}
`);
  const stop = async (): Promise<void> => {
    await broker.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

export function joinToken(): string {
  const db = new Db(join(dataDir(), 'devicepool.db'));
  try {
    return mintHostToken(db);
  } finally {
    db.sql.close();
  }
}

export async function joinBroker(opts: { url: string; token: string; warm?: number; max?: number; android?: string; phones?: boolean }): Promise<void> {
  console.log('Checking this Mac...');
  const checks = await doctor();
  printChecks(checks);
  if (checks.some((c) => !c.ok)) {
    console.log('\nFix the items marked NO, then run `devicepool join` again.');
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
  const droid = avd || opts.phones ? await joinFleet({ url: opts.url, token: opts.token, log, make: (send, brokerUrl) => new AndroidAgent({ send, brokerUrl, ...(avd ? { avd } : {}), ...(opts.phones ? { phones: true } : {}), log }) }).catch(fail) : null;
  console.log(`\nThis Mac offers up to ${ios.agent.maxDevices} simulators${droid && avd ? ` and ${droid.agent.maxDevices} Android emulators` : ''}${opts.phones ? ' and the Android phones on USB' : ''} to ${opts.url}. Press Ctrl-C to stop; leased devices are deleted.`);
  const stop = async (): Promise<void> => {
    console.log('\nStopping: deleting devices...');
    await droid?.stop();
    await ios.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
