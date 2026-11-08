// The tool names and arguments of mobile-mcp (github.com/mobile-next/mobile-mcp), so an agent
// written for it works against Hangar unchanged. A `device` is a lease id: allocate one with
// mobile_allocate_remote_device, which leases a fresh device from the pool, and release it with
// mobile_release_remote_device. A lease nobody uses ends after its TTL, 10 minutes by default.
//
// Coordinates are in the units mobile_list_elements_on_screen and mobile_get_screen_size report:
// points on iOS, pixels on Android. Tools that need the host's files (logs, crash reports,
// recordings to a path) are left out; Hangar has its own `record` tool for those.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Action, DeviceClass, Frame, Point, UiNode } from '@hangar/protocol';
import type * as auth from './auth.ts';
import type { Db } from './db.ts';
import { ApiError, type Leases } from './leases/service.ts';

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type Result = { content: Content[]; isError?: boolean };

export type MobileDeps = {
  server: McpServer;
  p: auth.Principal;
  db: Db;
  leases: Leases;
  safe: (fn: () => Promise<Result>) => Promise<Result>;
  text: (value: unknown) => Result;
  install: (leaseId: string, build: string) => Promise<unknown>;
};

const device = z.string().describe('The device id from mobile_allocate_remote_device (a Hangar lease id)');

// The elements an agent can act on, numbered @e1, @e2, ... in screen order.
function actionable(nodes: UiNode[]): UiNode[] {
  return nodes.filter((n) => n.role !== 'application' && (n.label || n.identifier));
}

