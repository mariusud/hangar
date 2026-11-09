import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TestCase, TestResult } from '@hangar/protocol';
import { download, OpError } from './index.ts';

const run = promisify(execFile);

export function parseXcodebuild(out: string): TestCase[] {
  const cases: TestCase[] = [];
  const errors = new Map<string, string>();
  for (const line of out.split('\n')) {
    const err = /error: -\[([\w.]+) (\w+)\] : (.*)$/.exec(line);
    if (err) {
      errors.set(`${err[1]} ${err[2]}`, err[3]!.trim());
      continue;
    }
    const m = /^Test [Cc]ase '-\[([\w]+)\.([\w]+) (\w+)\]' (passed|failed) \(([\d.]+) seconds\)/.exec(line.trim());
    if (m) {
      const [, target, cls, method, status, seconds] = m;
      const message = errors.get(`${target}.${cls} ${method}`);
      cases.push({ target: target!, className: cls!, name: method!, status: status === 'passed' ? 'passed' : 'failed', seconds: Number(seconds), ...(status === 'failed' && message ? { message } : {}) });
    }
  }
  return cases;
}

export function checkItems(items: string[]): void {
  if (!items.length || items.some((t) => !/^\w+(\/\w+){0,2}$/.test(t))) {
    throw new OpError('BAD_TESTS', 'Name tests as Target, Target/Class or Target/Class/testMethod.');
  }
}

export async function xcuitest(udid: string, url: string, sha256: string, items: string[]): Promise<TestResult> {
  checkItems(items);
  const dir = await mkdtemp(join(tmpdir(), 'hangar-xcuitest-'));
  try {
    const archive = join(dir, 'products');
    await download(url, sha256, archive);
    const root = join(dir, 'out');
    await run('mkdir', ['-p', root]);
    const { stdout: kind } = await run('file', ['-b', archive]);
    await (kind.startsWith('Zip') ? run('ditto', ['-x', '-k', archive, root]) : run('tar', ['-xf', archive, '-C', root]));
    const xctestrun = await find(root, (f) => f.endsWith('.xctestrun'));
    if (!xctestrun) {
      throw new OpError('NO_XCTESTRUN', 'The archive has no .xctestrun file. Send the Build/Products folder of `xcodebuild build-for-testing`.');
    }
    const args = ['test-without-building', '-xctestrun', xctestrun, '-destination', `id=${udid}`, '-resultBundlePath', join(dir, 'result.xcresult'), ...items.map((t) => `-only-testing:${t}`)];
    const started = Date.now();
    const out = await run('xcodebuild', args, { maxBuffer: 64 * 1024 * 1024, timeout: 60 * 60_000 }).then(
      (r) => ({ ok: true, text: r.stdout + r.stderr }),
      (err: { stdout?: string; stderr?: string }) => ({ ok: false, text: (err.stdout ?? '') + (err.stderr ?? '') }),
    );
    const cases = parseXcodebuild(out.text);
    return { passed: out.ok && cases.every((c) => c.status === 'passed'), cases, log: out.text.slice(-20_000), durationMs: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function find(dir: string, test: (name: string) => boolean, depth = 0): Promise<string | null> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (test(e.name)) {
      return full;
    }
    if (e.isDirectory() && depth < 3 && !e.name.endsWith('.app') && !e.name.endsWith('.xctest')) {
      const hit = await find(full, test, depth + 1);
      if (hit) {
        return hit;
      }
    }
  }
  return null;
}
