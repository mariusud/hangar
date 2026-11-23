import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { Devicepool, DevicepoolError, openInBrowser, runEspresso, runMaestro, runXcuitest, type FlowResult, type Lease, type MaestroRun } from './client/index.ts';
import { parseDuration, rerunFlow } from './client/maestro.ts';

const run = promisify(execFile);
const children: ChildProcess[] = [];
let isStopped = false;

export const RUN_HELP = `  devicepool run ios [--app App.app | --build NAME] [--port 8081] [--port 4000]... [--scheme S] [--model M] [--lease ID]
                                           build, install and run your app on a leased
                                           simulator, connected to Metro on this machine;
                                           --build installs a build Devicepool already has,
                                           without Xcode; more --port forwards those ports
                                           too, as localhost:<port> on the device
  devicepool run android [--app app-debug.apk | --build NAME] [--port 8081]... [--lease ID]
                                           the same on a leased Android emulator
  devicepool run maestro <flows-dir> --app <App.app | build> [--shards N] [--retries 1]
                     [--junit report.xml] [-e KEY=VALUE]... [--hold 30m] [--booking B]
                                           run Maestro flows sharded over fresh devices;
                                           --hold keeps a failed flow's device as it was,
                                           for your team (devicepool held <run-id> <flow>);
                                           --booking leases the shards inside your team's
                                           open booking, ahead of its agents
  devicepool run maestro --rerun <run-id> --flow <flow> [-e KEY=VALUE]...
                                           run one flow of a finished run again, recorded
  devicepool run xcuitest <Build/Products> [--tests Target/Class,...] [--shards N] [--junit report.xml] [--booking B]
                                           run XCUITest from build-for-testing the same way
  devicepool run espresso --app app.apk --test-apk app-test.apk [--tests com.example.LoginTest,...] [--booking B]
                                           run Espresso on Android emulators the same way`;

export async function runMaestroCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      app: { type: 'string' },
      shards: { type: 'string' },
      retries: { type: 'string' },
      junit: { type: 'string' },
      model: { type: 'string' },
      env: { type: 'string', short: 'e', multiple: true },
      rerun: { type: 'string' },
      flow: { type: 'string' },
      hold: { type: 'string' },
      booking: { type: 'string' },
    },
  });
  const holdSeconds = values.hold === undefined ? undefined : parseDuration(values.hold);
  if (holdSeconds === null) {
    throw new DevicepoolError(0, 'USAGE', '--hold takes a duration such as 30m or 2h: how long to keep a failed flow\'s device as it was.');
  }
  const env = Object.fromEntries((values.env ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  if (values.rerun || values.flow) {
    if (!values.rerun || !values.flow) {
      throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool run maestro --rerun <run-id> --flow <flow>. The run id is in the run link.');
    }
    const result = await rerunFlow(await Devicepool.fromEnv(), values.rerun, values.flow, { ...(values.env ? { env } : {}), log: logLine });
    await report(result, values.junit, suiteName(result.kind));
    return;
  }
  const flowsDir = positionals[0];
  if (!flowsDir || !values.app) {
    throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool run maestro <flows-dir> --app <App.app | build> [--shards N]');
  }
  const result = await runMaestro(await Devicepool.fromEnv(), {
    app: values.app,
    flowsDir,
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    env,
    ...(values.model ? { device: { model: values.model } } : {}),
    ...(holdSeconds ? { holdSeconds } : {}),
    ...(values.booking ? { booking: values.booking } : {}),
    log: logLine,
  });
  await report(result, values.junit, 'Maestro');
}

export async function runXcuitestCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, model: { type: 'string' }, booking: { type: 'string' } },
  });
  const products = positionals[0];
  if (!products) {
    throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool run xcuitest <Build/Products folder> [--tests Target/Class,...] [--shards N]');
  }
  const result = await runXcuitest(await Devicepool.fromEnv(), {
    products,
    ...(values.tests ? { tests: splitList(values.tests) } : {}),
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    ...(values.model ? { device: { model: values.model } } : {}),
    ...(values.booking ? { booking: values.booking } : {}),
    log: logLine,
  });
  await report(result, values.junit, 'XCUITest');
}