export function registerMobileTools({ server, p, db, leases, safe, text, install }: MobileDeps): void {
  const screenOf = async (id: string): Promise<{ screen: Frame; nodes: UiNode[] }> => (await leases.op(p, id, { op: 'describe' })).result as { screen: Frame; nodes: UiNode[] };

  // A point in screen units, or the center of an element ref, as the fractions actions take.
  const target = async (id: string, x?: number, y?: number, ref?: string): Promise<Point> => {
    const { screen, nodes } = await screenOf(id);
    if (ref) {
      const node = actionable(nodes)[Number(ref.replace(/^@?e/, '')) - 1];
      if (!node) {
        throw new ApiError(404, 'NO_SUCH_ELEMENT', `No element ${ref} on screen. Call mobile_list_elements_on_screen again.`);
      }
      return [node.normalized.x + node.normalized.width / 2, node.normalized.y + node.normalized.height / 2];
    }
    if (x === undefined || y === undefined) {
      throw new ApiError(400, 'POINT_REQUIRED', 'Pass x and y, or ref.');
    }
    return [x / screen.width, y / screen.height];
  };

  const act = async (id: string, actions: Action[]): Promise<void> => {
    const results = (await leases.op(p, id, { op: 'actions', actions })).result as { ok: boolean; error?: { message: string } }[];
    const failed = results.find((r) => !r.ok);
    if (failed) {
      throw new ApiError(400, 'ACTION_FAILED', failed.error?.message ?? 'The action failed.');
    }
  };

  server.registerTool(
    'mobile_list_available_devices',
    { description: 'Devices you hold now. Get one with mobile_allocate_remote_device.', inputSchema: {} },
    () =>
      safe(async () => {
        const held = db.leasesOf(p.accountId, 50).filter((l) => l.state === 'active');
        return text(held.map((l) => ({ id: l.id, ...leases.view(l).device })));
      }),
  );

  server.registerTool(
    'mobile_allocate_remote_device',
    {
      description: 'Lease a fresh device from the pool for your exclusive use. Returns its device id. It is wiped when released.',
      inputSchema: {
        platform: z.enum(['ios', 'android']),
        name: z.string().optional().describe('Model, for example "iPhone 17"'),
        version: z.array(z.string()).optional().describe('OS version prefixes; the first is used'),
        wait: z.boolean().optional(),
        timeoutSeconds: z.number().int().positive().optional(),
        purpose: z.string().max(80).optional().describe('What you will do on the device, in a few words, such as "check the login flow". People watching the fleet see it.'),
      },
    },
    ({ platform, name, version, wait, timeoutSeconds, purpose }) =>
      safe(async () => {
        const cls: DeviceClass = { platform: platform === 'ios' ? 'ios-simulator' : 'android-emulator' };
        if (name) {
          cls.model = name;
        }
        if (version?.[0]) {
          cls.os = version[0];
        }
        const lease = leases.create(p, cls, { via: purpose ? `MCP: ${purpose}` : 'MCP' });
        const until = Date.now() + (wait === false ? 0 : (timeoutSeconds ?? 120) * 1000);
        let current = lease;
        while ((current.state === 'queued' || current.state === 'preparing') && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 500));
          current = leases.get(p, lease.id);
        }
        return text({ device: lease.id, state: current.state, ...leases.view(current).device });
      }),
  );

  server.registerTool(
    'mobile_release_remote_device',
    { description: 'Release a device. It is wiped and replaced in the pool.', inputSchema: { device } },
    ({ device: id }) => safe(async () => (leases.release(p, id), text(`Released ${id}.`))),
  );

  server.registerTool(
    'mobile_get_screen_size',
    { description: 'Screen size in the units taps use: points on iOS, pixels on Android.', inputSchema: { device } },
    ({ device: id }) => safe(async () => text((await screenOf(id)).screen)),
  );

  server.registerTool(
    'mobile_list_elements_on_screen',
    { description: 'Elements on screen with a ref (@e1, ...) to tap, their label and frame.', inputSchema: { device, format: z.enum(['text', 'json', 'raw']).optional() } },
    ({ device: id, format }) =>
      safe(async () => {
        const nodes = actionable((await screenOf(id)).nodes).map((n, i) => ({ ref: `@e${i + 1}`, role: n.role, label: n.label, identifier: n.identifier, value: n.value, frame: n.frame }));
        if (format === 'json' || format === 'raw') {
          return text(nodes);
        }
        return text(nodes.map((n) => `${n.ref} ${n.role} "${n.label ?? n.identifier}" at (${Math.round(n.frame.x)}, ${Math.round(n.frame.y)}) ${Math.round(n.frame.width)}x${Math.round(n.frame.height)}`).join('\n') || 'No elements.');
      }),
  );

  const pointArgs = { device, x: z.number().min(0).optional(), y: z.number().min(0).optional(), ref: z.string().optional() };

  server.registerTool(
    'mobile_click_on_screen_at_coordinates',
    { description: 'Tap at x,y or on an element ref.', inputSchema: pointArgs },
    ({ device: id, x, y, ref }) => safe(async () => (await act(id, [{ type: 'tap', point: await target(id, x, y, ref) }]), text('Tapped.'))),
  );

  server.registerTool(
    'mobile_double_tap_on_screen',
    { description: 'Double-tap at x,y or on an element ref.', inputSchema: pointArgs },
    ({ device: id, x, y, ref }) =>
      safe(async () => {
        const point = await target(id, x, y, ref);
        await act(id, [{ type: 'tap', point }, { type: 'tap', point }]);
        return text('Double-tapped.');
      }),
  );

  server.registerTool(
    'mobile_long_press_on_screen_at_coordinates',
    { description: 'Long-press at x,y or on an element ref.', inputSchema: { ...pointArgs, duration: z.number().min(1).max(10_000).optional() } },
    ({ device: id, x, y, ref, duration }) => safe(async () => (await act(id, [{ type: 'longPress', point: await target(id, x, y, ref), durationMs: duration ?? 500 }]), text('Long-pressed.'))),
  );

  server.registerTool(
    'mobile_swipe_on_screen',
    {
      description: 'Swipe in a direction from x,y, or from the center of the screen.',
      inputSchema: { device, direction: z.enum(['up', 'down', 'left', 'right']), x: z.number().min(0).optional(), y: z.number().min(0).optional(), distance: z.number().min(1).optional() },
    },
    ({ device: id, direction, x, y, distance }) =>
      safe(async () => {
        const { screen } = await screenOf(id);
        const from: Point = x !== undefined && y !== undefined ? [x / screen.width, y / screen.height] : [0.5, 0.5];
        const dx = (distance ?? screen.width * 0.4) / screen.width;
        const dy = (distance ?? screen.height * 0.3) / screen.height;
        const clamp = (n: number): number => Math.min(1, Math.max(0, n));
        const vertical = direction === 'up' ? -dy : direction === 'down' ? dy : 0;
        const horizontal = direction === 'left' ? -dx : direction === 'right' ? dx : 0;
        const to: Point = [clamp(from[0] + horizontal), clamp(from[1] + vertical)];
        await act(id, [{ type: 'swipe', from, to, durationMs: 300 }]);
        return text(`Swiped ${direction}.`);
      }),
  );

  server.registerTool(
    'mobile_type_keys',
    { description: 'Type text into the focused element, then press return if submit is true.', inputSchema: { device, text: z.string(), submit: z.boolean().optional() } },
    ({ device: id, text: value, submit }) =>
      safe(async () => {
        const actions: Action[] = [{ type: 'type', text: value }];
        if (submit) {
          actions.push({ type: 'key', key: 'return' });
        }
        await act(id, actions);
        return text('Typed.');
      }),
  );

  server.registerTool(
    'mobile_press_button',
    { description: 'Press HOME, LOCK (or POWER), or ENTER.', inputSchema: { device, button: z.string() } },
    ({ device: id, button }) =>
      safe(async () => {
        const name = button.toUpperCase();
        const actions: Record<string, Action> = {
          HOME: { type: 'button', button: 'home' },
          LOCK: { type: 'button', button: 'lock' },
          POWER: { type: 'button', button: 'lock' },
          ENTER: { type: 'key', key: 'return' },
        };
        const a = actions[name];
        if (!a) {
          throw new ApiError(400, 'UNKNOWN_BUTTON', `Hangar presses HOME, LOCK, POWER and ENTER, not ${button}.`);
        }
        await act(id, [a]);
        return text(`Pressed ${name}.`);
      }),
  );

  server.registerTool(
    'mobile_take_screenshot',
    { description: 'A JPEG screenshot, its longest side at most maxSize pixels (default 1024).', inputSchema: { device, maxSize: z.number().int().positive().optional(), scale: z.number().gt(0).max(1).optional() } },
    ({ device: id, maxSize }) =>
      safe(async () => {
        const shot = await leases.op(p, id, { op: 'screenshot', format: 'jpeg', maxSize: maxSize ?? 1024 });
        return { content: [{ type: 'image', data: shot.binary?.toString('base64') ?? '', mimeType: 'image/jpeg' }] };
      }),
  );

  server.registerTool(
    'mobile_launch_app',
    { description: 'Launch an installed app by bundle id or package name.', inputSchema: { device, packageName: z.string(), locale: z.string().optional() } },
    ({ device: id, packageName, locale }) =>
      safe(async () => {
        if (locale) {
          await leases.op(p, id, { op: 'locale', bundleId: packageName, language: locale.split(',')[0] ?? locale });
        }
        await leases.op(p, id, { op: 'launch', bundleId: packageName });
        return text(`Launched ${packageName}.`);
      }),
  );

  server.registerTool(
    'mobile_terminate_app',
    { description: 'Stop a running app.', inputSchema: { device, packageName: z.string() } },
    ({ device: id, packageName }) => safe(async () => (await leases.op(p, id, { op: 'terminate', bundleId: packageName }), text(`Stopped ${packageName}.`))),
  );

  server.registerTool(
    'mobile_uninstall_app',
    { description: 'Uninstall an app.', inputSchema: { device, packageName: z.string() } },
    ({ device: id, packageName }) => safe(async () => (await leases.op(p, id, { op: 'uninstall', bundleId: packageName }), text(`Uninstalled ${packageName}.`))),
  );

  server.registerTool(
    'mobile_install_app',
    { description: 'Install a build registered on Hangar, by name or sha256. Upload files first with `hangar install` or POST /v1/builds; a path on your machine is not reachable from the fleet.', inputSchema: { device, path: z.string() } },
    ({ device: id, path }) => safe(async () => text(await install(id, path))),
  );

  server.registerTool(
    'mobile_open_url',
    { description: 'Open a URL or deep link.', inputSchema: { device, url: z.string() } },
    ({ device: id, url }) => safe(async () => (await leases.op(p, id, { op: 'openUrl', url }), text(`Opened ${url}.`))),
  );

  server.registerTool(
    'mobile_set_location',
    { description: 'Set the GPS position, or clear it by leaving out both.', inputSchema: { device, latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional() } },
    ({ device: id, latitude, longitude }) =>
      safe(async () => {
        await leases.op(p, id, latitude === undefined || longitude === undefined ? { op: 'clearLocation' } : { op: 'location', lat: latitude, lon: longitude });
        return text(latitude === undefined ? 'Cleared the location.' : `Location set to ${latitude}, ${longitude}.`);
      }),
  );
}
