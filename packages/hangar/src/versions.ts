import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type Xcode = { version: string; build: string };

export type SmokeStep = { name: string; status: 'passed' | 'failed' | 'skipped'; ms: number; detail?: string };

export type SmokeEntry = {
  xcode: string;
  build: string;
  runtime: string;
  passed: boolean;
  date: string;
  steps: SmokeStep[];
};

export type VersionsFile = { entries: SmokeEntry[] };

export type Gate = { ok: boolean; detail: string };

export function versionsFile(): string {
  return process.env.HANGAR_VERSIONS ?? fileURLToPath(new URL('../../../hosts/versions.json', import.meta.url));
}

export function parseXcodeVersion(stdout: string): Xcode | null {
  const version = /^Xcode (\S+)/m.exec(stdout)?.[1];
  const build = /^Build version (\S+)/m.exec(stdout)?.[1];
  if (!version || !build) {
    return null;
  }
  return { version, build };
}

export async function currentXcode(): Promise<Xcode | null> {
  try {
    return parseXcodeVersion((await run('xcodebuild', ['-version'])).stdout);
  } catch {
    return null;
  }
}

function isEntry(e: unknown): e is SmokeEntry {
  if (typeof e !== 'object' || e === null) {
    return false;
  }
  const r: Record<string, unknown> = { ...e };
  return typeof r.xcode === 'string' && typeof r.build === 'string' && typeof r.runtime === 'string' && typeof r.passed === 'boolean' && typeof r.date === 'string' && Array.isArray(r.steps);
}

export function parseVersions(text: string): SmokeEntry[] {
  const data: unknown = JSON.parse(text);
  if (typeof data !== 'object' || data === null || !('entries' in data) || !Array.isArray(data.entries)) {
    return [];
  }
  return data.entries.filter(isEntry);
}

export async function readVersions(file = versionsFile()): Promise<SmokeEntry[]> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) {
    return [];
  }
  return parseVersions(text);
}

/** Puts a run in the list, replacing an earlier run on the same Xcode build and runtime. */
export function mergeEntry(entries: SmokeEntry[], entry: SmokeEntry): SmokeEntry[] {
  const rest = entries.filter((e) => e.build !== entry.build || e.runtime !== entry.runtime);
  rest.push(entry);
  return rest.sort((a, b) => a.xcode.localeCompare(b.xcode, 'en', { numeric: true }) || a.runtime.localeCompare(b.runtime, 'en', { numeric: true }));
}

export async function recordSmoke(entry: SmokeEntry, file = versionsFile()): Promise<void> {
  const entries = mergeEntry(await readVersions(file), entry);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ entries } satisfies VersionsFile, null, 2)}\n`);
}

/** Whether this Mac may offer devices: required only when HANGAR_REQUIRE_SMOKE=1. */
export function smokeGate(entries: SmokeEntry[], xcode: Xcode | null, required: boolean): Gate {
  if (!xcode) {
    return { ok: !required, detail: 'Xcode version unknown' };
  }
  const name = `Xcode ${xcode.version} (${xcode.build})`;
  const pass = entries.filter((e) => e.build === xcode.build && e.passed).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (pass) {
    return { ok: true, detail: `${name} passed on ${pass.runtime}, ${pass.date}` };
  }
  const failed = entries.some((e) => e.build === xcode.build);
  return { ok: !required, detail: `${name} has ${failed ? 'only failed' : 'no'} smoke test runs` };
}

export function smokeRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HANGAR_REQUIRE_SMOKE === '1';
}
