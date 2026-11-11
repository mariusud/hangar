import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { LogStream, parseAppleTime, parseIosLine, parseLogcatLine, iosPredicate, type Spawn } from './applog.ts';
import { JsTools, pickTarget, throughTunnel, XHR_PATCH } from './cdp.ts';
import { LeaseTools } from './devtools.ts';
import { Ring } from './ring.ts';

test('Ring keeps the newest items, pages by cursor, and moves updated keys to the end', () => {
  const r = new Ring<{ n: number }>(3);
  for (let n = 1; n <= 5; n++) {
    r.push({ n });
  }
  assert.deepEqual(r.page(undefined, 10).items.map((i) => i.n), [3, 4, 5]);
  assert.deepEqual(r.page(undefined, 2), { items: [{ n: 4, seq: 4 }, { n: 5, seq: 5 }], next: 5, dropped: false });
  assert.deepEqual(r.page(3, 1), { items: [{ n: 4, seq: 4 }], next: 4, dropped: false });
  assert.equal(r.page(1, 10).dropped, true, 'items 2 fell out after cursor 1');
  assert.deepEqual(r.page(5, 10), { items: [], next: 5, dropped: false });
  assert.equal(r.page(99, 10).next, 5, 'a cursor from before a restart falls back to the current seq');
  const keyed = new Ring<{ s: string }>(10);
  keyed.push({ s: 'a1' }, 'a');
  keyed.push({ s: 'b1' }, 'b');
  const since = keyed.seq;
  keyed.push({ s: 'a2' }, 'a');
  assert.deepEqual(keyed.page(since, 10).items, [{ s: 'a2', seq: 3 }]);
  assert.equal(keyed.size, 2);
});

test('log line parsers read simctl ndjson and logcat epoch lines', () => {
  assert.equal(parseAppleTime('2026-11-11 10:00:00.123456+0100'), Date.parse('2026-11-11T09:00:00.123Z'));
  const ios = parseIosLine(JSON.stringify({ timestamp: '2026-11-11 10:00:00.500000+0000', messageType: 'Error', eventMessage: 'boom', subsystem: 'com.facebook.react.log' }));
  assert.deepEqual(ios, { time: Date.parse('2026-11-11T10:00:00.500Z'), level: 'error', message: 'boom', tag: 'com.facebook.react.log' });
  assert.equal(parseIosLine('Filtering the log data using "processImagePath BEGINSWITH ..."'), null);
  assert.equal(parseIosLine('{"not":"a log line"}'), null);
  assert.deepEqual(parseLogcatLine('  1731320000.123  1234  1250 I ReactNativeJS: hello: world'), { time: 1731320000123, level: 'info', message: 'hello: world', tag: 'ReactNativeJS' });
  assert.equal(parseLogcatLine('--------- beginning of main'), null);
  assert.equal(iosPredicate('/a/"b"/c\\d'), 'processImagePath BEGINSWITH "/a/\\"b\\"/c\\\\d"');
});

