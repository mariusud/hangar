import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import type { LogLine } from '@hangar/protocol';
import { Ring } from './ring.ts';

export type Spawn = (command: string, args: string[]) => ChildProcess;

export const defaultSpawn: Spawn = (command, args) => nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });

const MAX_MESSAGE = 4000;
const MAX_PARTIAL = 1024 * 1024;

export type LogSource = {
  // Changes when the stream has to restart, such as when an Android app gets a new pid.
  key: string;
  command: string;
  args: string[];
  parse: (line: string) => LogLine | null;
  backfill?: () => Promise<LogLine[]>;
};

// Keeps one log process per lease and app, and the newest lines in memory.
export class LogStream {
  readonly ring: Ring<LogLine>;
  private proc: ChildProcess | null = null;
  private key: string | null = null;
  private lastTime = 0;
  private spawn: Spawn;

  constructor(spawn: Spawn = defaultSpawn, capacity = 2000) {
    this.spawn = spawn;
    this.ring = new Ring(capacity);
  }

  get running(): boolean {
    return this.proc !== null;
  }

  async ensure(source: LogSource): Promise<void> {
    if (this.proc && this.key === source.key) {
      return;
    }
    this.stop();
    this.key = source.key;
    const proc = this.spawn(source.command, source.args);
    this.proc = proc;
    // A restarted stream repeats recent lines; keep only those after the last one held.
    let after = this.lastTime;
    let partial = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      partial += chunk;
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      if (partial.length > MAX_PARTIAL) {
        partial = '';
      }
      for (const raw of lines) {
        const line = source.parse(raw);
        if (line && line.time > after) {
          this.add(line);
        }
      }
    });
    proc.once('exit', () => {
      if (this.proc === proc) {
        this.proc = null;
        this.key = null;
      }
    });
    proc.once('error', () => {});
    if (source.backfill && this.ring.size === 0) {
      const old = await source.backfill().catch((): LogLine[] => []);
      if (old.length) {
        after = old.reduce((m, l) => Math.max(m, l.time), after);
        const fresh = this.ring.values().filter((l) => l.time > after);
        this.ring.clear();
        for (const l of [...old.slice(-this.ring.capacity), ...fresh]) {
          this.add(l);
        }
      }
    }
  }

  private add(l: LogLine): void {
    this.lastTime = Math.max(this.lastTime, l.time);
    this.ring.push(l.message.length > MAX_MESSAGE ? { ...l, message: `${l.message.slice(0, MAX_MESSAGE)}…` } : l);
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
    this.key = null;
  }
}

// `log stream --style ndjson` timestamps look like 2026-11-11 10:00:00.123456+0100.
export function parseAppleTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2}):?(\d{2})$/.exec(s.trim());
  if (!m) {
    return Date.parse(s);
  }
  const ms = (m[3] ?? '.0').slice(0, 4).padEnd(4, '0');
  return Date.parse(`${m[1]}T${m[2]}${ms}${m[4]}:${m[5]}`);
}

export function parseIosLine(raw: string): LogLine | null {
  if (!raw.startsWith('{')) {
    return null;
  }
  let e: unknown;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!e || typeof e !== 'object' || !('eventMessage' in e) || typeof e.eventMessage !== 'string') {
    return null;
  }
  const time = 'timestamp' in e && typeof e.timestamp === 'string' ? parseAppleTime(e.timestamp) : NaN;
  const level = 'messageType' in e && typeof e.messageType === 'string' ? e.messageType.toLowerCase() : 'default';
  const tag = 'subsystem' in e && typeof e.subsystem === 'string' && e.subsystem ? e.subsystem : undefined;
  return { time: Number.isFinite(time) ? time : 0, level, message: e.eventMessage, ...(tag ? { tag } : {}) };
}

const LOGCAT_LEVELS: Record<string, string> = { V: 'verbose', D: 'debug', I: 'info', W: 'warning', E: 'error', F: 'fault', A: 'fault' };

// `adb logcat -v epoch`: "1731320000.123  1234  1250 I ReactNativeJS: hello".
export function parseLogcatLine(raw: string): LogLine | null {
  const m = /^\s*(\d+)\.(\d+)\s+\d+\s+\d+\s+([VDIWEFA])\s+(.*?)\s*: (.*)$/.exec(raw.replace(/\r$/, ''));
  if (!m) {
    return null;
  }
  const time = Number(m[1]) * 1000 + Number((m[2] ?? '0').slice(0, 3).padEnd(3, '0'));
  return { time, level: LOGCAT_LEVELS[m[3] ?? 'I'] ?? 'info', message: m[5] ?? '', ...(m[4] ? { tag: m[4] } : {}) };
}

// A predicate string for `log`: quotes and backslashes in the path are escaped.
export function iosPredicate(appPath: string): string {
  return `processImagePath BEGINSWITH "${appPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
