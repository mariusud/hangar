// Client commands: login, lease, screenshot, ui, tap, type, install, launch, open-url, release, watch.

import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, Hangar, HangarError, openInBrowser, type Lease } from '@hangar/client';
import type { ElementSelector, Point } from '@hangar/protocol';

export const CLIENT_HELP = `Client
  hangar login <url>                       sign in from this computer (opens the browser)
  hangar devices                           list devices
  hangar lease [--model M] [--os V] [--hold]
                                           lease a device; --hold keeps it until Ctrl-C
  hangar screenshot [-o file.png]
  hangar ui                                elements on screen
  hangar tap --label L | --id I | --point x,y
  hangar type <text>
  hangar install <App.app | archive | build-name>
  hangar launch <bundle-id>
  hangar open-url <url>
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
        console.log(`${`${d.model}, iOS ${d.os}`.padEnd(24)} ${d.state.padEnd(8)} ${d.host}`);
      }
      return true;
    }
    case 'lease': {
      const { values } = parseArgs({ args, options: { model: { type: 'string' }, os: { type: 'string' }, hold: { type: 'boolean' }, ttl: { type: 'string' } } });
      const client = await Hangar.fromEnv();
      process.stderr.write('Getting a device...\n');
      const lease = await client.lease(
        { ...(values.model ? { model: values.model } : {}), ...(values.os ? { os: values.os } : {}) },
        { autoRenew: Boolean(values.hold), ...(values.ttl ? { ttlSeconds: Number(values.ttl) } : {}) },
      );
      console.log(lease.id);
      process.stderr.write(`Leased ${lease.info.device?.model}, iOS ${lease.info.device?.os}.\nWatch it: ${client.url}/leases/${lease.id}\n`);
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
