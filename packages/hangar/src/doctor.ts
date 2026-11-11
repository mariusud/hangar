import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { defaultMaxDevices } from '@hangar/agent';
import { currentXcode, readVersions, smokeGate, smokeRequired } from './versions.ts';

const run = promisify(execFile);

export type Check = { name: string; ok: boolean; detail: string; fix?: string };

export type Prebuilt = { url: string; sha256: string };

const RELEASES = 'https://github.com/facebook/idb/releases/download/';

/** True when version a is older than b, compared on b's major and minor numbers. */
export function isOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.min(2, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      return false;
    }
    if (x !== y) {
      return x < y;
    }
  }
  return false;
}

/** Reads the url and sha256 of the prebuilt companion from a Homebrew formula's text. */
export function parseFormula(text: string): Prebuilt | null {
  const url = /^\s*url\s+"([^"]+)"/m.exec(text)?.[1];
  const sha256 = /^\s*sha256\s+"([0-9a-f]{64})"/m.exec(text)?.[1];
  if (!url || !sha256 || !url.startsWith(RELEASES)) {
    return null;
  }
  return { url, sha256 };
}

/** The fix when Homebrew refuses idb-companion because the Command Line Tools are older than Xcode, or null when that is not the case. */
export function companionFix(clt: string | null, xcode: string | null, prebuilt: Prebuilt | null): string | null {
  if (!clt || !xcode || !isOlder(clt, xcode)) {
    return null;
  }
  const file = prebuilt ? (prebuilt.url.split('/').at(-1) ?? 'idb-companion.tar.gz') : 'idb-companion.universal.tar.gz';
  const download = prebuilt
    ? `      curl -fLO ${prebuilt.url}
      echo "${prebuilt.sha256}  ${file}" | shasum -a 256 -c`
    : `      Download ${file} from https://github.com/facebook/idb/releases (the release the formula names),
      get its sha256 from the formula with \`brew tap facebook/fb && brew cat facebook/fb/idb-companion\`, then:
      echo "<sha256 from the formula>  ${file}" | shasum -a 256 -c`;
  return `Homebrew will not install idb-companion while the Command Line Tools (${clt}) are older than Xcode (${xcode}). Either:
    1. Update the Command Line Tools, then install with Homebrew:
      softwareupdate --list | grep "Command Line Tools"
      sudo softwareupdate --install "<the Command Line Tools label it prints>"
      brew tap facebook/fb && brew install idb-companion
    2. Or use the prebuilt companion from the facebook/idb release, after checking its checksum:
${download}
      mkdir -p ~/.local/idb-companion ~/.local/bin && tar -xzf ${file} -C ~/.local/idb-companion
      ln -sf "$(find ~/.local/idb-companion -name idb_companion -type f | head -1)" ~/.local/bin/idb_companion
    Keep the unpacked folder where it is (the companion loads its Resources from beside it), and put ~/.local/bin on PATH.`;
}

async function output(cmd: string, args: string[]): Promise<string | null> {
  try {
    return (await run(cmd, args)).stdout.trim();
  } catch {
    return null;
  }
}

async function cltVersion(): Promise<string | null> {
  const info = await output('pkgutil', ['--pkg-info=com.apple.pkg.CLTools_Executables']);
  return info ? (/^version:\s*(\S+)/m.exec(info)?.[1] ?? null) : null;
}

async function tappedFormula(): Promise<Prebuilt | null> {
  const repo = await output('brew', ['--repository']);
  if (!repo) {
    return null;
  }
  for (const tap of ['facebook', 'meta']) {
    for (const path of [['Formula', 'idb-companion.rb'], ['idb-companion.rb']]) {
      const text = await readFile(join(repo, 'Library', 'Taps', tap, 'homebrew-fb', ...path), 'utf8').catch(() => null);
      const found = text ? parseFormula(text) : null;
      if (found) {
        return found;
      }
    }
  }
  return null;
}

function iosRuntimes(data: unknown): { name: string }[] {
  if (typeof data !== 'object' || data === null || !('runtimes' in data) || !Array.isArray(data.runtimes)) {
    return [];
  }
  return data.runtimes.flatMap((r: unknown) =>
    typeof r === 'object' && r !== null && 'name' in r && typeof r.name === 'string' && r.name.startsWith('iOS') && 'isAvailable' in r && r.isAvailable === true ? [{ name: r.name }] : [],
  );
}

export async function smokeCheck(): Promise<Check> {
  const required = smokeRequired();
  const gate = smokeGate(await readVersions(), await currentXcode(), required);
  if (gate.ok) {
    return { name: 'Smoke test', ok: true, detail: gate.detail };
  }
  return {
    name: 'Smoke test',
    ok: false,
    detail: `${gate.detail}; HANGAR_REQUIRE_SMOKE=1 keeps this Mac from offering devices`,
    fix: 'Run `pnpm bench:smoke` in a Hangar checkout on this Mac, or unset HANGAR_REQUIRE_SMOKE.',
  };
}

export async function doctor(opts: { smoke?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const xcode = await output('xcodebuild', ['-version']);
  checks.push(
    xcode
      ? { name: 'Xcode', ok: true, detail: xcode.split('\n')[0] ?? '' }
      : { name: 'Xcode', ok: false, detail: 'not found', fix: 'Install Xcode from the App Store, open it once, then run `sudo xcode-select -s /Applications/Xcode.app`.' },
  );
  const runtimes = await output('xcrun', ['simctl', 'list', 'runtimes', '-j']);
  const ios = runtimes ? iosRuntimes(JSON.parse(runtimes)) : [];
  checks.push(
    ios.length
      ? { name: 'iOS runtimes', ok: true, detail: ios.map((r) => r.name).join(', ') }
      : { name: 'iOS runtimes', ok: false, detail: 'none installed', fix: 'In Xcode, open Settings > Components and install an iOS simulator runtime.' },
  );
  const companion = await output('idb_companion', ['--version']);
  if (companion) {
    checks.push({ name: 'idb companion', ok: true, detail: 'installed' });
  } else {
    const xcodeVersion = xcode ? (/^Xcode (\S+)/.exec(xcode)?.[1] ?? null) : null;
    const clt = await cltVersion();
    const fix = companionFix(clt, xcodeVersion, isOlder(clt ?? '', xcodeVersion ?? '') ? await tappedFormula() : null);
    checks.push({ name: 'idb companion', ok: false, detail: 'not found', fix: fix ?? 'brew tap facebook/fb && brew install idb-companion' });
  }
  const client = await output('idb', ['--help']);
  checks.push(
    client
      ? { name: 'idb client', ok: true, detail: 'installed' }
      : { name: 'idb client', ok: false, detail: 'not found', fix: 'pipx install fb-idb   (or: pip3 install --user fb-idb)' },
  );
  const user = userInfo().username;
  checks.push({
    name: 'User',
    ok: true,
    detail: user === 'hangar' ? 'runs as its own user, hangar' : `runs as ${user}; apps on the simulators can read this user's files. See docs/guides/isolation.md`,
  });
  const max = defaultMaxDevices();
  checks.push({ name: 'Capacity', ok: true, detail: `up to ${max} simulator${max === 1 ? '' : 's'} at once on this Mac` });
  if ((opts.smoke ?? true) && smokeRequired()) {
    checks.push(await smokeCheck());
  }
  return checks;
}

export function printChecks(checks: Check[]): void {
  for (const c of checks) {
    console.log(`  ${c.ok ? 'ok ' : 'NO '} ${c.name.padEnd(14)} ${c.detail}`);
    if (!c.ok && c.fix) {
      console.log(`      fix: ${c.fix}`);
    }
  }
}
