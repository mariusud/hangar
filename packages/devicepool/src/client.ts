import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { clip, intOption, seconds } from './args.ts';
import { helpSection } from './help.ts';
import { ATTACH_OPTIONS, BOOK_OPTIONS, IMAGE_REFRESH_OPTIONS, IMAGE_SET_OPTIONS, INSTALL_OPTIONS, LEASE_FLAG, LEASE_OPTIONS, SCREENSHOT_OPTIONS, TAP_OPTIONS, UI_OPTIONS } from './options.ts';
import { buildRef, CONFIG_FILE, Devicepool, DevicepoolError, openInBrowser, type BookingInfo, type Lease } from './client/index.ts';
import { isAndroid, WEEKDAYS, type ElementSelector, type Point, type PrivacyService, type TokenLimits } from '@devicepool/protocol';

export const CLIENT_HELP = helpSection('Client', [
  { usage: 'devicepool login <url>', about: ['sign in from this computer (opens the browser)'] },
  { usage: 'devicepool connect claude | cursor | codex | ci', about: ['give an agent or a CI job its own token, ready to use'] },
  { usage: 'devicepool connect ci <prefix>', about: ['a CI token that uploads only builds whose name', 'starts with <prefix>; run with --build-name'] },
  { usage: 'devicepool connect <booking>', about: ['a token that leases only from that booking, with', 'MCP settings and a GitHub Actions example'] },
  {
    usage: ['devicepool book <name> --devices N --from HH:MM --to HH:MM [--days mon-thu]', '[--image X] [--android] [--model M] [--os V] [--team T]'],
    about: ['hold devices for your team on those days and hours,', 'in the broker\'s time zone'],
  },
  { usage: 'devicepool book rm <name>', about: ['remove a booking; its leases end'] },
  { usage: 'devicepool bookings', about: ['bookings and whether their window is open'] },
  { usage: 'devicepool held <run-id> <flow>', about: ['lease the device a failed flow was left on', '(runs started with --hold)'] },
  { usage: 'devicepool devices', about: ['list devices'] },
  {
    usage: ['devicepool lease [--android | --phone] [--model M] [--os V] [--image NAME]', '[--hold] [--record] [--purpose TEXT] [--ttl SECONDS]', '[--idle SECONDS] [--max SECONDS]'],
    about: ['lease a device; --hold keeps it until Ctrl-C;', '--phone asks for an Android phone on USB;', '--purpose shows on the Fleet page; --ttl, --idle and', '--max are how long it lasts, unused, and in all'],
  },
  { usage: 'devicepool attach <lease-id> [--hold]', about: ['pick up a lease again after a restart'] },
  { usage: 'devicepool keepalive', about: ['count as activity without touching the device'] },
  { usage: 'devicepool tests', about: ['each test\'s passes, flaky passes and failures'] },
  { usage: 'devicepool images', about: ['device images every Mac keeps ready'] },
  {
    usage: ['devicepool image set <name> [--app A]... [--follow] [--locale nb_NO]', '[--appearance dark] [--grant photos,location]', '[--sign-in flow.yaml [--env NAME]...]'],
    about: ['declare an image (operators); --app is a path or build;', '--follow refreshes it on a new upload of an --app;', 'the sign-in flow runs once per Mac, reading each --env', 'name from the broker\'s secrets or the Mac\'s environment'],
  },
  { usage: 'devicepool image refresh <name> --app A...', about: ['build the image again from new builds of its apps'] },
  { usage: 'devicepool image capture <name> <lease-id>', about: ['save a leased device, set up by hand, as an image'] },
  { usage: 'devicepool image secret <NAME> [--rm]', about: ['store a value for a sign-in flow, read from stdin'] },
  { usage: 'devicepool image rm <name>', about: ['remove an image; each Mac deletes its copy'] },
  { usage: 'devicepool screenshot [-o file.png]', about: ['save the screen as a PNG or JPEG'] },
  { usage: 'devicepool ui [--json]', about: ['elements on screen'] },
  { usage: 'devicepool tap --label L | --id I | --role R | --point x,y', about: ['tap an element or a point'] },
  { usage: 'devicepool type <text>', about: ['type into the focused field'] },
  { usage: 'devicepool install <App.app | archive | build-name> [--launch] [--build-name N]', about: ['install an app; --build-name names the upload'] },
  { usage: 'devicepool launch <bundle-id>', about: ['open an installed app'] },
  { usage: 'devicepool open-url <url>', about: ['open a link or deep link'] },
  { usage: 'devicepool push <bundle-id> <payload.json | \'{"aps":...}\'>', about: ['send a push notification'] },
  { usage: 'devicepool permission <grant|revoke|reset> <service> <bundle-id>', about: ['change a privacy permission'] },
  { usage: 'devicepool location <lat,lon | clear>', about: ['set or clear the device location'] },
  { usage: 'devicepool appearance <light|dark>', about: ['switch light and dark mode'] },
  { usage: 'devicepool language <bundle-id> <nb-NO>', about: ['set the app language'] },
  { usage: 'devicepool dev-menu | devicepool reload', about: ['React Native debug builds'] },
  { usage: 'devicepool record [stop]', about: ['record the screen, app log and actions;', 'stop prints the bug link'] },
  { usage: 'devicepool recordings', about: ['your recordings'] },
  { usage: 'devicepool watch', about: ['open the live screen in the browser'] },
  { usage: 'devicepool release', about: ['give the device back; it is wiped'] },
]) + '\n\nDevice commands use --lease <id>, DEVICEPOOL_LEASE, or your only active lease.';

