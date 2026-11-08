// Client commands: login, lease, screenshot, ui, tap, type, install, launch, open-url, release, watch.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildRef, CONFIG_FILE, Hangar, HangarError, openInBrowser, type Lease } from './client/index.ts';
import type { ElementSelector, Point, PrivacyService } from '@hangar/protocol';

export const CLIENT_HELP = `Client
  hangar login <url>                       sign in from this computer (opens the browser)
  hangar devices                           list devices
  hangar lease [--android] [--model M] [--os V] [--image NAME] [--hold] [--record]
                                           lease a device; --hold keeps it until Ctrl-C
  hangar tests                             each test's passes, flaky passes and failures
  hangar images                            device images every Mac keeps ready
  hangar image set <name> [--app A]... [--locale nb_NO] [--appearance dark]
                                           declare an image (operators); --app is a path or build
  hangar image rm <name>
  hangar screenshot [-o file.png]
  hangar ui                                elements on screen
  hangar tap --label L | --id I | --point x,y
  hangar type <text>
  hangar install <App.app | archive | build-name>
  hangar launch <bundle-id>
  hangar open-url <url>
  hangar push <bundle-id> <payload.json | '{"aps":...}'>
  hangar permission <grant|revoke|reset> <service> <bundle-id>
  hangar location <lat,lon | clear>
  hangar appearance <light|dark>
  hangar language <bundle-id> <nb-NO>
  hangar dev-menu | hangar reload          React Native debug builds
  hangar record [stop]                     record the screen, app log and actions; stop prints the bug link
  hangar recordings                        your recordings
  hangar watch                             open the live screen in the browser
  hangar release

Device commands use --lease <id>, HANGAR_LEASE, or your only active lease.`;

export async function login(url: string | undefined): Promise<void> {
  if (!url) {
    throw new HangarError(0, 'USAGE', 'Usage: hangar login <url>, for example hangar login http://studio-mini.local:7420');
  }
  const base = url.replace(/\/$/, '');
  const token = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const t = u.searchParams.get('token');
      if (u.pathname !== '/callback' || !t) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Signed in. You can close this tab and go back to the terminal.</p>');
      server.close();
      resolve(t);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const target = `${base}/cli-login?name=${encodeURIComponent(hostname())}&callback=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}`;
      console.log(`Opening ${target}\nIf no browser opens, open that link yourself.`);
      void openInBrowser(target);
    });
    setTimeout(() => {
      server.close();
      reject(new HangarError(0, 'LOGIN_TIMEOUT', 'Nobody approved the sign-in within 5 minutes.'));
    }, 300_000).unref();
  });
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify({ url: base, token }, null, 2), { mode: 0o600 });
  console.log(`Signed in to ${base}. Saved to ${CONFIG_FILE}.`);
}

async function currentLease(client: Hangar, explicit: string | undefined): Promise<Lease> {
  const id = explicit ?? process.env.HANGAR_LEASE;
  if (id) {
    return client.attach(id);
  }
  const active = (await client.leases()).filter((l) => l.state === 'active');
  if (active.length === 1 && active[0]) {
    return client.attach(active[0].id);
  }
  throw new HangarError(
    0,
    'LEASE_REQUIRED',
    active.length ? `You hold ${active.length} devices. Pass --lease <id> or set HANGAR_LEASE.` : 'You hold no device.',
    active.length ? undefined : 'Run `hangar lease` first.',
  );
}

