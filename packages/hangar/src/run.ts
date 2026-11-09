import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { Hangar, HangarError, openInBrowser, runEspresso, runMaestro, runXcuitest, type Lease, type MaestroRun } from './client/index.ts';

const run = promisify(execFile);
const children: ChildProcess[] = [];
let stopped = false;

export const RUN_HELP = `  hangar run ios [--app App.app] [--port 8081] [--scheme S] [--model M]
                                           build, install and run your app on a leased
                                           simulator, connected to Metro on this machine
  hangar run android [--app app-debug.apk] [--port 8081]
                                           the same on a leased Android emulator
  hangar run maestro <flows-dir> --app <App.app | build> [--shards N] [--retries 1]
                     [--junit report.xml] [-e KEY=VALUE]...
                                           run Maestro flows sharded over fresh devices
  hangar run xcuitest <Build/Products> [--tests Target/Class,...] [--shards N] [--junit report.xml]
                                           run XCUITest from build-for-testing the same way
  hangar run espresso --app app.apk --test-apk app-test.apk [--tests com.example.LoginTest,...]
                                           run Espresso on Android emulators the same way`;

export async function runMaestroCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { app: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, model: { type: 'string' }, env: { type: 'string', short: 'e', multiple: true } },
  });
  const flowsDir = positionals[0];
  if (!flowsDir || !values.app) {
    throw new HangarError(0, 'USAGE', 'Usage: hangar run maestro <flows-dir> --app <App.app | build> [--shards N]');
  }
  const env = Object.fromEntries((values.env ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  const result = await runMaestro(await Hangar.fromEnv(), {
    app: values.app,
    flowsDir,
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    env,
    ...(values.model ? { device: { model: values.model } } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await report(result, values.junit, 'Maestro');
}

export async function runXcuitestCommand(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' }, model: { type: 'string' } },
  });
  const products = positionals[0];
  if (!products) {
    throw new HangarError(0, 'USAGE', 'Usage: hangar run xcuitest <Build/Products folder> [--tests Target/Class,...] [--shards N]');
  }
  const result = await runXcuitest(await Hangar.fromEnv(), {
    products,
    ...(values.tests ? { tests: values.tests.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    ...(values.model ? { device: { model: values.model } } : {}),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await report(result, values.junit, 'XCUITest');
}

export async function runEspressoCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { app: { type: 'string' }, 'test-apk': { type: 'string' }, tests: { type: 'string' }, shards: { type: 'string' }, retries: { type: 'string' }, junit: { type: 'string' } },
  });
  const testApp = values['test-apk'];
  if (!values.app || !testApp) {
    throw new HangarError(0, 'USAGE', 'Usage: hangar run espresso --app app.apk --test-apk app-test.apk [--tests com.example.LoginTest,...] [--shards N]');
  }
  const result = await runEspresso(await Hangar.fromEnv(), {
    app: values.app,
    testApp,
    ...(values.tests ? { tests: values.tests.split(',').map((t) => t.trim()).filter(Boolean) } : {}),
    shards: Number(values.shards ?? 1),
    retries: Number(values.retries ?? 1),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  await report(result, values.junit, 'Espresso');
}

async function report(result: MaestroRun, junit: string | undefined, suite: string): Promise<void> {
  for (const f of result.flows) {
    process.stderr.write(`${f.status === 'failed' ? 'FAIL ' : f.status === 'flaky' ? 'FLAKY' : 'pass '} ${f.flow} (shard ${f.shard + 1}${f.attempts > 1 ? `, ${f.attempts} attempts` : ''})${f.message ? `\n      ${f.message}` : ''}${f.recording ? `\n      recording: ${f.recording}` : ''}\n`);
  }
  const counts: Record<string, number> = { passed: 0, flaky: 0, failed: 0 };
  for (const f of result.flows) {
    counts[f.status] = (counts[f.status] ?? 0) + 1;
  }
  process.stderr.write(`\n${counts.passed} passed, ${counts.flaky} flaky, ${counts.failed} failed in ${(result.durationMs / 1000).toFixed(1)} s\n${result.url}\n`);
  if (junit) {
    await writeFile(junit, result.junit);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const failing = result.flows.filter((f) => f.status !== 'passed').map((f) => `| ${f.flow} | ${f.status} | ${f.recording ? `[recording](${f.recording})` : ''} |`);
    const table = failing.length ? `\n| Test | Result | |\n|---|---|---|\n${failing.join('\n')}\n` : '';
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `### ${suite} on Hangar\n\n${counts.passed} passed, ${counts.flaky} flaky, ${counts.failed} failed. [The run](${result.url})\n${table}\n`);
  }
  process.exitCode = result.passed ? 0 : 1;
}

type Project = { root: string; isExpo: boolean; hasDevClient: boolean };

async function project(root: string): Promise<Project> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['react-native']) {
    throw new HangarError(0, 'NOT_REACT_NATIVE', 'This folder is not a React Native app (no react-native in package.json).', 'Run it from the app folder.');
  }
  return { root, isExpo: Boolean(deps.expo), hasDevClient: Boolean(deps['expo-dev-client']) };
}

async function build(p: Project, scheme: string | undefined): Promise<string> {
  const ios = join(p.root, 'ios');
  if (!existsSync(ios)) {
    throw new HangarError(0, 'NO_IOS_FOLDER', 'There is no ios folder to build.', p.isExpo ? 'Run `npx expo prebuild -p ios` first, or pass --app with a built simulator .app.' : 'Pass --app with a built simulator .app.');
  }
  const workspace = (await readdir(ios)).find((f) => f.endsWith('.xcworkspace'));
  if (!workspace) {
    throw new HangarError(0, 'NO_WORKSPACE', `No .xcworkspace in ${ios}.`, 'Run `pod install` in the ios folder.');
  }
  const name = scheme ?? basename(workspace, '.xcworkspace');
  const args = ['-workspace', join(ios, workspace), '-scheme', name, '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', 'ONLY_ACTIVE_ARCH=YES', 'ARCHS=arm64'];
  process.stderr.write(`Building ${name} (the first build takes a few minutes)...\n`);
  const logFile = join(tmpdir(), `hangar-build-${name}.log`);
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
    throw new HangarError(0, 'BUILD_FAILED', `xcodebuild failed:\n${errors.slice(-10).join('\n')}\nFull log: ${logFile}`, 'If your app builds another way (expo run:ios, EAS, Bazel), pass that .app with --app.');
  }
  const { stdout } = await run('xcodebuild', [...args, '-showBuildSettings', '-json'], { maxBuffer: 64 * 1024 * 1024 });
  const settings = (JSON.parse(stdout) as { buildSettings: Record<string, string> }[]).find((s) => s.buildSettings.WRAPPER_EXTENSION === 'app')?.buildSettings;
  if (!settings) {
    throw new HangarError(0, 'NO_APP', `The ${name} scheme builds no .app.`, 'Pass --scheme with the app scheme, or --app.');
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
  if (stopped) {
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
      throw new HangarError(0, 'METRO_FAILED', 'Metro exited before it started.');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new HangarError(0, 'METRO_TIMEOUT', `Metro did not answer on port ${port} within 2 minutes.`);
}

function stopChildren(): void {
  stopped = true;
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
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) {
      return;
    }
    stopping = true;
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
    throw new HangarError(0, 'NO_ANDROID_FOLDER', 'There is no android folder with a Gradle wrapper to build.', p.isExpo ? 'Run `npx expo prebuild -p android` first, or pass --app with a built .apk.' : 'Pass --app with a built .apk.');
  }
  process.stderr.write('Building the debug APK (the first build takes a few minutes)...\n');
  const logFile = join(tmpdir(), 'hangar-build-android.log');
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
    throw new HangarError(0, 'BUILD_FAILED', `Gradle failed:\n${errors.slice(-10).join('\n')}\nFull log: ${logFile}`, 'If your app builds another way (expo run:android, EAS, Bazel), pass that .apk with --app.');
  }
  const out = join(dir, 'app', 'build', 'outputs', 'apk', 'debug');
  const apks = (await readdir(out).catch(() => [])).filter((f) => f.endsWith('.apk'));
  const apk = apks.find((f) => f === 'app-debug.apk') ?? apks.find((f) => f.includes('arm64')) ?? apks[0];
  if (!apk) {
    throw new HangarError(0, 'NO_APK', `Gradle built no .apk in ${out}.`, 'Pass --app with the debug .apk.');
  }
  return join(out, apk);
}

