import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dataDir } from './up.ts';

const run = promisify(execFile);
const LABEL = 'dev.hangar.up';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = (): string => `gui/${userInfo().uid}`;

function xml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
}

export function servicePlist(program: string[], env: Record<string, string>, log: string): string {
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
${Object.entries(env).map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

export async function installService(upArgs: string[]): Promise<void> {
  const log = join(dataDir(), 'hangar.log');
  const program = [process.execPath, '--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./main.ts', import.meta.url)), 'up', ...upArgs];
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', HANGAR_NO_OPEN: '1' };
  if (process.env.HANGAR_HOME) {
    env.HANGAR_HOME = process.env.HANGAR_HOME;
  }
  const plist = servicePlist(program, env, log);
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(dataDir(), { recursive: true });
  await writeFile(PLIST, plist);
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  const since = (await stat(log).catch(() => null))?.size ?? 0;
  await run('launchctl', ['bootstrap', domain(), PLIST]);
  console.log(`Installed ${PLIST}. Hangar now starts at login and restarts if it stops.\nLog: ${log}\n`);

  for (let i = 0; i < 600; i++) {
    const text = (await readFile(log, 'utf8').catch(() => '')).slice(since);
    const link = /Sign in as admin:\s+(\S+)/.exec(text);
    if (link) {
      const url = /Hangar is running at (\S+)/.exec(text)?.[1];
      console.log(`Hangar is running at ${url}\n  Sign in as admin: ${link[1]}   (one use, 30 min)\n`);
      break;
    }
    if (/Fix the items marked NO/.test(text)) {
      console.log(`Hangar could not start:\n${text}`);
      process.exitCode = 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const autoLogin = await run('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']).then((r) => r.stdout.trim(), () => '');
  if (autoLogin !== userInfo().username) {
    console.log(`To come back after a reboot with nobody at the Mac, turn on automatic login for ${userInfo().username}:
  System Settings > Users & Groups > Automatically log in as. (macOS requires FileVault to be off for this.)`);
  }
}

export async function uninstallService(): Promise<void> {
  await run('launchctl', ['bootout', `${domain()}/${LABEL}`]).catch(() => {});
  await rm(PLIST, { force: true });
  console.log('Removed the Hangar service. Its devices are deleted as it stops.');
}