export async function runEspressoCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { app: { type: 'string' }, 'test-apk': { type: 'string' }, tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, booking: { type: 'string' } },
  });
  const testApp = values['test-apk'];
  if (!values.app || !testApp) {
    throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool run espresso --app app.apk --test-apk app-test.apk [--tests com.example.LoginTest,...] [--shards N]');
  }
  const result = await runEspresso(await Devicepool.fromEnv(), {
    app: values.app,
    testApp,
    ...(values.tests ? { tests: splitList(values.tests) } : {}),
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    ...(values.booking ? { booking: values.booking } : {}),
    log: logLine,
  });
  await report(result, values.junit, 'Espresso');
}

function logLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

function splitList(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

function suiteName(kind: MaestroRun['kind']): string {
  return { maestro: 'Maestro', xcuitest: 'XCUITest', espresso: 'Espresso' }[kind ?? 'maestro'];
}

function counts(flows: FlowResult[]): Record<'passed' | 'flaky' | 'failed', number> {
  const out = { passed: 0, flaky: 0, failed: 0 };
  for (const f of flows) {
    if (f.status === 'passed' || f.status === 'flaky' || f.status === 'failed') {
      out[f.status] += 1;
    }
  }
  return out;
}

function recordingLinks(f: FlowResult): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  if (f.firstRecording) {
    links.push({ label: f.status === 'flaky' ? 'failed attempt' : 'first attempt', url: f.firstRecording });
  }
  if (f.recording && f.recording !== f.firstRecording) {
    links.push({ label: f.status === 'flaky' ? 'passing attempt' : 'last attempt', url: f.recording });
  }
  return links;
}

const CELL_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '|': '\\|', '`': "'" };
const cell = (s: string): string => s.replace(/[\r\n]+/g, ' ').replace(/[<>&|`]/g, (c) => CELL_ESCAPES[c] ?? c).slice(0, 300);

export function commentKey(env: NodeJS.ProcessEnv): string {
  return createHash('sha256').update(`${env.GITHUB_WORKFLOW ?? ''}\n${env.GITHUB_JOB ?? ''}\n${env.DEVICEPOOL_COMMENT_KEY ?? ''}`).digest('hex').slice(0, 16);
}

export function heldLink(runUrl: string, flow: string): string {
  return `${runUrl}?flow=${encodeURIComponent(flow)}`;
}

function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export function commentBody(result: MaestroRun, key: string): string {
  const c = counts(result.flows);
  const lines = [`<!-- devicepool-run key=${key} run=${result.id} -->`, `### ${suiteName(result.kind)} on Devicepool: ${c.failed ? `${c.failed} failed` : 'passed'}`, ''];
  lines.push(`${c.passed} passed, ${c.flaky} flaky, ${c.failed} failed in ${(result.durationMs / 1000).toFixed(1)} s. [Open the run](${result.url})`);
  const bad = result.flows
    .filter((f) => f.status === 'failed' || f.status === 'flaky')
    .sort((a, b) => (a.status === b.status ? a.flow.localeCompare(b.flow) : a.status === 'failed' ? -1 : 1));
  if (bad.length) {
    lines.push('', '| Flow | Result | Attempts | Recordings | Error |', '|---|---|---|---|---|');
    for (const f of bad) {
      const links = recordingLinks(f).map((l) => `[${l.label}](${l.url})`).join(', ');
      lines.push(`| ${cell(f.flow)} | ${f.status} | ${f.attempts} | ${links} | ${cell(f.status === 'failed' ? (f.message ?? '') : (f.firstMessage ?? ''))} |`);
    }
  }
  const passed = result.flows.filter((f) => f.status === 'passed');
  if (passed.length) {
    lines.push('', `<details><summary>${passed.length} passed</summary>`, '', passed.map((f) => cell(f.flow)).join(', '), '', '</details>');
  }
  const held = result.flows.flatMap((f) => (f.held ? [`- ${cell(f.flow)}: [open the device](${heldLink(result.url, f.flow)}), held until ${clock(f.held.until)}, or \`devicepool held ${result.id} ${f.flow.replace(/[`\s]/g, '')}\``] : []));
  if (held.length) {
    lines.push('', 'Devices kept as the failed flow left them, for people on your team:', '', ...held);
  }
  const failed = bad.find((f) => f.status === 'failed');
  if (failed) {
    lines.push('', `To run a failed flow again on a fresh device, recorded: \`devicepool run maestro --rerun ${result.id} --flow ${failed.flow.replace(/[`\s]/g, '')}\``);
  }
  return `${lines.join('\n')}\n`;
}

