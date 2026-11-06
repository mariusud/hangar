// hangar run ios: like `expo run:ios`, on a leased simulator. Builds the app here (or takes --app),
// starts or reuses Metro here, leases a device, carries the device's Metro connections back to
// this machine, installs, launches and opens the live screen. Ctrl-C releases the device.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { Hangar, HangarError, openInBrowser, runMaestro, type Lease } from '@hangar/client';

const run = promisify(execFile);
// Everything this command started, stopped on Ctrl-C: xcodebuild, Metro.
const children: ChildProcess[] = [];

export const RUN_HELP = `  hangar run ios [--app App.app] [--port 8081] [--scheme S] [--model M]
                                           build, install and run your app on a leased
                                           simulator, connected to Metro on this machine
  hangar run maestro <flows-dir> --app <App.app | build> [--shards N] [--retries 1]
                     [--junit report.xml] [-e KEY=VALUE]...
                                           run Maestro flows sharded over fresh devices`;

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
  for (const f of result.flows) {
    process.stderr.write(`${f.status === 'failed' ? 'FAIL ' : f.status === 'flaky' ? 'FLAKY' : 'pass '} ${f.flow} (shard ${f.shard + 1}${f.attempts > 1 ? `, ${f.attempts} attempts` : ''})${f.message ? `\n      ${f.message}` : ''}\n`);
  }
  const counts = { passed: 0, flaky: 0, failed: 0 };
  for (const f of result.flows) {
    counts[f.status] += 1;
  }
  process.stderr.write(`\n${counts.passed} passed, ${counts.flaky} flaky, ${counts.failed} failed in ${(result.durationMs / 1000).toFixed(1)} s\n`);
  if (values.junit) {
    await writeFile(values.junit, result.junit);
  }
  process.exitCode = result.passed ? 0 : 1;
}

type Project = { root: string; isExpo: boolean; hasDevClient: boolean };

async function project(root: string): Promise<Project> {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8').catch(() => '{}')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['react-native']) {
    throw new HangarError(0, 'NOT_REACT_NATIVE', 'This folder is not a React Native app (no react-native in package.json).', 'Run `hangar run ios` from the app folder.');
  }
  return { root, isExpo: Boolean(deps.expo), hasDevClient: Boolean(deps['expo-dev-client']) };
}

// Builds the Debug simulator app with xcodebuild in Xcode's usual DerivedData, so builds stay
// incremental across runs and with Xcode itself.
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

// Starts Metro on this machine's loopback only, unless one is already running on the port.
async function metro(p: Project, port: number): Promise<ChildProcess | null> {
  if (await metroRunning(port)) {
    process.stderr.write(`Using the Metro already running on port ${port}.\n`);
    return null;
  }
  const args = p.isExpo ? ['expo', 'start', '--localhost', '--port', String(port)] : ['react-native', 'start', '--host', '127.0.0.1', '--port', String(port)];
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

// `raw` for a string value, `json` for arrays and dictionaries.
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
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const c of children) {
      try {
        process.kill(-c.pid!, 'SIGTERM');
      } catch {
        c.kill();
      }
    }
    void (async () => {
      if (lease && !values.lease) {
        await lease.release().catch(() => {});
        process.stderr.write('\nReleased. The device is being wiped.\n');
      }
      process.exit(130);
    })();
  });

  // Build and Metro run side by side. The lease comes after: a long build would outlast the
  // lease's idle timeout, and a warm device takes seconds.
  const [app] = await Promise.all([values.app ?? build(p, values.scheme), metro(p, port)]);
  lease = values.lease ? client.attach(values.lease) : await client.lease(values.model ? { model: values.model } : {});
  const bundleId = await plist(app, 'CFBundleIdentifier', 'raw');
  if (!bundleId) {
    throw new HangarError(0, 'NOT_AN_APP', `${app} has no bundle id. Pass a built simulator .app.`);
  }

  const tunnel = await lease.metroTunnel(port);
  process.stderr.write(`Installing ${basename(app)}...\n`);
  await lease.install(app);
  await lease.useMetro(bundleId);
  // An Expo dev client starts in its launcher; its deep link opens the bundle directly.
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
  await new Promise(() => {});
}