// A fake log process: a node child that prints the given lines and then waits until it is killed.
function fakeSpawn(lines: string[], calls: string[][]): Spawn {
  return (command, args) => {
    calls.push([command, ...args]);
    const script = `process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')}); setInterval(() => {}, 1000);`;
    return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const line = (t: number, message: string): string => `${(t / 1000).toFixed(3)}  10  11 I App: ${message}`;

test('LogStream merges a backfill with the live stream once, and restarts only when the source changes', async () => {
  const calls: string[][] = [];
  const stream = new LogStream(fakeSpawn([line(1000, 'old'), line(3000, 'live'), 'garbage', line(4000, 'newer')], calls), 10);
  try {
    await stream.ensure({ key: 'pid-1', command: 'adb', args: ['logcat'], parse: parseLogcatLine, backfill: async () => [{ time: 1000, level: 'info', message: 'old' }, { time: 2000, level: 'info', message: 'from backfill' }] });
    await until(() => stream.ring.size >= 4);
    assert.deepEqual(stream.ring.values().map((l) => l.message), ['old', 'from backfill', 'live', 'newer']);
    await stream.ensure({ key: 'pid-1', command: 'adb', args: ['logcat'], parse: parseLogcatLine });
    assert.equal(calls.length, 1, 'the same source keeps its process');
    await stream.ensure({ key: 'pid-2', command: 'adb', args: ['logcat'], parse: parseLogcatLine });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls.length, 2);
    assert.equal(stream.ring.size, 4, 'a restarted stream does not repeat lines it already held');
  } finally {
    stream.stop();
  }
});

test('LeaseTools: the app defaults to the last one launched, a stopped app reports running false, close stops everything', async () => {
  const calls: string[][] = [];
  const tools = new LeaseTools(fakeSpawn([line(1000, 'hello')], calls));
  await assert.rejects(tools.appLog('L1', {}, async () => null), { code: 'NO_APP' });
  tools.noteApp('L1', 'com.example');
  const source = { key: 'k', command: 'x', args: [], parse: parseLogcatLine };
  const asked: string[] = [];
  await tools.appLog('L1', {}, async (b) => (asked.push(b), source));
  await new Promise((r) => setTimeout(r, 200));
  const page = await tools.appLog('L1', { since: 0, limit: 5 }, async () => source);
  assert.deepEqual(asked, ['com.example']);
  assert.equal(page.bundleId, 'com.example');
  assert.equal(page.running, true);
  assert.deepEqual(page.items.map((l) => l.message), ['hello']);
  const stopped = await tools.appLog('L1', { since: page.next }, async () => null);
  assert.equal(stopped.running, false);
  assert.deepEqual(stopped.items, []);
  tools.close('L1');
  await assert.rejects(tools.appLog('L1', {}, async () => source), { code: 'NO_APP' });
});

test('pickTarget picks the leased device, and refuses to guess between devices', () => {
  const page = (id: string, deviceName: string, device: string, appId = 'com.example'): Record<string, unknown> => ({
    id,
    title: appId,
    appId,
    deviceName,
    reactNative: { logicalDeviceId: device },
    webSocketDebuggerUrl: `ws://localhost:8081/inspector/debug?device=${device}&page=${id}`,
  });
  const list = [page('1', 'iPhone 17', 'mine'), page('2', 'hangar-abc', 'leased'), page('3', 'hangar-abc', 'leased'), page('4', 'hangar-abc', 'leased', 'com.other')];
  assert.equal(pickTarget(list, 'com.example', (n) => n === 'hangar-abc').id, '3');
  assert.throws(() => pickTarget(list, 'com.example', () => false), { code: 'JS_TARGET_AMBIGUOUS' });
  assert.equal(pickTarget([page('1', 'x', 'only')], undefined, () => false).id, '1');
  assert.throws(() => pickTarget([], 'com.example', () => true), { code: 'JS_NOT_CONNECTED' });
  assert.equal(throughTunnel('ws://localhost:8081/inspector/debug?device=a&page=1', 41234), 'ws://127.0.0.1:41234/inspector/debug?device=a&page=1');
});

function portOf(server: Server): number {
  const a = server.address();
  return typeof a === 'object' && a ? a.port : 0;
}

type FakeMetro = { port: number; received: { method: string; params: Record<string, unknown> }[]; sockets: WebSocket[]; close: () => Promise<void> };

// A fake Metro: /json/list plus an inspector socket that answers CDP like Hermes does.
async function fakeMetro(opts: { network: boolean }): Promise<FakeMetro> {
  const received: FakeMetro['received'] = [];
  const sockets: WebSocket[] = [];
  let patched = false;
  const server: Server = createServer((req, res) => {
    const port = portOf(server);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{ id: '1', title: 'com.example', appId: 'com.example', deviceName: 'hangar-abc', webSocketDebuggerUrl: `ws://localhost:${port + 1}/inspector/debug?device=d&page=1` }]));
  });
  const wss = new WebSocketServer({ server, path: '/inspector/debug' });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (data: Buffer) => {
      const m = JSON.parse(data.toString());
      received.push({ method: m.method, params: m.params });
      const reply = (result: unknown): void => ws.send(JSON.stringify({ id: m.id, result }));
      if (m.method === 'Runtime.enable') {
        reply({});
        ws.send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log', timestamp: 1000, args: [{ type: 'string', value: 'hello' }, { type: 'number', value: 42 }, { type: 'object', description: 'Object' }] } }));
        ws.send(JSON.stringify({ method: 'Runtime.exceptionThrown', params: { timestamp: 1001, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined' } } } }));
      } else if (m.method === 'Network.enable') {
        if (opts.network) {
          reply({});
          ws.send(JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'r1', timestamp: 10, wallTime: 1700000000, request: { url: 'https://api.example.com/me', method: 'GET' } } }));
          ws.send(JSON.stringify({ method: 'Network.responseReceived', params: { requestId: 'r1', timestamp: 10.1, response: { status: 200, mimeType: 'application/json' } } }));
          ws.send(JSON.stringify({ method: 'Network.loadingFinished', params: { requestId: 'r1', timestamp: 10.25, encodedDataLength: 512 } }));
        } else {
          ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: 'Unsupported method' } }));
        }
      } else if (m.method === 'Runtime.evaluate') {
        const e: string = m.params.expression;
        if (e === XHR_PATCH) {
          patched = true;
          reply({ result: { type: 'boolean', value: true } });
        } else if (e.startsWith('globalThis.__hangarNet')) {
          const entries = [{ seq: 1, id: 'xhr-1', method: 'POST', url: 'https://api.example.com/login', startedAt: 5, status: 401, durationMs: 30 }];
          reply({ result: patched ? { type: 'string', value: JSON.stringify(e.includes('since(0)') ? entries : []) } : { type: 'object', subtype: 'null', value: null } });
        } else if (e === 'throw') {
          reply({ result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: nope' } } });
        } else if (e === 'big') {
          reply({ result: { type: 'string', value: 'x'.repeat(70_000) } });
        } else {
          reply({ result: { type: 'object', value: { answer: 42 } } });
        }
      } else {
        ws.send(JSON.stringify({ id: m.id, error: { message: 'Unsupported method' } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: portOf(server),
    received,
    sockets,
    close: async () => {
      for (const ws of wss.clients) {
        ws.terminate();
      }
      wss.close();
      await new Promise((r) => server.close(r));
    },
  };
}

test('JsTools evaluates, collects console messages and CDP network events through the tunnel port', async () => {
  const metro = await fakeMetro({ network: true });
  const js = new JsTools({ port: () => metro.port, matchDevice: async () => (n) => n === 'hangar-abc' });
  try {
    assert.deepEqual(await js.evaluate('1 + 1'), { type: 'object', value: { answer: 42 } });
    assert.deepEqual(await js.evaluate('throw'), { type: 'object', exception: 'Error: nope' });
    const big = await js.evaluate('big');
    assert.ok(big.description?.endsWith('(cut at 65536 characters)'));
    assert.equal(big.value, undefined);
    const logs = await js.consolePage(undefined, undefined, 10);
    assert.deepEqual(logs.items.map((m) => [m.level, m.text]), [['log', 'hello 42 Object'], ['exception', 'TypeError: x is undefined']]);
    const net = await js.networkPage(undefined, undefined, 10);
    assert.equal(net.source, 'cdp');
    assert.deepEqual(net.items.map(({ seq: _s, ...e }) => e), [{ id: 'r1', method: 'GET', url: 'https://api.example.com/me', startedAt: 1700000000000, status: 200, mimeType: 'application/json', durationMs: 250, bytes: 512 }]);
    const after = await js.networkPage(undefined, net.next, 10);
    assert.deepEqual(after.items, []);
    assert.equal(metro.sockets.length, 1, 'one debugger connection for all calls');

    metro.sockets[0]?.terminate();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await js.evaluate('again'), { type: 'object', value: { answer: 42 } });
    assert.equal(metro.sockets.length, 2, 'reconnects after the app reloads');
    assert.ok((await js.consolePage(undefined, logs.next, 10)).items.length > 0, 'the replayed console after reconnect is kept');
  } finally {
    js.close();
    await metro.close();
  }
});

test('JsTools falls back to the XHR patch when the runtime has no Network domain', async () => {
  const metro = await fakeMetro({ network: false });
  const js = new JsTools({ port: () => metro.port, matchDevice: async () => () => true });
  try {
    const net = await js.networkPage('com.example', undefined, 10);
    assert.equal(net.source, 'xhr-patch');
    assert.deepEqual(net.items.map((e) => [e.method, e.url, e.status]), [['POST', 'https://api.example.com/login', 401]]);
    assert.equal((await js.networkPage('com.example', net.next, 10)).items.length, 0);
    assert.ok(metro.received.some((m) => m.method === 'Runtime.evaluate' && m.params.expression === XHR_PATCH));
  } finally {
    js.close();
    await metro.close();
  }
});

test('JsTools without a Metro tunnel says how to open one', async () => {
  const js = new JsTools({ port: () => undefined, matchDevice: async () => () => true });
  await assert.rejects(js.evaluate('1'), { code: 'NO_METRO_TUNNEL' });
  await assert.rejects(js.evaluate(''), { code: 'BAD_EXPRESSION' });
});