export async function runAndroid(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { app: { type: 'string' }, port: { type: 'string' }, lease: { type: 'string' } } });
  const p = await project(process.cwd());
  const port = Number(values.port ?? 8081);
  const client = await Hangar.fromEnv();
  let lease: Lease | null = null;
  stopOnCtrlC(() => (values.lease ? null : lease));

  const apk = await buildWithMetro(values.app ?? buildApk(p), metro(p, port));
  lease = values.lease ? client.attach(values.lease) : await client.lease({ platform: 'android-emulator' }, { via: 'hangar run android' });
  await lease.metroTunnel(port);
  process.stderr.write(`Installing ${basename(apk)}...\n`);
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
  process.stderr.write(`\nRunning ${bundleId} on ${lease.info.device?.model ?? 'the leased emulator'}, connected to Metro on port ${port}.\nLive screen: ${url}\nEdit your code and Fast Refresh updates the device. Press Ctrl-C to release it.\n\n`);
  await openInBrowser(url);
  await new Promise(() => {});
}

async function expoSlug(root: string): Promise<string | null> {
  const app = JSON.parse(await readFile(join(root, 'app.json'), 'utf8').catch(() => '{}')) as { expo?: { slug?: string } };
  return app.expo?.slug ?? null;
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
    options: { app: { type: 'string' }, port: { type: 'string' }, scheme: { type: 'string' }, model: { type: 'string' }, lease: { type: 'string' } },
  });
  const p = await project(process.cwd());
  const port = Number(values.port ?? 8081);
  const client = await Hangar.fromEnv();
  let lease: Lease | null = null;
  stopOnCtrlC(() => (values.lease ? null : lease));

  // The lease comes after the build: a long build would outlast the lease's idle timeout.
  const app = await buildWithMetro(values.app ?? build(p, values.scheme), metro(p, port));
  lease = values.lease ? client.attach(values.lease) : await client.lease(values.model ? { model: values.model } : {}, { via: 'hangar run ios' });
  const bundleId = await plist(app, 'CFBundleIdentifier', 'raw');
  if (!bundleId) {
    throw new HangarError(0, 'NOT_AN_APP', `${app} has no bundle id. Pass a built simulator .app.`);
  }

  const tunnel = await lease.metroTunnel(port);
  process.stderr.write(`Installing ${basename(app)}...\n`);
  await lease.install(app);
  await lease.useMetro(bundleId);
  const schemes = (JSON.parse((await plist(app, 'CFBundleURLTypes', 'json')) ?? '[]') as { CFBundleURLSchemes?: string[] }[]).flatMap((t) => t.CFBundleURLSchemes ?? []);
  const devClient = p.hasDevClient ? schemes.find((s) => s.startsWith('exp+')) : undefined;
  if (devClient) {
    await lease.openUrl(`${devClient}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${tunnel.port}`)}`);
  } else {
    await lease.terminate(bundleId).catch(() => {});
    await lease.launch(bundleId);
  }
  const url = `${client.url}/leases/${lease.id}`;
  process.stderr.write(`\nRunning ${bundleId} on ${lease.info.device?.model ?? 'the leased simulator'}, connected to Metro on port ${port}.\nLive screen: ${url}\nEdit your code and Fast Refresh updates the device. Press Ctrl-C to release it.\n\n`);
  await openInBrowser(url);
  void devtoolsUrl(port, bundleId).then((link) => link && process.stderr.write(`React Native DevTools: ${link}\n\n`));
  await new Promise(() => {});
}

// 127.0.0.1, not localhost: Expo's dev server drops debugger sockets whose Origin host is not its own.
export async function devtoolsUrl(port: number, bundleId: string, waitMs = 60_000): Promise<string | null> {
  const base = `http://127.0.0.1:${port}`;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    const targets = (await fetch(`${base}/json/list`).then((r) => r.json(), () => [])) as { title?: string; appId?: string; devtoolsFrontendUrl?: string }[];
    const target = targets.find((t) => t.appId === bundleId || t.title?.startsWith(bundleId));
    if (target?.devtoolsFrontendUrl) {
      return base + target.devtoolsFrontendUrl.replace(/ws=localhost(%3A|:)/, 'ws=127.0.0.1$1');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