export async function login(url: string | undefined): Promise<void> {
  if (!url) {
    throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool login <url>, for example devicepool login http://studio-mini.local:7420');
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
      reject(new DevicepoolError(0, 'LOGIN_TIMEOUT', 'Nobody approved the sign-in within 5 minutes.'));
    }, 300_000).unref();
  });
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify({ url: base, token }, null, 2), { mode: 0o600 });
  console.log(`Signed in to ${base}. Saved to ${CONFIG_FILE}.`);
}

async function currentLease(client: Devicepool, explicit: string | undefined): Promise<Lease> {
  const id = explicit ?? process.env.DEVICEPOOL_LEASE;
  if (id) {
    return client.attach(id);
  }
  const active = (await client.leases()).filter((l) => l.state === 'active');
  if (active.length === 1 && active[0]) {
    return client.attach(active[0].id);
  }
  throw new DevicepoolError(
    0,
    'LEASE_REQUIRED',
    active.length ? `You hold ${active.length} devices. Pass --lease <id> or set DEVICEPOOL_LEASE.` : 'You hold no device.',
    active.length ? undefined : 'Run `devicepool lease` first.',
  );
}

export const CONNECT_TARGETS = ['claude', 'cursor', 'codex', 'ci'];

export async function connect(target: string | undefined, prefix?: string): Promise<void> {
  if (!target) {
    throw new DevicepoolError(0, 'USAGE', `Usage: devicepool connect ${CONNECT_TARGETS.join(' | ')} | <booking>`);
  }
  const client = await Devicepool.fromEnv();
  if (!CONNECT_TARGETS.includes(target)) {
    await connectBooking(client, target);
    return;
  }
  const label = `${target} on ${hostname()}`;
  const forAgent = target !== 'ci';
  const { token, limits } = await client.json<{ token: string; limits?: TokenLimits }>('POST', '/v1/tokens', {
    label,
    ...(forAgent ? { agent: true, idleSeconds: AGENT_IDLE_SECONDS, maxSeconds: AGENT_MAX_SECONDS } : { scopes: [prefix ? `install:upload:${prefix}` : 'install:upload'], priority: 'ci' }),
  });
  const mcp = `${client.url}/mcp`;
  if (forAgent && limits) {
    console.log(`Leases from this token end after ${minutes(limits.idleMs)} without use and ${minutes(limits.maxMs)} at most. The agent can call keepalive while it thinks.\n`);
  }
  if (target === 'codex') {
    console.log(`Codex reads MCP servers from ~/.codex/config.toml. Add this to it:\n\n[mcp_servers.devicepool]\nurl = "${mcp}"\nhttp_headers = { Authorization = "Bearer ${token}" }`);
    return;
  }
  if (target === 'claude') {
    const args = ['mcp', 'add', '--transport', 'http', 'devicepool', mcp, '--header', `Authorization: Bearer ${token}`];
    const added = await new Promise<boolean>((resolve) => execFile('claude', args, (err) => resolve(!err)));
    if (added) {
      console.log('Added Devicepool to Claude Code. Ask it to "lease an iPhone from devicepool".');
      return;
    }
    console.log(`Claude Code is not on this machine. Run this where it is:\n\n  claude ${args.slice(0, -1).join(' ')} "${args.at(-1)}"`);
    return;
  }
  if (target === 'cursor') {
    console.log(`Put this in .cursor/mcp.json (or ~/.cursor/mcp.json for every project):\n\n${JSON.stringify({ mcpServers: { devicepool: { url: mcp, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)}`);
    return;
  }
  console.log(`Add these two secrets to your CI (GitHub: Settings, Secrets and variables, Actions):

  DEVICEPOOL_URL    ${client.url}
  DEVICEPOOL_TOKEN  ${token}

Then add this step after your Release simulator build:

  - uses: mariusud/devicepool@main
    with:
      url: \${{ secrets.DEVICEPOOL_URL }}
      token: \${{ secrets.DEVICEPOOL_TOKEN }}
      app: build/Build/Products/Release-iphonesimulator/MyApp.app
      flows: .maestro
      shards: 3

The runner must reach ${client.url}, on the same network or through a VPN.`);
}