async function report(result: MaestroRun, junit: string | undefined, suite: string): Promise<void> {
  for (const f of result.flows) {
    const links = recordingLinks(f).map((l) => `\n      recording (${l.label}): ${l.url}`).join('');
    const held = f.held ? `\n      device held until ${new Date(f.held.until).toLocaleTimeString()}: devicepool held ${result.id} ${f.flow}` : '';
    process.stderr.write(`${f.status === 'failed' ? 'FAIL ' : f.status === 'flaky' ? 'FLAKY' : 'pass '} ${f.flow} (shard ${f.shard + 1}${f.attempts > 1 ? `, ${f.attempts} attempts` : ''})${f.message ? `\n      ${f.message}` : ''}${links}${held}\n`);
  }
  const c = counts(result.flows);
  process.stderr.write(`\n${c.passed} passed, ${c.flaky} flaky, ${c.failed} failed in ${(result.durationMs / 1000).toFixed(1)} s\n${result.url}\n`);
  if (junit) {
    await writeFile(junit, result.junit);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const failing = result.flows
      .filter((f) => f.status === 'failed' || f.status === 'flaky')
      .map((f) => `| ${cell(f.flow)} | ${f.status} | ${recordingLinks(f).map((l) => `[${l.label}](${l.url})`).join(', ')} |`);
    const table = failing.length ? `\n| Test | Result | Recordings |\n|---|---|---|\n${failing.join('\n')}\n` : '';
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${suite} on Devicepool\n\n${c.passed} passed, ${c.flaky} flaky, ${c.failed} failed. [The run](${result.url})\n${table}\n`);
  }
  if (process.env.DEVICEPOOL_COMMENT_FILE) {
    await writeFile(process.env.DEVICEPOOL_COMMENT_FILE, commentBody(result, commentKey(process.env)));
  }
  process.exitCode = result.passed ? 0 : 1;
}

type Project = { root: string; isExpo: boolean; hasDevClient: boolean };

async function project(root: string): Promise<Project> {
  const pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['react-native']) {
    throw new DevicepoolError(0, 'NOT_REACT_NATIVE', 'This folder is not a React Native app (no react-native in package.json).', 'Run it from the app folder.');
  }
  return { root, isExpo: Boolean(deps.expo), hasDevClient: Boolean(deps['expo-dev-client']) };
}

async function build(p: Project, scheme: string | undefined): Promise<string> {
  const ios = join(p.root, 'ios');
  if (!existsSync(ios)) {
    throw new DevicepoolError(0, 'NO_IOS_FOLDER', 'There is no ios folder to build.', p.isExpo ? 'Run `npx expo prebuild -p ios` first, or pass --app with a built simulator .app.' : 'Pass --app with a built simulator .app.');
  }
  const workspace = (await readdir(ios)).find((f) => f.endsWith('.xcworkspace'));
  if (!workspace) {
    throw new DevicepoolError(0, 'NO_WORKSPACE', `No .xcworkspace in ${ios}.`, 'Run `pod install` in the ios folder.');
  }
  const name = scheme ?? basename(workspace, '.xcworkspace');
  const args = ['-workspace', join(ios, workspace), '-scheme', name, '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', 'ONLY_ACTIVE_ARCH=YES', 'ARCHS=arm64'];
  process.stderr.write(`Building ${name} (the first build takes a few minutes)...\n`);
  const logFile = join(tmpdir(), `devicepool-build-${name}.log`);
  const code = await new Promise<number>((resolve) => {
    const x = spawn('xcodebuild', [...args, 'build'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.push(x);
    const out = createWriteStream(logFile);
    x.stdout.pipe(out);
    x.stderr.pipe(out);
    x.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    const errors = (await readFile(logFile, 'utf8')).split('\n').filter((l) => /\berror\b/i.test(l) && !/^\s*note:/.test(l));
    throw new DevicepoolError(0, 'BUILD_FAILED', `xcodebuild failed:\n${errors.slice(-10).join('\n')}\nFull log: ${logFile}`, 'If your app builds another way (expo run:ios, EAS, Bazel), pass that .app with --app.');
  }
  const { stdout } = await run('xcodebuild', [...args, '-showBuildSettings', '-json'], { maxBuffer: 64 * 1024 * 1024 });
  const targets: { buildSettings: Record<string, string> }[] = JSON.parse(stdout);
  const settings = targets.find((s) => s.buildSettings.WRAPPER_EXTENSION === 'app')?.buildSettings;
  if (!settings) {
    throw new DevicepoolError(0, 'NO_APP', `The ${name} scheme builds no .app.`, 'Pass --scheme with the app scheme, or --app.');
  }
  return join(settings.TARGET_BUILD_DIR!, settings.FULL_PRODUCT_NAME!);
}

async function metroRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/status`, { signal: AbortSignal.timeout(1000) });
    return (await res.text()).includes('packager-status:running');
  } catch {
    return false;
  }
}

