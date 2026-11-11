import { execFile } from 'node:child_process';
import { chown, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dataDir } from './up.ts';

const run = promisify(execFile);
const LABEL = 'dev.hangar.up';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const DAEMON = `/Library/LaunchDaemons/${LABEL}.plist`;
const domain = (): string => `gui/${userInfo().uid}`;
const PASSED_ENV = ['HANGAR_REQUIRE_SMOKE', 'HANGAR_VERSIONS'];

export type ServiceOptions = { system?: boolean; user?: string };

function xml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
}

/** The launchd job. With a user it is a LaunchDaemon that runs as that user from boot, with nobody logged in. */
export function servicePlist(program: string[], env: Record<string, string>, log: string, user?: string): string {
  const daemon = user
    ? `
  <key>UserName</key><string>${xml(user)}</string>
  <key>GroupName</key><string>staff</string>
  <key>SessionCreate</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>${daemon}
</dict>
</plist>
`;
}

/** The arguments `hangar up` was given, without the service flags, for the service to pass on. */
export function serviceUpArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--user') {
      i++;
      continue;
    }
    if (a === '--install' || a === '--system' || a.startsWith('--user=')) {
      continue;
    }
    out.push(a);
  }
  return out;
}

export function validUserName(name: string): boolean {
  return /^[a-z_][a-z0-9_.-]{0,31}$/i.test(name) && name !== 'root';
}

/** sudo resets PATH, so the daemon gets the usual places for Node, Homebrew, idb and Maestro. */
export function daemonPath(home: string, nodeDir: string): string {
  const dirs = [nodeDir, join(home, '.local', 'bin'), join(home, '.maestro', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs)].join(':');
}

function program(upArgs: string[]): string[] {
  return [process.execPath, '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./main.ts', import.meta.url)), 'up', ...upArgs];
}

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', HANGAR_NO_OPEN: '1' };
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

async function waitForStart(log: string, since: number): Promise<boolean> {
  for (let i = 0; i < 600; i++) {
    const text = (await readFile(log, 'utf8').catch(() => '')).slice(since);
    const link = /Sign in as admin:\s+(\S+)/.exec(text);
    if (link) {
      const url = /Hangar is running at (\S+)/.exec(text)?.[1];
      console.log(`Hangar is running at ${url}\n  Sign in as admin: ${link[1]}   (one use, 30 min)\n`);
      return true;
    }
    if (/Fix the items marked NO/.test(text)) {
      console.log(`Hangar could not start:\n${text}`);
      process.exitCode = 1;
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return true;
}

export async function installService(upArgs: string[], opts: ServiceOptions = {}): Promise<void> {
  if (opts.system) {
    await installDaemon(upArgs, opts.user);
    return;
  }
  const log = join(dataDir(), 'hangar.log');
  const env = baseEnv();
  if (process.env.HANGAR_HOME) {
    env.HANGAR_HOME = process.env.HANGAR_HOME;
  }
  const plist = servicePlist(program(upArgs), env, log);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(dataDir(), { recursive: true });
  await writeFile(PLIST, plist);
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  const since = (await stat(log).catch(() => null))?.size ?? 0;
  await run('launchctl', ['bootstrap', domain(), PLIST]);
  console.log(`Installed ${PLIST}. Hangar now starts at login and restarts if it stops.\nLog: ${log}\n`);

  if (!(await waitForStart(log, since))) {
    return;
  }
  const autoLogin = await run('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']).then((r) => r.stdout.trim(), () => '');
  if (autoLogin !== userInfo().username) {
    console.log(`To come back after a reboot with nobody at the Mac, turn on automatic login for ${userInfo().username}:
  System Settings > Users & Groups > Automatically log in as. (macOS requires FileVault to be off for this.)
  Or start Hangar at boot as a chosen user, with nobody logged in: sudo hangar up --install --system --user <name>`);
  }
}

async function account(user: string): Promise<{ home: string; uid: number; gid: number } | null> {
  try {
    const home = /NFSHomeDirectory:\s*(\S+)/.exec((await run('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'])).stdout)?.[1];
    const uid = Number((await run('id', ['-u', user])).stdout.trim());
    const gid = Number((await run('id', ['-g', user])).stdout.trim());
    if (!home || !Number.isInteger(uid) || !Number.isInteger(gid)) {
      return null;
    }
    return { home, uid, gid };
  } catch {
    return null;
  }
}

async function installDaemon(upArgs: string[], user: string | undefined): Promise<void> {
  if (!user || !validUserName(user)) {
    console.log('Name the user Hangar runs as, other than root: sudo hangar up --install --system --user hangar');
    process.exitCode = 1;
    return;
  }
  if (process.getuid?.() !== 0) {
    console.log(`Writing a LaunchDaemon needs root. Run the same command with sudo: sudo hangar up --install --system --user ${user}`);
    process.exitCode = 1;
    return;
  }
  const who = await account(user);
  if (!who) {
    console.log(`There is no user ${user} on this Mac. Add a standard user in System Settings > Users & Groups, sign in as it once so macOS sets up its home folder, then run this again.`);
    process.exitCode = 1;
    return;
  }
  const args = program(upArgs);
  for (const file of [args[0], args[2]]) {
    if (!file) {
      continue;
    }
    const readable = await run('sudo', ['-u', user, '/bin/test', '-r', file]).then(() => true, () => false);
    if (!readable) {
      console.log(`${user} cannot read ${file}. Put Node and Hangar where every user can read them (for example under /usr/local or /opt), then run this again.`);
      process.exitCode = 1;
      return;
    }
  }
  const home = process.env.HANGAR_HOME ?? join(who.home, '.hangar');
  const log = join(home, 'hangar.log');
  await mkdir(home, { recursive: true });
  await chown(home, who.uid, who.gid);
  const env = { ...baseEnv(), PATH: daemonPath(who.home, dirname(process.execPath)), HOME: who.home, USER: user, LOGNAME: user, HANGAR_HOME: home };
  await writeFile(DAEMON, servicePlist(args, env, log, user), { mode: 0o644 });
  await chown(DAEMON, 0, 0);
  await run('launchctl', ['bootout', `system/${LABEL}`]).catch(() => {});
  const since = (await stat(log).catch(() => null))?.size ?? 0;
  await run('launchctl', ['bootstrap', 'system', DAEMON]);
  console.log(`Installed ${DAEMON}. Hangar now starts when the Mac boots, runs as ${user} with nobody logged in, and restarts if it stops.\nLog: ${log}\n`);
  if (!(await waitForStart(log, since))) {
    return;
  }
  const vault = await run('fdesetup', ['status']).then((r) => r.stdout, () => '');
  if (/FileVault is On/.test(vault)) {
    console.log('FileVault is on, so after a reboot the Mac waits for someone to unlock the disk before Hangar starts. `sudo fdesetup authrestart` restarts once without that wait.');
  }
}

export async function uninstallService(opts: ServiceOptions = {}): Promise<void> {
  if (opts.system) {
    if (process.getuid?.() !== 0) {
      console.log('Removing the LaunchDaemon needs root. Run: sudo hangar up --uninstall --system');
      process.exitCode = 1;
      return;
    }
    await run('launchctl', ['bootout', `system/${LABEL}`]).catch(() => {});
    await rm(DAEMON, { force: true });
    console.log('Removed the Hangar LaunchDaemon. Its devices are deleted as it stops.');
    return;
  }
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  await rm(PLIST, { force: true });
  console.log('Removed the Hangar service. Its devices are deleted as it stops.');
}
