// TypeScript client for Hangar's REST API.

import { execFile, spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { Action, DeviceClass, ElementSelector, Frame, LeaseEndReason, LeaseState, Point, UiNode } from '@hangar/protocol';

const run = promisify(execFile);

export type LeaseInfo = {
  id: string;
  state: LeaseState;
  reason: LeaseEndReason | null;
  device: { model: string; os: string } | null;
  queuePosition: number | null;
  expiresAt: number | null;
};

export class HangarError extends Error {
  readonly code: string;
  readonly status: number;
  readonly hint: string | undefined;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(hint ? `${message} ${hint}` : message);
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

export const CONFIG_FILE = join(process.env.HANGAR_HOME ?? join(homedir(), '.hangar'), 'client.json');

export async function savedConfig(): Promise<{ url?: string; token?: string }> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as { url?: string; token?: string };
  } catch {
    return {};
  }
}

export class Hangar {
  readonly url: string;
  readonly token: string;

  constructor(opts: { url: string; token: string }) {
    this.url = opts.url.replace(/\/$/, '');
    this.token = opts.token;
  }

  // From HANGAR_URL and HANGAR_TOKEN, or what `hangar login` saved.
  static async fromEnv(): Promise<Hangar> {
    const saved = await savedConfig();
    const url = process.env.HANGAR_URL ?? saved.url;
    const token = process.env.HANGAR_TOKEN ?? saved.token;
    if (!url || !token) {
      throw new HangarError(0, 'NOT_CONFIGURED', 'Hangar does not know which server to use.', 'Run `npx hangar login <url>`, or set HANGAR_URL and HANGAR_TOKEN.');
    }
    return new Hangar({ url, token });
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body !== undefined && !(body instanceof Readable) ? { 'content-type': 'application/json' } : {}), ...headers },
    };
    if (body instanceof Readable) {
      init.body = Readable.toWeb(body) as ReadableStream;
      init.duplex = 'half';
    } else if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, init);
    } catch (err) {
      throw new HangarError(0, 'UNREACHABLE', `Cannot reach Hangar at ${this.url}.`, 'Is `hangar up` running, and is this machine on the same network?');
    }
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; hint?: string } } | null;
      const e = data?.error ?? { code: `HTTP_${res.status}`, message: `Request failed with HTTP ${res.status}.` };
      throw new HangarError(res.status, e.code, e.message, e.hint);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await (await this.request(method, path, body)).json()) as T;
  }

  async devices(): Promise<{ model: string; os: string; host: string; state: string }[]> {
    return this.json('GET', '/v1/devices');
  }

  async leases(): Promise<LeaseInfo[]> {
    return this.json('GET', '/v1/leases');
  }

  // Leases a device and waits until it is active. The returned lease renews itself until released.
  async lease(cls: DeviceClass = {}, opts: { ttlSeconds?: number; waitSeconds?: number; autoRenew?: boolean } = {}): Promise<Lease> {
    let info = await this.json<LeaseInfo>('POST', `/v1/leases?wait=${opts.waitSeconds ?? 120}`, { class: cls, ...(opts.ttlSeconds ? { ttlSeconds: opts.ttlSeconds } : {}) });
    while (info.state === 'queued' || info.state === 'preparing') {
      info = await this.json<LeaseInfo>('GET', `/v1/leases/${info.id}?wait=60`);
    }
    if (info.state !== 'active') {
      throw new HangarError(409, 'LEASE_NOT_ACTIVE', `The lease ended before it started (${info.reason}).`);
    }
    return new Lease(this, info, opts.autoRenew ?? true, opts.ttlSeconds ?? 600);
  }

  attach(leaseId: string): Lease {
    return new Lease(this, { id: leaseId, state: 'active', reason: null, device: null, queuePosition: null, expiresAt: null }, false, 600);
  }
}

export class Lease {
  readonly id: string;
  info: LeaseInfo;
  private client: Hangar;
  private timer: NodeJS.Timeout | null = null;