async function metro(p: Project, port: number): Promise<ChildProcess | null> {
  if (await metroRunning(port)) {
    process.stderr.write(`Using the Metro already running on port ${port}.\n`);
    return null;
  }
  const args = p.isExpo ? ['expo', 'start', '--localhost', '--port', String(port)] : ['react-native', 'start', '--host', '127.0.0.1', '--port', String(port)];
  if (isStopped) {
    return null;
  }
  process.stderr.write(`Starting Metro: npx ${args.join(' ')}\n`);
  // No TTY on stdin keeps Metro non-interactive; CI=1 would also turn off Fast Refresh.
  // Its own process group, so Ctrl-C stops Metro too, not only npx.
  const child = spawn('npx', args, { cwd: p.root, stdio: ['ignore', 'inherit', 'inherit'], detached: true });
  children.push(child);
  for (let i = 0; i < 240; i++) {
    if (await metroRunning(port)) {
      return child;
    }
    if (child.exitCode !== null) {
      throw new DevicepoolError(0, 'METRO_FAILED', 'Metro exited before it started.');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new DevicepoolError(0, 'METRO_TIMEOUT', `Metro did not answer on port ${port} within 2 minutes.`);
}

function stopChildren(): void {
  isStopped = true;
  for (const c of children) {
    try {
      process.kill(-c.pid!, 'SIGTERM');
    } catch {
      c.kill();
    }
  }
}

async function buildWithMetro(build: Promise<string> | string, metroStarted: Promise<unknown>): Promise<string> {
  try {
    const [app] = await Promise.all([build, metroStarted]);
    return app;
  } catch (err) {
    stopChildren();
    throw err;
  }
}

function stopOnCtrlC(lease: () => Lease | null): void {
  let isStopping = false;
  process.on('SIGINT', () => {
    if (isStopping) {
      return;
    }
    isStopping = true;
    stopChildren();
    void (async () => {
      const held = lease();
      if (held) {
        await held.release().catch(() => {});
        process.stderr.write('\nReleased. The device is being wiped.\n');
      }
      process.exit(130);
    })();
  });
}

async function buildApk(p: Project): Promise<string> {
  const dir = join(p.root, 'android');
  if (!existsSync(join(dir, 'gradlew'))) {
    throw new DevicepoolError(0, 'NO_ANDROID_FOLDER', 'There is no android folder with a Gradle wrapper to build.', p.isExpo ? 'Run `npx expo prebuild -p android` first, or pass --app with a built .apk.' : 'Pass --app with a built .apk.');
  }
  process.stderr.write('Building the debug APK (the first build takes a few minutes)...\n');
  const logFile = join(tmpdir(), 'devicepool-build-android.log');
  const code = await new Promise<number>((resolve) => {
    const g = spawn(join(dir, 'gradlew'), ['assembleDebug'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.push(g);
    const out = createWriteStream(logFile);
    g.stdout.pipe(out);
    g.stderr.pipe(out);
    g.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    const errors = (await readFile(logFile, 'utf8')).split('\n').filter((l) => /error|FAILED|What went wrong/.test(l));
    throw new DevicepoolError(0, 'BUILD_FAILED', `Gradle failed:\n${errors.slice(-10).join('\n')}\nFull log: ${logFile}`, 'If your app builds another way (expo run:android, EAS, Bazel), pass that .apk with --app.');
  }
  const out = join(dir, 'app', 'build', 'outputs', 'apk', 'debug');
  const apks = (await readdir(out).catch(() => [])).filter((f) => f.endsWith('.apk'));
  const apk = apks.find((f) => f === 'app-debug.apk') ?? apks.find((f) => f.includes('arm64')) ?? apks[0];
  if (!apk) {
    throw new DevicepoolError(0, 'NO_APK', `Gradle built no .apk in ${out}.`, 'Pass --app with the debug .apk.');
  }
  return join(out, apk);
}

export async function runAndroid(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { app: { type: 'string' }, build: { type: 'string' }, port: { type: 'string', multiple: true }, lease: { type: 'string' } } });
  const p = await project(process.cwd());
  const [port, ...extra] = ports(values.port);
  const leaseId = values.lease ?? process.env.DEVICEPOOL_LEASE;
  const client = await Devicepool.fromEnv();
  let lease: Lease | null = null;
  stopOnCtrlC(() => (leaseId ? null : lease));

  const apk = await buildWithMetro(values.build ?? values.app ?? buildApk(p), metro(p, port));
  lease = leaseId ? client.attach(leaseId) : await client.lease({ platform: 'android-emulator' }, { via: 'devicepool run android' });
  const tunnel = await lease.metroTunnel(port, extra);
  process.stderr.write(`Installing ${values.build ?? basename(apk)}...\n`);
  const { bundleId } = await lease.install(apk);
  await lease.useMetro(bundleId);
  const slug = p.hasDevClient ? await expoSlug(p.root) : null;
  if (slug) {
    await lease.openUrl(`exp+${slug}://expo-development-client/?url=${encodeURIComponent('http://localhost:8081')}`);
  } else {
    await lease.terminate(bundleId).catch(() => {});
    await lease.launch(bundleId);
  }
  const url = `${client.url}/leases/${lease.id}`;
  process.stderr.write(`\nRunning ${bundleId} on ${lease.info.device?.model ?? 'the leased emulator'}, connected to Metro on port ${port}.\n${portLines(tunnel.ports)}Live screen: ${url}\nEdit your code and Fast Refresh updates the device. Press Ctrl-C to release it.\n\n`);
  await openInBrowser(url);
  await new Promise(() => {});
}

async function expoSlug(root: string): Promise<string | null> {
  const app: { expo?: { slug?: string } } = JSON.parse(await readFile(join(root, 'app.json'), 'utf8').catch(() => '{}'));
  if (app.expo?.slug) {
    return app.expo.slug;
  }
  const config = await run('npx', ['expo', 'config', '--json', '--type', 'public'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }).then(
    ({ stdout }): { slug?: string } => JSON.parse(stdout),
    () => ({ slug: undefined }),
  );
  return config.slug ?? null;
}

function ports(values: string[] | undefined): [number, ...number[]] {
  const list = (values ?? ['8081']).map(Number);
  if (list.some((n) => !Number.isInteger(n) || n < 1 || n > 65535)) {
    throw new DevicepoolError(0, 'BAD_PORT', '--port takes a port number.');
  }
  const [metroPort = 8081, ...extra] = list;
  return [metroPort, ...extra];
}

function portLines(ports: Record<string, number>): string {
  return Object.entries(ports)
    .map(([wanted, onDevice]) => (Number(wanted) === onDevice ? `Port ${wanted} on this machine is localhost:${wanted} on the device.\n` : `Port ${wanted} on this machine is localhost:${onDevice} on the device, because another lease on that Mac uses ${wanted}.\n`))
    .join('');
}

async function plist(app: string, key: string, format: 'raw' | 'json'): Promise<string | null> {
  try {
    return (await run('plutil', ['-extract', key, format, '-o', '-', join(app, 'Info.plist')])).stdout.trim();
  } catch {
    return null;
  }
}

export async function runIos(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { app: { type: 'string' }, build: { type: 'string' }, port: { type: 'string', multiple: true }, scheme: { type: 'string' }, model: { type: 'string' }, lease: { type: 'string' } },
  });
  const p = await project(process.cwd());
  const [port, ...extra] = ports(values.port);
  const leaseId = values.lease ?? process.env.DEVICEPOOL_LEASE;
  const client = await Devicepool.fromEnv();
  let lease: Lease | null = null;
  stopOnCtrlC(() => (leaseId ? null : lease));

  const app = await buildWithMetro(values.build ?? values.app ?? build(p, values.scheme), metro(p, port));
  lease = leaseId ? client.attach(leaseId) : await client.lease(values.model ? { model: values.model } : {}, { via: 'devicepool run ios' });
  const localId = values.build ? null : await plist(app, 'CFBundleIdentifier', 'raw');
  if (!values.build && !localId) {
    throw new DevicepoolError(0, 'NOT_AN_APP', `${app} has no bundle id. Pass a built simulator .app.`);
  }

  const tunnel = await lease.metroTunnel(port, extra);
  process.stderr.write(`Installing ${values.build ?? basename(app)}...\n`);
  const installed = await lease.install(app);
  const bundleId = localId ?? installed.bundleId;
  await lease.useMetro(bundleId);
  const urlTypes: { CFBundleURLSchemes?: string[] }[] = values.build ? [] : JSON.parse((await plist(app, 'CFBundleURLTypes', 'json')) ?? '[]');
  const schemes = urlTypes.flatMap((t) => t.CFBundleURLSchemes ?? []);
  const slug = values.build && p.hasDevClient ? await expoSlug(p.root) : null;
  const devClient = p.hasDevClient ? (slug ? `exp+${slug}` : schemes.find((s) => s.startsWith('exp+'))) : undefined;
  if (devClient) {
    await lease.openUrl(`${devClient}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${tunnel.port}`)}`);
  } else {
    await lease.terminate(bundleId).catch(() => {});
    await lease.launch(bundleId);
  }
  const url = `${client.url}/leases/${lease.id}`;
  process.stderr.write(`\nRunning ${bundleId} on ${lease.info.device?.model ?? 'the leased simulator'}, connected to Metro on port ${port}.\n${portLines(tunnel.ports)}Live screen: ${url}\nEdit your code and Fast Refresh updates the device. Press Ctrl-C to release it.\n\n`);
  await openInBrowser(url);
  void devtoolsUrl(port, bundleId).then((link) => link && process.stderr.write(`React Native DevTools: ${link}\n\n`));
  await new Promise(() => {});
}

// 127.0.0.1, not localhost: Expo's dev server drops debugger sockets whose Origin host is not its own.
export async function devtoolsUrl(port: number, bundleId: string, waitMs = 60_000): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const targets: { title?: string; appId?: string; devtoolsFrontendUrl?: string }[] = await fetch(`${base}/json/list`).then((r) => r.json(), () => []);
    const target = targets.find((t) => t.appId === bundleId || t.title?.startsWith(bundleId));
    if (target?.devtoolsFrontendUrl) {
      return base + target.devtoolsFrontendUrl.replace(/ws=localhost(%3A|:)/, 'ws=127.0.0.1$1');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