export async function clientCommand(command: string, args: string[]): Promise<boolean> {
  const common = { lease: { type: 'string' as const } };
  switch (command) {
    case 'login':
      await login(args[0]);
      return true;
    case 'devices': {
      const client = await Hangar.fromEnv();
      for (const d of await client.devices()) {
        console.log(`${`${d.model}, ${d.platform === 'android-emulator' ? 'Android' : 'iOS'} ${d.os}`.padEnd(32)} ${(d.image ?? '').padEnd(16)} ${d.state.padEnd(8)} ${d.host}`);
      }
      return true;
    }
    case 'tests': {
      const client = await Hangar.fromEnv();
      const rows = await client.json<{ test: string; kind: string; runs: number; passed: number; flaky: number; failed: number }[]>('GET', '/v1/tests');
      for (const r of rows) {
        console.log(`${r.test.padEnd(40)} ${r.kind.padEnd(9)} ${`${r.passed} passed`.padEnd(10)} ${`${r.flaky} flaky`.padEnd(9)} ${r.failed} failed of ${r.runs}`);
      }
      if (!rows.length) {
        console.log('No finished runs yet.');
      }
      return true;
    }
    case 'images': {
      const client = await Hangar.fromEnv();
      const images = await client.json<{ name: string; id: string; apps: string[]; locale?: string; appearance?: string }[]>('GET', '/v1/images');
      for (const i of images) {
        const settings = [`${i.apps.length} app${i.apps.length === 1 ? '' : 's'}`];
        if (i.locale) {
          settings.push(i.locale);
        }
        if (i.appearance) {
          settings.push(i.appearance);
        }
        console.log(`${i.name.padEnd(24)} ${settings.join(', ')}`);
      }
      if (!images.length) {
        console.log('No images. Declare one with `hangar image set <name> --app ./MyApp.app`.');
      }
      return true;
    }
    case 'image': {
      const [sub, name, ...rest] = args;
      if ((sub !== 'set' && sub !== 'rm') || !name) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar image set <name> [--app A]... [--locale nb_NO] [--appearance dark], or hangar image rm <name>');
      }
      const client = await Hangar.fromEnv();
      if (sub === 'rm') {
        await client.request('DELETE', `/v1/images/${encodeURIComponent(name)}`);
        console.log(`Removed ${name}. Each Mac deletes its copy.`);
        return true;
      }
      const { values } = parseArgs({ args: rest, options: { app: { type: 'string', multiple: true }, locale: { type: 'string' }, appearance: { type: 'string' } } });
      const apps: string[] = [];
      for (const app of values.app ?? []) {
        apps.push(await buildRef(client, app));
      }
      await client.json('PUT', `/v1/images/${encodeURIComponent(name)}`, { apps, locale: values.locale, appearance: values.appearance });
      console.log(`Declared ${name}. Each Mac builds it once; lease it with \`hangar lease --image ${name}\`.`);
      return true;
    }
    case 'lease': {
      const { values } = parseArgs({ args, options: { android: { type: 'boolean' }, model: { type: 'string' }, os: { type: 'string' }, image: { type: 'string' }, hold: { type: 'boolean' }, ttl: { type: 'string' }, record: { type: 'boolean' } } });
      const client = await Hangar.fromEnv();
      process.stderr.write('Getting a device...\n');
      const lease = await client.lease(
        { ...(values.android ? { platform: 'android-emulator' } : {}), ...(values.model ? { model: values.model } : {}), ...(values.os ? { os: values.os } : {}), ...(values.image ? { image: values.image } : {}) },
        { autoRenew: Boolean(values.hold), record: Boolean(values.record), ...(values.ttl ? { ttlSeconds: Number(values.ttl) } : {}) },
      );
      console.log(lease.id);
      process.stderr.write(`Leased ${lease.info.device?.model}, ${lease.info.device?.platform === 'android-emulator' ? 'Android' : 'iOS'} ${lease.info.device?.os}.\nWatch it: ${client.url}/leases/${lease.id}\n`);
      if (values.hold) {
        process.stderr.write('Holding it until you press Ctrl-C.\n');
        await new Promise<void>((resolve) => process.once('SIGINT', resolve));
        await lease.release();
        process.stderr.write('Released. The device is being wiped.\n');
      } else {
        process.stderr.write(`It ends after ${values.ttl ?? 600} s without use. Release it with \`hangar release\`.\n`);
      }
      return true;
    }
    case 'screenshot': {
      const { values } = parseArgs({ args, options: { ...common, out: { type: 'string', short: 'o' } } });
      const lease = await currentLease(await Hangar.fromEnv(), values.lease);
      const file = values.out ?? 'screenshot.png';
      await writeFile(file, await lease.screenshot(file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'jpeg' : 'png'));
      console.log(file);
      return true;
    }
    case 'ui': {
      const { values } = parseArgs({ args, options: { ...common, json: { type: 'boolean' } } });
      const ui = await (await currentLease(await Hangar.fromEnv(), values.lease)).ui();
      if (values.json) {
        console.log(JSON.stringify(ui, null, 2));
        return true;
      }
      for (const n of ui.nodes.filter((x) => x.role !== 'application' && (x.label || x.identifier))) {
        const c = [n.normalized.x + n.normalized.width / 2, n.normalized.y + n.normalized.height / 2].map((v) => v.toFixed(2)).join(',');
        console.log(`${n.role.padEnd(12)} ${(n.label ?? '').slice(0, 50).padEnd(50)} ${n.identifier ? `#${n.identifier}` : ''} @${c}`);
      }
      return true;
    }
    case 'tap': {
      const { values } = parseArgs({ args, options: { ...common, label: { type: 'string' }, id: { type: 'string' }, role: { type: 'string' }, point: { type: 'string' } } });
      const lease = await currentLease(await Hangar.fromEnv(), values.lease);
      if (values.point) {
        const [x, y] = values.point.split(',').map(Number);
        await lease.tap([x ?? 0, y ?? 0] satisfies Point);
      } else {
        const sel: ElementSelector = {};
        if (values.label) sel.label = values.label;
        if (values.id) sel.identifier = values.id;
        if (values.role) sel.role = values.role;
        if (!Object.keys(sel).length) {
          throw new HangarError(0, 'USAGE', 'Say what to tap: --label "Sign in", --id signin, or --point 0.5,0.9.');
        }
        await lease.tap(sel);
      }
      return true;
    }
    case 'type': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Hangar.fromEnv(), values.lease)).type(positionals.join(' '));
      return true;
    }
    case 'install': {
      const { values, positionals } = parseArgs({ args, options: { ...common, launch: { type: 'boolean' } }, allowPositionals: true });
      const target = positionals[0];
      if (!target) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar install <App.app | archive | build-name> [--launch]');
      }
      const lease = await currentLease(await Hangar.fromEnv(), values.lease);
      process.stderr.write('Installing...\n');
      const app = await lease.install(target);
      console.log(app.bundleId);
      if (values.launch) {
        await lease.launch(app.bundleId);
      }
      return true;
    }
    case 'launch': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Hangar.fromEnv(), values.lease)).launch(positionals[0] ?? '');
      return true;
    }
    case 'open-url': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Hangar.fromEnv(), values.lease)).openUrl(positionals[0] ?? '');
      return true;
    }
    case 'push': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [bundleId, payload] = positionals;
      if (!bundleId || !payload) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar push <bundle-id> <payload.json | json>');
      }
      const raw = payload.trim().startsWith('{') ? payload : await readFile(payload, 'utf8');
      await (await currentLease(await Hangar.fromEnv(), values.lease)).push(bundleId, JSON.parse(raw) as Record<string, unknown>);
      return true;
    }
    case 'permission': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [action, service, bundleId] = positionals;
      if (!action || !service || !bundleId || !['grant', 'revoke', 'reset'].includes(action)) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar permission <grant|revoke|reset> <service> <bundle-id>, for example hangar permission grant location com.example.app');
      }
      await (await currentLease(await Hangar.fromEnv(), values.lease)).permission(bundleId, service as PrivacyService, action as 'grant' | 'revoke' | 'reset');
      return true;
    }
    case 'location': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const arg = positionals[0] ?? '';
      const [lat, lon] = arg.split(',').map(Number);
      if (arg !== 'clear' && (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon))) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar location <lat,lon | clear>, for example hangar location 59.91,10.75');
      }
      await (await currentLease(await Hangar.fromEnv(), values.lease)).location(arg === 'clear' ? null : { lat: lat!, lon: lon! });
      return true;
    }
    case 'appearance': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      if (positionals[0] !== 'light' && positionals[0] !== 'dark') {
        throw new HangarError(0, 'USAGE', 'Usage: hangar appearance <light|dark>');
      }
      await (await currentLease(await Hangar.fromEnv(), values.lease)).appearance(positionals[0]);
      return true;
    }
    case 'language': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [bundleId, language] = positionals;
      if (!bundleId || !language) {
        throw new HangarError(0, 'USAGE', 'Usage: hangar language <bundle-id> <language>, for example hangar language com.example.app nb-NO');
      }
      await (await currentLease(await Hangar.fromEnv(), values.lease)).language(bundleId, language);
      return true;
    }
    case 'dev-menu':
    case 'reload': {
      const { values } = parseArgs({ args, options: common });
      const lease = await currentLease(await Hangar.fromEnv(), values.lease);
      await (command === 'reload' ? lease.reload() : lease.devMenu());
      return true;
    }
    case 'record': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const lease = await currentLease(await Hangar.fromEnv(), values.lease);
      if (positionals[0] === 'stop') {
        process.stderr.write('Saving the recording...\n');
        const rec = await lease.stopRecording();
        console.log(rec.url);
      } else {
        await lease.record();
        process.stderr.write('Recording. Run `hangar record stop` for the link, or release the lease.\n');
      }
      return true;
    }
    case 'recordings': {
      for (const r of await (await Hangar.fromEnv()).recordings()) {
        const seconds = r.durationMs === null ? '' : `${Math.round(r.durationMs / 1000)} s`;
        console.log(`${r.state.padEnd(9)} ${seconds.padStart(6)}  ${r.device ?? ''}  ${r.url}`);
      }
      return true;
    }
    case 'watch': {
      const { values } = parseArgs({ args, options: common });
      const client = await Hangar.fromEnv();
      const lease = await currentLease(client, values.lease);
      const url = `${client.url}/leases/${lease.id}`;
      console.log(url);
      await openInBrowser(url);
      return true;
    }
    case 'release': {
      const { values } = parseArgs({ args, options: common });
      await (await currentLease(await Hangar.fromEnv(), values.lease)).release();
      process.stderr.write('Released. The device is being wiped.\n');
      return true;
    }
    default:
      return false;
  }
}