  constructor(client: Hangar, info: LeaseInfo, autoRenew: boolean, ttlSeconds: number) {
    this.client = client;
    this.info = info;
    this.id = info.id;
    if (autoRenew) {
      this.timer = setInterval(() => void this.renew().catch(() => {}), (ttlSeconds * 1000) / 3);
      this.timer.unref();
    }
  }

  private path(rest = ''): string {
    return `/v1/leases/${encodeURIComponent(this.id)}${rest}`;
  }

  async renew(ttlSeconds?: number): Promise<LeaseInfo> {
    this.info = await this.client.json('POST', this.path('/renew'), ttlSeconds ? { ttlSeconds } : {});
    return this.info;
  }

  async release(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }
    await this.client.request('DELETE', this.path());
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<Buffer> {
    return Buffer.from(await (await this.client.request('GET', this.path(`/screenshot?format=${format}`))).arrayBuffer());
  }

  async ui(): Promise<{ screen: Frame; nodes: UiNode[] }> {
    return this.client.json('GET', this.path('/ui'));
  }

  async act(actions: Action[]): Promise<{ ok: boolean; error?: { code: string; message: string } }[]> {
    const { results } = await this.client.json<{ results: { ok: boolean; error?: { code: string; message: string } }[] }>('POST', this.path('/actions'), { actions });
    const failed = results.find((r) => !r.ok);
    if (failed?.error) {
      throw new HangarError(422, failed.error.code, failed.error.message);
    }
    return results;
  }

  async tap(target: ElementSelector | Point): Promise<void> {
    await this.act([Array.isArray(target) ? { type: 'tap', point: target } : { type: 'tap', element: target }]);
  }

  async type(text: string): Promise<void> {
    await this.act([{ type: 'type', text }]);
  }

  async waitFor(element: ElementSelector, timeoutMs = 5000): Promise<void> {
    await this.act([{ type: 'waitFor', element, timeoutMs }]);
  }

  // A path to a .app folder or an archive uploads it; anything else is a registered build name.
  async install(appOrBuild: string, name?: string): Promise<{ bundleId: string; name: string }> {
    const isPath = await stat(appOrBuild).then(() => true, () => false);
    if (!isPath) {
      return this.client.json('POST', this.path('/apps'), { build: appOrBuild });
    }
    const label = encodeURIComponent(name ?? basename(appOrBuild));
    const s = await stat(appOrBuild);
    if (s.isFile()) {
      const { createReadStream } = await import('node:fs');
      return (await this.client.request('POST', this.path(`/apps?name=${label}`), createReadStream(appOrBuild), { 'content-type': 'application/octet-stream' })).json() as Promise<{ bundleId: string; name: string }>;
    }
    // A folder: stream it as a tar archive, which every Mac and Linux box can make.
    const tar = spawn('tar', ['-cf', '-', '-C', dirname(appOrBuild), basename(appOrBuild)], { stdio: ['ignore', 'pipe', 'inherit'] });
    return (await this.client.request('POST', this.path(`/apps?name=${label}`), tar.stdout, { 'content-type': 'application/x-tar' })).json() as Promise<{ bundleId: string; name: string }>;
  }

  async launch(bundleId: string, args?: string[]): Promise<void> {
    await this.client.json('POST', this.path(`/apps/${encodeURIComponent(bundleId)}/launch`), args ? { args } : {});
  }

  async terminate(bundleId: string): Promise<void> {
    await this.client.json('POST', this.path(`/apps/${encodeURIComponent(bundleId)}/terminate`), {});
  }

  async openUrl(url: string): Promise<void> {
    await this.client.json('POST', this.path('/open-url'), { url });
  }
}

// Opens a URL in the default browser, on macOS and Linux.
export async function openInBrowser(url: string): Promise<void> {
  if (process.env.HANGAR_NO_OPEN) {
    return;
  }
  await run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]).catch(() => {});
}