const AGENT_IDLE_SECONDS = 30 * 60;
const AGENT_MAX_SECONDS = 8 * 60 * 60;

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 120 && m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`;
}

async function connectBooking(client: Devicepool, name: string): Promise<void> {
  const res = await client.json<{ token: string; limits?: TokenLimits; booking: BookingInfo; mcp: string }>('POST', `/v1/bookings/${encodeURIComponent(name)}/tokens`, {
    label: `booking ${name} on ${hostname()}`,
    agent: true,
    idleSeconds: AGENT_IDLE_SECONDS,
    maxSeconds: AGENT_MAX_SECONDS,
  });
  const b = res.booking;
  console.log(`This token leases only from ${b.name}: ${b.devices} device${b.devices === 1 ? '' : 's'}${b.class.image ? ` with image ${b.class.image}` : ''}, ${describeDays(b)} ${b.from} to ${b.to} (${b.timeZone}).
A lease asked for before the window opens waits for it. Leases are told 10 minutes before the window closes and end when it does.
Run shards from this token go before agent leases.

MCP settings for an agent (Cursor, or any client that reads mcpServers):

${JSON.stringify({ mcpServers: { devicepool: { url: res.mcp, headers: { Authorization: `Bearer ${res.token}` } } } }, null, 2)}

Claude Code:

  claude mcp add --transport http devicepool ${res.mcp} --header "Authorization: Bearer ${res.token}"

GitHub Actions: add DEVICEPOOL_URL (${client.url}) and DEVICEPOOL_TOKEN (the token above) as secrets, then:

${actionsExample(b)}`);
}

function describeDays(b: Pick<BookingInfo, 'days'>): string {
  return b.days.length === 7 ? 'every day' : b.days.join(', ');
}

/** A nightly workflow that starts when the booking's window opens. GitHub reads cron in UTC. */
export function actionsExample(b: Pick<BookingInfo, 'days' | 'from' | 'timeZone' | 'next'>): string {
  const cron = cronFor(b);
  return `on:
  schedule:
    - cron: '${cron}'   # ${b.from} ${b.timeZone}, in UTC; check it after a daylight saving change
