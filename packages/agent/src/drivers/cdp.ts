import { WebSocket } from 'ws';
import type { ConsoleMessage, EvaluateResult, NetworkEntry, NetworkPage, Page } from '@hangar/protocol';
import { Ring } from './ring.ts';
import { ToolError } from './tool-error.ts';

type Json = Record<string, unknown>;

const MAX_TEXT = 2000;
const MAX_VALUE = 64 * 1024;
const MAX_EXPRESSION = 100_000;

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function cut(s: string, max = MAX_TEXT): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export type Target = { id: string; title: string; appId?: string; deviceName: string; device: string; webSocketDebuggerUrl: string };

// Picks the page of the leased device from Metro's /json/list. Metro also lists the developer's own devices.
export function pickTarget(raw: unknown, bundleId: string | undefined, isDevice: (name: string) => boolean): Target {
  const all: Target[] = (Array.isArray(raw) ? raw : []).flatMap((x): Target[] => {
    const t = obj(x);
    const url = str(t.webSocketDebuggerUrl);
    const id = str(t.id);
    if (!url || !id) {
      return [];
    }
    const deviceName = str(t.deviceName) ?? '';
    const appId = str(t.appId);
    return [{ id, title: str(t.title) ?? '', ...(appId ? { appId } : {}), deviceName, device: str(obj(t.reactNative).logicalDeviceId) ?? deviceName, webSocketDebuggerUrl: url }];
  });
  const forApp = bundleId ? all.filter((t) => t.appId === bundleId || t.title.startsWith(bundleId)) : all;
  if (!forApp.length) {
    throw new ToolError('JS_NOT_CONNECTED', `No React Native app${bundleId ? ` with id ${bundleId}` : ''} is connected to Metro through this lease. Start it with \`hangar run ios\` or \`hangar run android\` and wait until the bundle has loaded.`);
  }
  const mine = forApp.filter((t) => isDevice(t.deviceName));
  const pool = mine.length ? mine : forApp;
  const devices = [...new Set(pool.map((t) => t.device))];
  if (devices.length > 1) {
    const names = [...new Set(pool.map((t) => t.deviceName || t.device))].join(', ');
    throw new ToolError('JS_TARGET_AMBIGUOUS', `Metro has this app open on ${devices.length} devices (${names}) and Hangar cannot tell which is the leased one. Close the app on the others, or pass bundleId.`);
  }
  const target = pool.at(-1);
  if (!target) {
    throw new ToolError('JS_NOT_CONNECTED', 'No React Native app is connected to Metro through this lease.');
  }
  return target;
}

// Points a debugger URL from /json/list at the agent's end of the Metro tunnel.
export function throughTunnel(url: string, port: number): string {
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
}

