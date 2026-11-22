// Builds the npm package in dist/npm. See docs/decisions/0014-a-build-for-the-npm-package.md.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist', 'npm');
const SCOPE = '@devicepool/';
/** The workspace packages whose code ships inside the one published package. */
const BUNDLED = ['protocol', 'broker', 'agent'];
const ASSETS = ['LICENSE', 'NOTICE', 'README.md', 'hosts/versions.json', 'packages/agent/native/screen.swift'];
const CONSOLE = join('packages', 'console', 'src');

type Manifest = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function manifest(name: string): Promise<Manifest> {
  const parsed: unknown = JSON.parse(await readFile(join(ROOT, 'packages', name, 'package.json'), 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`packages/${name}/package.json is not an object`);
  }
  return parsed;
}

/** The entry file a workspace package exports, as the emitted .js path under dist/npm. */
function entry(name: string, pkg: Manifest): string {
  if (typeof pkg.exports !== 'string') {
    throw new Error(`packages/${name}/package.json needs "exports" to be one file`);
  }
  return join(OUT, 'packages', name, pkg.exports.replace(/\.ts$/, '.js'));
}

/** Registry dependencies of every bundled package. Workspace links are left out because their code is in the tarball. */
function externalDependencies(pkgs: Manifest[]): Record<string, string> {
  const found = new Map<string, string>();
  for (const pkg of pkgs) {
    if (!isRecord(pkg.dependencies)) {
      continue;
    }
    for (const [dep, range] of Object.entries(pkg.dependencies)) {
      if (typeof range !== 'string' || range.startsWith('workspace:')) {
        continue;
      }
      const other = found.get(dep);
      if (other !== undefined && other !== range) {
        throw new Error(`${dep} is required as both ${other} and ${range}. Use one range in every package.json.`);
      }
      found.set(dep, range);
    }
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)));
}

async function emitted(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && /\.(js|d\.ts)$/.test(e.name)).map((e) => join(e.parentPath, e.name));
}

/**
 * Node resolves `@devicepool/protocol` through the workspace's node_modules links, which an installed
 * package does not have. Point those imports at the emitted files instead. tsc rewrites `./x.ts` to
 * `./x.js` in the .js files but not in the .d.ts files, so that is done here too.
 */
async function relinkImports(entries: Map<string, string>): Promise<void> {
  const workspace = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])@devicepool\/([a-z-]+)\2/g;
  const relativeTs = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g;
  for (const file of await emitted(join(OUT, 'packages'))) {
    const before = await readFile(file, 'utf8');
    let after = before.replace(workspace, (_match, lead: string, quote: string, name: string) => {
      const target = entries.get(name);
      if (target === undefined) {
        throw new Error(`${relative(OUT, file)} imports ${SCOPE}${name}, which is not bundled`);
      }
      const path = relative(dirname(file), target);
      return `${lead}${quote}${path.startsWith('.') ? path : `./${path}`}${quote}`;
    });
    if (file.endsWith('.d.ts')) {
      after = after.replace(relativeTs, '$1$2$3.js$2');
    }
    if (/['"]@devicepool\//.test(after)) {
      throw new Error(`${relative(OUT, file)} still refers to a ${SCOPE} package after relinking`);
    }
    if (after !== before) {
      await writeFile(file, after);
    }
  }
}

async function copyAssets(): Promise<void> {
  for (const file of ASSETS) {
    await mkdir(dirname(join(OUT, file)), { recursive: true });
    await cp(join(ROOT, file), join(OUT, file));
  }
  // The console is static files the broker serves as they are. Its tests and editor types stay behind.
  for (const name of await readdir(join(ROOT, CONSOLE))) {
    if (name.endsWith('.ts')) {
      continue;
    }
    await mkdir(join(OUT, CONSOLE), { recursive: true });
    await cp(join(ROOT, CONSOLE, name), join(OUT, CONSOLE, name));
  }
}

async function main(): Promise<void> {
  const cli = await manifest('devicepool');
  const bundled = new Map<string, Manifest>();
  for (const name of BUNDLED) {
    bundled.set(name, await manifest(name));
  }
  if (!isRecord(cli.bin) || typeof cli.bin.devicepool !== 'string' || typeof cli.exports !== 'string') {
    throw new Error('packages/devicepool/package.json needs "bin.devicepool" and "exports" to be one file each');
  }
  const bin = `./packages/devicepool/${cli.bin.devicepool.replace(/^\.\//, '').replace(/\.ts$/, '.js')}`;
  const client = `./packages/devicepool/${cli.exports.replace(/^\.\//, '').replace(/\.ts$/, '')}`;

  await rm(OUT, { recursive: true, force: true });
  try {
    await run(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.build.json')], { cwd: ROOT });
  } catch (err) {
    const output = isRecord(err) && typeof err.stdout === 'string' ? err.stdout : String(err);
    throw new Error(`tsc failed:\n${output}`);
  }
  const entries = new Map([...bundled].map(([name, pkg]) => [name, entry(name, pkg)]));
  for (const [name, file] of entries) {
    if (!existsSync(file)) {
      throw new Error(`tsc did not emit ${relative(OUT, file)} for ${SCOPE}${name}. Check "paths" in tsconfig.build.json.`);
    }
  }
  await relinkImports(entries);
  await copyAssets();
  await chmod(join(OUT, bin), 0o755);

  // The dev manifest is private, runs .ts and links the workspace. The published one runs the emitted .js.
  const { private: _private, bin: _bin, exports: _exports, dependencies: _dependencies, ...shared } = cli;
  const published = {
    ...shared,
    bin: { devicepool: bin },
    exports: { '.': { types: `${client}.d.ts`, default: `${client}.js` } },
    dependencies: externalDependencies([cli, ...bundled.values()]),
  };
  await writeFile(join(OUT, 'package.json'), `${JSON.stringify(published, null, 2)}\n`);
  // `devicepool version` reads ../package.json from src, and Node needs "type" there to load the .js as ES modules.
  await writeFile(join(OUT, 'packages', 'devicepool', 'package.json'), `${JSON.stringify({ name: cli.name, version: cli.version, type: 'module' }, null, 2)}\n`);
  console.log(`Built ${String(cli.name)} ${String(cli.version)} in ${relative(process.cwd(), OUT) || '.'}`);
}

await main();