jobs:
  nightly:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: mariusud/devicepool@main
        with:
          url: \${{ secrets.DEVICEPOOL_URL }}
          token: \${{ secrets.DEVICEPOOL_TOKEN }}
          app: build/Build/Products/Release-iphonesimulator/MyApp.app
          flows: .maestro
          shards: 3`;
}

export function cronFor(b: Pick<BookingInfo, 'days' | 'from' | 'timeZone' | 'next'>): string {
  const [hh = 0, mm = 0] = b.from.split(':').map(Number);
  if (!b.next) {
    return `${mm} ${hh} * * ${b.days.map((d) => (WEEKDAYS.indexOf(d) + 1) % 7).join(',')}`;
  }
  const start = new Date(b.next.from);
  const local = new Intl.DateTimeFormat('en-US', { timeZone: b.timeZone, weekday: 'short' }).format(start);
  const localDay = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local);
  const shift = (start.getUTCDay() - localDay + 7) % 7;
  const step = shift === 6 ? -1 : shift;
  const days = b.days.map((d) => (((WEEKDAYS.indexOf(d) + 1 + step) % 7) + 7) % 7).sort((x, y) => x - y);
  return `${start.getUTCMinutes()} ${start.getUTCHours()} * * ${days.join(',')}`;
}

async function book(args: string[]): Promise<void> {
  if (args[0] === 'rm') {
    const name = args[1];
    if (!name) {
      throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool book rm <name>');
    }
    const client = await Devicepool.fromEnv();
    await client.json('DELETE', `/v1/bookings/${encodeURIComponent(name)}`);
    console.log(`Removed ${name}. Its leases end now.`);
    return;
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: BOOK_OPTIONS });
  const name = positionals[0];
  if (!name || !values.devices || !values.from || !values.to) {
    throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool book <name> --devices N --from HH:MM --to HH:MM --days mon-thu [--image X]');
  }
  if (CONNECT_TARGETS.includes(name)) {
    throw new DevicepoolError(0, 'USAGE', `"${name}" is a name \`devicepool connect\` uses for its own targets, so a token for a booking called that could never be made. Pick another name.`);
  }
  const devices = intOption('--devices', values.devices, 1);
  const client = await Devicepool.fromEnv();
  const b = await client.json<BookingInfo>('POST', '/v1/bookings', {
    name,
    devices,
    from: values.from,
    to: values.to,
    days: values.days ?? 'daily',
    ...(values.image ? { image: values.image } : {}),
    ...(values.android ? { platform: 'android-emulator' } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.os ? { os: values.os } : {}),
    ...(values.team ? { team: values.team } : {}),
  });
  const when = b.open ? `open now, until ${new Date(b.open.to).toLocaleTimeString()}` : b.next ? `opens ${new Date(b.next.from).toLocaleString()}` : 'never opens';
  console.log(`Booked ${b.devices} device${b.devices === 1 ? '' : 's'} for ${b.team}, ${describeDays(b)} ${b.from} to ${b.to} (${b.timeZone}); ${when}.\nGive an agent or a CI job a token for it with \`devicepool connect ${b.name}\`.`);
}

