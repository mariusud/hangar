import type { AppLogPage } from '@hangar/protocol';
import { defaultSpawn, LogStream, type LogSource, type Spawn } from './applog.ts';
import { JsTools, type JsOptions } from './cdp.ts';
import { ToolError } from './tool-error.ts';

const MAX_APPS = 4;
const MAX_PAGE = 1000;

export function pageLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(Number(limit)) || 200));
}

export function cursor(since: number | undefined): number | undefined {
  return since === undefined || since === null || !Number.isFinite(Number(since)) ? undefined : Math.max(0, Math.floor(Number(since)));
}

type Held = { app: string | null; logs: Map<string, LogStream>; js: JsTools | null };

// What one agent keeps per lease for the log, JavaScript and network tools. All of it is dropped when the lease ends.
export class LeaseTools {
  private leases = new Map<string, Held>();
  private spawn: Spawn;

  constructor(spawn: Spawn = defaultSpawn) {
    this.spawn = spawn;
  }

  private held(leaseId: string): Held {
    let h = this.leases.get(leaseId);
    if (!h) {
      h = { app: null, logs: new Map(), js: null };
      this.leases.set(leaseId, h);
    }
    return h;
  }

  noteApp(leaseId: string, bundleId: string): void {
    this.held(leaseId).app = bundleId;
  }

  app(leaseId: string, bundleId: string | undefined): string {
    const app = bundleId || this.leases.get(leaseId)?.app;
    if (!app) {
      throw new ToolError('NO_APP', 'Name the app with bundleId, or install or launch it through Hangar first so Hangar knows which app is yours.');
    }
    return app;
  }

  async appLog(leaseId: string, op: { bundleId?: string; since?: number; limit?: number }, source: (bundleId: string) => Promise<LogSource | null>): Promise<AppLogPage> {
    const bundleId = this.app(leaseId, op.bundleId);
    const h = this.held(leaseId);
    let stream = h.logs.get(bundleId);
    if (!stream) {
      stream = new LogStream(this.spawn);
      h.logs.set(bundleId, stream);
      for (const [name, old] of h.logs) {
        if (h.logs.size <= MAX_APPS) {
          break;
        }
        old.stop();
        h.logs.delete(name);
      }
    }
    const src = await source(bundleId);
    if (src) {
      await stream.ensure(src);
    } else {
      stream.stop();
    }
    return { ...stream.ring.page(cursor(op.since), pageLimit(op.limit)), bundleId, running: src !== null };
  }

  js(leaseId: string, opts: JsOptions): JsTools {
    const h = this.held(leaseId);
    h.js ??= new JsTools(opts);
    return h.js;
  }

  close(leaseId: string): void {
    const h = this.leases.get(leaseId);
    if (!h) {
      return;
    }
    this.leases.delete(leaseId);
    for (const s of h.logs.values()) {
      s.stop();
    }
    h.js?.close();
  }

  closeAll(): void {
    for (const id of [...this.leases.keys()]) {
      this.close(id);
    }
  }
}