type Pending = { resolve: (v: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class Cdp {
  private ws: WebSocket;
  private next = 1;
  private pending = new Map<number, Pending>();
  private onEvent: (method: string, params: Json) => void;

  private constructor(ws: WebSocket, onEvent: (method: string, params: Json) => void) {
    this.ws = ws;
    this.onEvent = onEvent;
    ws.on('message', (data: Buffer) => this.receive(data));
    ws.on('close', () => this.failAll('The debugger connection closed. The app may have reloaded; try again.'));
    ws.on('error', () => {});
  }

  static open(url: string, onEvent: (method: string, params: Json) => void, timeoutMs = 5000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, handshakeTimeout: timeoutMs });
      ws.once('open', () => resolve(new Cdp(ws, onEvent)));
      ws.once('error', (err) => reject(new ToolError('JS_CONNECT_FAILED', `Could not connect to the app's JavaScript debugger through Metro: ${err.message}`)));
    });
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  call(method: string, params: Json = {}, timeoutMs = 10_000): Promise<Json> {
    if (!this.isOpen) {
      return Promise.reject(new ToolError('JS_DISCONNECTED', 'The debugger connection is closed.'));
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ToolError('JS_TIMEOUT', `${method} got no answer from the app in ${timeoutMs / 1000} s. The JavaScript thread may be busy or paused in a breakpoint.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws.close();
    this.failAll('The debugger connection closed.');
  }

  private receive(data: Buffer): void {
    let m: Json;
    try {
      m = obj(JSON.parse(data.toString('utf8')));
    } catch {
      return;
    }
    const id = num(m.id);
    if (id !== undefined) {
      const p = this.pending.get(id);
      if (!p) {
        return;
      }
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (m.error) {
        p.reject(new ToolError('CDP_ERROR', str(obj(m.error).message) ?? 'The app refused the request.'));
      } else {
        p.resolve(obj(m.result));
      }
      return;
    }
    const method = str(m.method);
    if (method) {
      this.onEvent(method, obj(m.params));
    }
  }

  private failAll(message: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new ToolError('JS_DISCONNECTED', message));
    }
    this.pending.clear();
  }
}

// Records XHR (and so fetch, which React Native builds on XHR) in the app when the runtime has no CDP Network domain.
export const XHR_PATCH = `(function () {
  if (globalThis.__hangarNet) { return true; }
  var X = globalThis.XMLHttpRequest;
  if (!X || !X.prototype) { return false; }
  var buf = [], seq = 0, max = 300, open = X.prototype.open, send = X.prototype.send;
  X.prototype.open = function (method, url) {
    this.__hangar = { method: String(method).toUpperCase(), url: String(url).slice(0, 2000) };
    return open.apply(this, arguments);
  };
  X.prototype.send = function () {
    var x = this, e = x.__hangar;
    if (e) {
      e.startedAt = Date.now();
      x.addEventListener('loadend', function () {
        e.durationMs = Date.now() - e.startedAt;
        if (x.status) { e.status = x.status; } else { e.error = 'The request failed or was cancelled.'; }
        try { var t = x.getResponseHeader('content-type'); if (t) { e.mimeType = t.split(';')[0]; } } catch (_) {}
        e.seq = ++seq; e.id = 'xhr-' + seq; buf.push(e);
        if (buf.length > max) { buf.shift(); }
      });
    }
    return send.apply(this, arguments);
  };
  globalThis.__hangarNet = { since: function (c) { return buf.filter(function (e) { return e.seq > c; }); } };
  return true;
})()`;

export type JsOptions = {
  port: () => number | undefined;
  // Says whether a deviceName from Metro's list is the leased device.
  matchDevice: () => Promise<(name: string) => boolean>;
  fetchJson?: (url: string) => Promise<unknown>;
};

const defaultFetchJson = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res.json();
};

// One app's JavaScript runtime on one lease, reached through Metro's inspector. Buffers are kept across reconnects.
export class JsTools {
  readonly console = new Ring<ConsoleMessage>(500);
  readonly network = new Ring<NetworkEntry>(300);
  private cdp: Cdp | null = null;
  private connecting: Promise<Cdp> | null = null;
  private bundleId: string | undefined;
  private source: 'cdp' | 'xhr-patch' = 'cdp';
  private patchCursor = 0;
  private started = new Map<string, number>();
  private opts: JsOptions;
  private closed = false;

  constructor(opts: JsOptions) {
    this.opts = opts;
  }

  async evaluate(expression: string, bundleId?: string): Promise<EvaluateResult> {
    if (typeof expression !== 'string' || !expression.trim() || expression.length > MAX_EXPRESSION) {
      throw new ToolError('BAD_EXPRESSION', `Send a JavaScript expression of up to ${MAX_EXPRESSION} characters.`);
    }
    const cdp = await this.session(bundleId);
    const res = await cdp.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, generatePreview: false });
    const r = obj(res.result);
    const type = str(r.type) ?? 'undefined';
    const details = obj(res.exceptionDetails);
    if (Object.keys(details).length) {
      return { type, exception: cut(str(obj(details.exception).description) ?? str(details.text) ?? 'Uncaught exception', MAX_VALUE) };
    }
    const description = str(r.description) ?? str(r.unserializableValue);
    if ('value' in r) {
      const json = JSON.stringify(r.value) ?? 'undefined';
      if (json.length > MAX_VALUE) {
        return { type, description: `${json.slice(0, MAX_VALUE)}… (cut at ${MAX_VALUE} characters)` };
      }
      return { type, value: r.value };
    }
    return { type, ...(description ? { description: cut(description, MAX_VALUE) } : {}) };
  }

  async consolePage(bundleId: string | undefined, since: number | undefined, limit: number): Promise<Page<ConsoleMessage>> {
    await this.session(bundleId);
    return this.console.page(since, limit);
  }

  async networkPage(bundleId: string | undefined, since: number | undefined, limit: number): Promise<NetworkPage> {
    const cdp = await this.session(bundleId);
    if (this.source === 'xhr-patch') {
      await this.pullPatch(cdp);
    }
    return { ...this.network.page(since, limit), source: this.source };
  }

  close(): void {
    this.closed = true;
    this.cdp?.close();
    this.cdp = null;
  }

  private session(bundleId: string | undefined): Promise<Cdp> {
    if (this.closed) {
      return Promise.reject(new ToolError('LEASE_NOT_HELD', 'This lease has ended.'));
    }
    const wanted = bundleId ?? this.bundleId;
    if (this.cdp?.isOpen && wanted === this.bundleId) {
      return Promise.resolve(this.cdp);
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.cdp?.close();
    this.cdp = null;
    this.connecting = this.connect(wanted).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async connect(bundleId: string | undefined): Promise<Cdp> {
    const port = this.opts.port();
    if (!port) {
      throw new ToolError('NO_METRO_TUNNEL', 'No Metro tunnel is open for this lease, so Hangar cannot reach the app\'s JavaScript. Run `hangar run ios` or `hangar run android`, which opens one.');
    }
    const list = await (this.opts.fetchJson ?? defaultFetchJson)(`http://127.0.0.1:${port}/json/list`).catch((err: Error) => {
      throw new ToolError('METRO_UNREACHABLE', `Could not read the app list from Metro through the tunnel: ${err.message}. Check that Metro is still running on your machine.`);
    });
    const target = pickTarget(list, bundleId, await this.opts.matchDevice());
    const cdp = await Cdp.open(throughTunnel(target.webSocketDebuggerUrl, port), (method, params) => this.event(method, params));
    this.bundleId = bundleId ?? target.appId;
    this.started.clear();
    await cdp.call('Runtime.enable').catch(() => {});
    const network = await cdp.call('Network.enable').then(
      () => true,
      () => false,
    );
    this.source = network ? 'cdp' : 'xhr-patch';
    if (!network) {
      this.patchCursor = 0;
      await cdp.call('Runtime.evaluate', { expression: XHR_PATCH, returnByValue: true }).catch(() => {});
    }
    this.cdp = cdp;
    return cdp;
  }

  private async pullPatch(cdp: Cdp): Promise<void> {
    const res = await cdp.call('Runtime.evaluate', {
      expression: `globalThis.__hangarNet ? JSON.stringify(globalThis.__hangarNet.since(${this.patchCursor})) : null`,
      returnByValue: true,
    });
    const value = obj(res.result).value;
    if (typeof value !== 'string') {
      // The app reloaded and lost the patch.
      this.patchCursor = 0;
      const installed = await cdp.call('Runtime.evaluate', { expression: XHR_PATCH, returnByValue: true });
      if (obj(installed.result).value !== true) {
        throw new ToolError('UNSUPPORTED', 'This JavaScript runtime has neither the CDP Network domain nor XMLHttpRequest, so Hangar cannot list its requests.');
      }
      return;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(value);
    } catch {
      return;
    }
    for (const x of Array.isArray(entries) ? entries : []) {
      const e = obj(x);
      const seq = num(e.seq) ?? 0;
      this.patchCursor = Math.max(this.patchCursor, seq);
      const status = num(e.status);
      const durationMs = num(e.durationMs);
      const mimeType = str(e.mimeType);
      const error = str(e.error);
      const id = str(e.id) ?? `xhr-${seq}`;
      this.network.push(
        {
          id,
          method: str(e.method) ?? 'GET',
          url: cut(str(e.url) ?? ''),
          startedAt: num(e.startedAt) ?? 0,
          ...(status !== undefined ? { status } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(error ? { error } : {}),
        },
        id,
      );
    }
  }

  private event(method: string, p: Json): void {
    if (method === 'Runtime.consoleAPICalled') {
      const args = Array.isArray(p.args) ? p.args : [];
      const text = args.map((a) => remoteText(obj(a))).join(' ');
      this.console.push({ time: num(p.timestamp) ?? Date.now(), level: str(p.type) ?? 'log', text: cut(text) });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = obj(p.exceptionDetails);
      this.console.push({ time: num(p.timestamp) ?? Date.now(), level: 'exception', text: cut(str(obj(d.exception).description) ?? str(d.text) ?? 'Uncaught exception') });
    } else if (method.startsWith('Network.')) {
      this.networkEvent(method, p);
    }
  }

  private networkEvent(method: string, p: Json): void {
    const id = str(p.requestId);
    if (!id) {
      return;
    }
    const at = num(p.timestamp);
    if (method === 'Network.requestWillBeSent') {
      const req = obj(p.request);
      const wall = num(p.wallTime);
      if (at !== undefined) {
        this.started.set(id, at);
        if (this.started.size > this.network.capacity) {
          const oldest = this.started.keys().next().value;
          if (oldest !== undefined) {
            this.started.delete(oldest);
          }
        }
      }
      this.network.push({ id, method: str(req.method) ?? 'GET', url: cut(str(req.url) ?? ''), startedAt: wall !== undefined ? Math.round(wall * 1000) : Date.now() }, id);
      return;
    }
    const entry = this.network.get(id);
    if (!entry) {
      return;
    }
    const t0 = this.started.get(id);
    const durationMs = at !== undefined && t0 !== undefined ? Math.round((at - t0) * 1000) : undefined;
    if (method === 'Network.responseReceived') {
      const res = obj(p.response);
      const status = num(res.status);
      const mimeType = str(res.mimeType);
      this.network.push({ ...entry, ...(status !== undefined ? { status } : {}), ...(mimeType ? { mimeType } : {}) }, id);
    } else if (method === 'Network.loadingFinished') {
      this.started.delete(id);
      const bytes = num(p.encodedDataLength);
      this.network.push({ ...entry, ...(durationMs !== undefined ? { durationMs } : {}), ...(bytes !== undefined ? { bytes } : {}) }, id);
    } else if (method === 'Network.loadingFailed') {
      this.started.delete(id);
      this.network.push({ ...entry, error: cut(str(p.errorText) ?? 'failed'), ...(durationMs !== undefined ? { durationMs } : {}) }, id);
    }
  }
}

function remoteText(a: Json): string {
  if ('value' in a) {
    return typeof a.value === 'string' ? a.value : (JSON.stringify(a.value) ?? String(a.value));
  }
  return str(a.unserializableValue) ?? str(a.description) ?? str(a.type) ?? '';
}