export async function clientCommand(command: string, args: string[]): Promise<boolean> {
  const common = LEASE_FLAG;
  switch (command) {
    case 'login':
      await login(args[0]);
      return true;
    case 'connect':
      await connect(args[0], args[1]);
      return true;
    case 'book':
      await book(args);
      return true;
    case 'bookings': {
      const client = await Devicepool.fromEnv();
      const { timeZone, bookings } = await client.json<{ timeZone: string; bookings: BookingInfo[] }>('GET', '/v1/bookings');
      if (!bookings.length) {
        console.log('No bookings. Make one with `devicepool book <name> --devices N --from HH:MM --to HH:MM --days mon-thu`.');
        return true;
      }
      console.log(`Times are in ${timeZone}.`);
      for (const b of bookings) {
        const state = b.open ? `open, ${b.leases} of ${b.devices} leased` : b.next ? `next ${new Date(b.next.from).toLocaleString()}` : 'closed';
        console.log(`${b.name.padEnd(20)} ${b.team.padEnd(12)} ${String(b.devices).padStart(3)} ${(b.class.image ?? '').padEnd(14)} ${describeDays(b).padEnd(28)} ${b.from}-${b.to}  ${state}`);
      }
      return true;
    }
    case 'held': {
      const [runId, flow] = args;
      if (!runId || !flow) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool held <run-id> <flow>. The run id is in the run link.');
      }
      const client = await Devicepool.fromEnv();
      const info = await client.json<{ id: string; expiresAt: number | null }>('POST', `/v1/runs/${encodeURIComponent(runId)}/flows/${encodeURIComponent(flow)}/hold-lease`);
      console.log(info.id);
      process.stderr.write(`You have the device ${flow} failed on, as the test left it.\nWatch it: ${client.url}/leases/${info.id}\n${info.expiresAt ? `It is wiped at ${new Date(info.expiresAt).toLocaleTimeString()} at the latest, or when you release it.\n` : ''}`);
      return true;
    }
    case 'devices': {
      const client = await Devicepool.fromEnv();
      for (const d of await client.devices()) {
        console.log(`${`${d.model}, ${isAndroid(d.platform) ? 'Android' : 'iOS'} ${d.os}`.padEnd(32)} ${(d.image ?? '').padEnd(16)} ${d.state.padEnd(8)} ${d.host}`);
        if (d.note) {
          console.log(`  ${d.note}`);
        }
      }
      return true;
    }
    case 'tests': {
      const client = await Devicepool.fromEnv();
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
      const client = await Devicepool.fromEnv();
      const images = await client.json<{ name: string; id: string; apps: string[]; locale?: string; appearance?: string; grants?: string[]; signIn?: { env: string[] }; state?: string; hosts?: { host: string; state: string; message?: string }[] }[]>('GET', '/v1/images');
      for (const i of images) {
        const settings = [`${i.apps.length} app${i.apps.length === 1 ? '' : 's'}`];
        if (i.locale) {
          settings.push(i.locale);
        }
        if (i.appearance) {
          settings.push(i.appearance);
        }
        if (i.grants?.length) {
          settings.push(`grants ${i.grants.join(',')}`);
        }
        if (i.signIn) {
          settings.push(i.signIn.env.length ? `signs in with ${i.signIn.env.join(', ')}` : 'signs in');
        }
        console.log(`${i.name.padEnd(24)} ${settings.join(', ')}${i.state ? `, ${i.state}` : ''}`);
        for (const h of i.hosts ?? []) {
          if (h.state === 'failed') {
            console.log(`  ${h.host}: failed${h.message ? `: ${h.message}` : ''}`);
          }
        }
      }
      if (!images.length) {
        console.log('No images. Declare one with `devicepool image set <name> --app ./MyApp.app`.');
      }
      return true;
    }
    case 'image': {
      const [sub, name, ...rest] = args;
      if ((sub !== 'set' && sub !== 'rm' && sub !== 'secret' && sub !== 'refresh' && sub !== 'capture') || !name) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool image set <name> [--app A]... [--follow] [--locale nb_NO] [--appearance dark] [--grant photos,location] [--sign-in flow.yaml --env NAME...], devicepool image refresh <name> --app A..., devicepool image capture <name> <lease-id>, devicepool image secret <NAME> [--rm], or devicepool image rm <name>');
      }
      const client = await Devicepool.fromEnv();
      if (sub === 'secret') {
        const path = `/v1/image-secrets/${encodeURIComponent(name)}`;
        if (rest.includes('--rm')) {
          await client.request('DELETE', path);
          console.log(`Removed the secret ${name}.`);
          return true;
        }
        if (process.stdin.isTTY) {
          process.stderr.write('Type or paste the value, then press Ctrl-D.\n');
        }
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(Buffer.from(chunk));
        }
        const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
        if (!value) {
          throw new DevicepoolError(0, 'USAGE', `Pipe the value in, for example: printf %s "$${name}" | devicepool image secret ${name}`);
        }
        await client.request('PUT', path, { value });
        console.log(`Stored ${name}. Images whose sign-in flow reads it get it the next time they build.`);
        return true;
      }
      if (sub === 'capture') {
        const [leaseId] = rest;
        if (!leaseId) {
          throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool image capture <name> <lease-id>. Lease a device, set it up by hand, then capture it.');
        }
        await client.json('POST', `/v1/images/${encodeURIComponent(name)}/capture`, { leaseId });
        console.log(`Saved the device as ${name} and ended the lease. Lease it with --image ${name} on the same Mac.`);
        return true;
      }
      if (sub === 'refresh') {
        const { values } = parseArgs({ args: rest, options: IMAGE_REFRESH_OPTIONS });
        if (!values.app?.length) {
          throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool image refresh <name> --app build/App.app');
        }
        const apps: string[] = [];
        for (const app of values.app) {
          apps.push(await buildRef(client, app));
        }
        await client.json('POST', `/v1/images/${encodeURIComponent(name)}/refresh`, { apps });
        console.log(`Refreshing ${name}. Leases on the old build keep running; new leases get the new build once each Mac has built it.`);
        return true;
      }
      if (sub === 'rm') {
        await client.request('DELETE', `/v1/images/${encodeURIComponent(name)}`);
        console.log(`Removed ${name}. Each Mac deletes its copy.`);
        return true;
      }
      const { values } = parseArgs({ args: rest, options: IMAGE_SET_OPTIONS });
      if (values.follow && !values.app?.length) {
        throw new DevicepoolError(0, 'USAGE', '--follow refreshes the image when a build of one of its apps is uploaded. Add --app App.app.');
      }
      if (values.env && !values['sign-in']) {
        throw new DevicepoolError(0, 'USAGE', '--env names variables for the sign-in flow. Add --sign-in flow.yaml.');
      }
      const apps: string[] = [];
      for (const app of values.app ?? []) {
        apps.push(await buildRef(client, app));
      }
      const grants = (values.grant ?? []).flatMap((g) => g.split(',')).map((g) => g.trim()).filter(Boolean);
      const signIn = values['sign-in'] ? { flow: await readFile(values['sign-in'], 'utf8'), env: values.env ?? [] } : undefined;
      await client.json('PUT', `/v1/images/${encodeURIComponent(name)}`, { apps, locale: values.locale, appearance: values.appearance, grants, signIn, follow: Boolean(values.follow) });
      console.log(`Declared ${name}. Each Mac builds it once; lease it with \`devicepool lease --image ${name}\`.`);
      if (values.follow) {
        console.log(`Uploading a new build under the same name as one of its apps refreshes ${name}.`);
      }
      return true;
    }
    case 'lease': {
      const { values } = parseArgs({ args, options: LEASE_OPTIONS });
      const ttlSeconds = seconds('--ttl', values.ttl);
      const idleSeconds = seconds('--idle', values.idle);
      const maxSeconds = seconds('--max', values.max);
      const client = await Devicepool.fromEnv();
      process.stderr.write('Getting a device...\n');
      const lease = await client.lease(
        { ...(values.phone ? { platform: 'android-device' } : values.android ? { platform: 'android-emulator' } : {}), ...(values.model ? { model: values.model } : {}), ...(values.os ? { os: values.os } : {}), ...(values.image ? { image: values.image } : {}) },
        {
          autoRenew: Boolean(values.hold),
          record: Boolean(values.record),
          via: values.purpose ? clip(values.purpose, 80) : 'CLI',
          log: (line) => process.stderr.write(`${line}\n`),
          ...(ttlSeconds ? { ttlSeconds } : {}),
          ...(idleSeconds ? { idleSeconds } : {}),
          ...(maxSeconds ? { maxSeconds } : {}),
        },
      );
      console.log(lease.id);
      process.stderr.write(`Leased ${lease.info.device?.model}, ${isAndroid(lease.info.device?.platform) ? 'Android' : 'iOS'} ${lease.info.device?.os}.\nWatch it: ${client.url}/leases/${lease.id}\n`);
      if (values.hold) {
        process.stderr.write('Holding it until you press Ctrl-C.\n');
        await new Promise<void>((resolve) => process.once('SIGINT', resolve));
        await lease.release();
        process.stderr.write('Released. The device is being wiped.\n');
      } else {
        const ends = lease.info.expiresAt ? `at ${new Date(lease.info.expiresAt).toLocaleTimeString()}` : `after ${values.ttl ?? 600} s`;
        process.stderr.write(`It ends ${ends} unless you use it, \`devicepool keepalive\` or renew it. Release it with \`devicepool release\`.\n`);
      }
      return true;
    }
    case 'screenshot': {
      const { values } = parseArgs({ args, options: SCREENSHOT_OPTIONS });
      const lease = await currentLease(await Devicepool.fromEnv(), values.lease);
      const file = values.out ?? 'screenshot.png';
      await writeFile(file, await lease.screenshot(file.endsWith('.jpg') || file.endsWith('.jpeg') ? 'jpeg' : 'png'));
      console.log(file);
      return true;
    }
    case 'ui': {
      const { values } = parseArgs({ args, options: UI_OPTIONS });
      const ui = await (await currentLease(await Devicepool.fromEnv(), values.lease)).ui();
      if (values.json) {
        console.log(JSON.stringify(ui, null, 2));
        return true;
      }
      for (const n of ui.nodes.filter((x) => x.role !== 'application' && (x.label || x.identifier))) {
        const c = [n.normalized.x + n.normalized.width / 2, n.normalized.y + n.normalized.height / 2].map((v) => v.toFixed(2)).join(',');
        console.log(`${n.role.padEnd(12)} ${clip(n.label ?? '', 50).padEnd(50)} ${n.identifier ? `#${n.identifier}` : ''} @${c}`);
      }
      return true;
    }
    case 'tap': {
      const { values } = parseArgs({ args, options: TAP_OPTIONS });
      const lease = await currentLease(await Devicepool.fromEnv(), values.lease);
      if (values.point) {
        const [x, y] = values.point.split(',').map(Number);
        await lease.tap([x ?? 0, y ?? 0] satisfies Point);
      } else {
        const sel: ElementSelector = {};
        if (values.label) sel.label = values.label;
        if (values.id) sel.identifier = values.id;
        if (values.role) sel.role = values.role;
        if (!Object.keys(sel).length) {
          throw new DevicepoolError(0, 'USAGE', 'Say what to tap: --label "Sign in", --id signin, or --point 0.5,0.9.');
        }
        await lease.tap(sel);
      }
      return true;
    }
    case 'type': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).type(positionals.join(' '));
      return true;
    }
    case 'install': {
      const { values, positionals } = parseArgs({ args, options: INSTALL_OPTIONS, allowPositionals: true });
      const target = positionals[0];
      if (!target) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool install <App.app | archive | build-name> [--launch]');
      }
      const lease = await currentLease(await Devicepool.fromEnv(), values.lease);
      process.stderr.write('Installing...\n');
      const app = await lease.install(target, values['build-name']);
      console.log(app.bundleId);
      if (values.launch) {
        await lease.launch(app.bundleId);
      }
      return true;
    }
    case 'launch': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).launch(positionals[0] ?? '');
      return true;
    }
    case 'open-url': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).openUrl(positionals[0] ?? '');
      return true;
    }
    case 'push': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [bundleId, payload] = positionals;
      if (!bundleId || !payload) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool push <bundle-id> <payload.json | json>');
      }
      const raw = payload.trim().startsWith('{') ? payload : await readFile(payload, 'utf8');
      const body: Record<string, unknown> = JSON.parse(raw);
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).push(bundleId, body);
      return true;
    }
    case 'permission': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [action, service, bundleId] = positionals;
      const permissionAction = (['grant', 'revoke', 'reset'] as const).find((a) => a === action);
      if (!permissionAction || !service || !bundleId) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool permission <grant|revoke|reset> <service> <bundle-id>, for example devicepool permission grant location com.example.app');
      }
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).permission(bundleId, service as PrivacyService, permissionAction);
      return true;
    }
    case 'location': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const arg = positionals[0] ?? '';
      const [lat, lon] = arg.split(',').map(Number);
      if (arg !== 'clear' && (lat === undefined || lon === undefined || Number.isNaN(lat) || Number.isNaN(lon))) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool location <lat,lon | clear>, for example devicepool location 59.91,10.75');
      }
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).location(arg === 'clear' ? null : { lat: lat!, lon: lon! });
      return true;
    }
    case 'appearance': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      if (positionals[0] !== 'light' && positionals[0] !== 'dark') {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool appearance <light|dark>');
      }
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).appearance(positionals[0]);
      return true;
    }
    case 'language': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const [bundleId, language] = positionals;
      if (!bundleId || !language) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool language <bundle-id> <language>, for example devicepool language com.example.app nb-NO');
      }
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).language(bundleId, language);
      return true;
    }
    case 'dev-menu':
    case 'reload': {
      const { values } = parseArgs({ args, options: common });
      const lease = await currentLease(await Devicepool.fromEnv(), values.lease);
      await (command === 'reload' ? lease.reload() : lease.devMenu());
      return true;
    }
    case 'record': {
      const { values, positionals } = parseArgs({ args, options: common, allowPositionals: true });
      const lease = await currentLease(await Devicepool.fromEnv(), values.lease);
      if (positionals[0] === 'stop') {
        process.stderr.write('Saving the recording...\n');
        const rec = await lease.stopRecording();
        console.log(rec.url);
      } else {
        await lease.record();
        process.stderr.write('Recording. Run `devicepool record stop` for the link, or release the lease.\n');
      }
      return true;
    }
    case 'recordings': {
      for (const r of await (await Devicepool.fromEnv()).recordings()) {
        const seconds = r.durationMs === null ? '' : `${Math.round(r.durationMs / 1000)} s`;
        console.log(`${r.state.padEnd(9)} ${seconds.padStart(6)}  ${r.device ?? ''}  ${r.url}`);
      }
      return true;
    }
    case 'watch': {
      const { values } = parseArgs({ args, options: common });
      const client = await Devicepool.fromEnv();
      const lease = await currentLease(client, values.lease);
      const url = `${client.url}/leases/${lease.id}`;
      console.log(url);
      await openInBrowser(url);
      return true;
    }
    case 'attach': {
      const { values, positionals } = parseArgs({ args, allowPositionals: true, options: ATTACH_OPTIONS });
      const id = positionals[0] ?? process.env.DEVICEPOOL_LEASE;
      if (!id) {
        throw new DevicepoolError(0, 'USAGE', 'Usage: devicepool attach <lease-id> [--hold]. `devicepool` prints the id when it leases a device.');
      }
      const lease = await (await Devicepool.fromEnv()).reattach(id, { autoRenew: Boolean(values.hold) });
      console.log(lease.id);
      process.stderr.write(`Attached to lease ${lease.id} (${lease.info.state}).\n`);
      if (values.hold) {
        process.stderr.write('Holding it until you press Ctrl-C.\n');
        await new Promise<void>((resolve) => process.once('SIGINT', resolve));
        await lease.release();
        process.stderr.write('Released. The device is being wiped.\n');
      }
      return true;
    }
    case 'keepalive': {
      const { values } = parseArgs({ args, options: common });
      const info = await (await currentLease(await Devicepool.fromEnv(), values.lease)).keepalive();
      process.stderr.write(`Kept alive. It ends at ${info.expiresAt ? new Date(info.expiresAt).toLocaleTimeString() : 'the end of its time'} unless used again.\n`);
      return true;
    }
    case 'release': {
      const { values } = parseArgs({ args, options: common });
      await (await currentLease(await Devicepool.fromEnv(), values.lease)).release();
      process.stderr.write('Released. The device is being wiped.\n');
      return true;
    }
    default:
      return false;
  }
}
