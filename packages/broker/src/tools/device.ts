import { z } from 'zod';
import { ORIENTATIONS, PRIVACY_SERVICES, type Action, type UiNode } from '@hangar/protocol';
import type { Content, Result, ToolDeps } from './util.ts';

const point = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).describe('[x, y] as fractions of the screen, 0 to 1');
const selector = z
  .object({
    label: z.string().optional(),
    identifier: z.string().optional(),
    role: z.string().optional(),
    exact: z.boolean().optional(),
  })
  .describe('Match an element by label (substring unless exact), accessibility identifier, or role');
const action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tap'), point: point.optional(), element: selector.optional() }),
  z.object({ type: z.literal('longPress'), point, durationMs: z.number().optional() }),
  z.object({ type: z.literal('swipe'), from: point, to: point, durationMs: z.number().optional() }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({ type: z.literal('key'), key: z.string().describe('return, backspace, tab, escape, up, down, left, right') }),
  z.object({ type: z.literal('button'), button: z.enum(['home', 'lock', 'siri']) }),
  z.object({ type: z.literal('waitFor'), element: selector, gone: z.boolean().optional(), timeoutMs: z.number().optional() }),
]);

export function registerDeviceTools({ server, p, leases, pick, safe, text, install }: ToolDeps): void {
  const observe = async (id: string): Promise<Result> => {
    const ui = (await leases.op(p, id, { op: 'describe' })).result as { nodes: UiNode[] };
    const shot = await leases.op(p, id, { op: 'screenshot', format: 'jpeg', maxSize: 1000 });
    const elements = ui.nodes
      .filter((n) => n.role !== 'application' && (n.label || n.identifier))
      .map((n) => ({ role: n.role, label: n.label, identifier: n.identifier, value: n.value, enabled: n.enabled, center: [round(n.normalized.x + n.normalized.width / 2), round(n.normalized.y + n.normalized.height / 2)] }));
    return {
      content: [
        { type: 'image', data: shot.binary?.toString('base64') ?? '', mimeType: 'image/jpeg' },
        { type: 'text', text: JSON.stringify({ elements }, null, 1) },
      ],
    };
  };

  server.registerTool(
    'observe',
    { description: 'Screenshot plus the elements on screen, each with a center point you can tap.', inputSchema: { leaseId: z.string().optional() } },
    ({ leaseId }) => safe(() => observe(pick(leaseId))),
  );

  server.registerTool(
    'act',
    {
      description: 'Run input actions in order: tap (by element or point), longPress, swipe, type, key, button, waitFor. Returns a fresh observation unless observe is false.',
      inputSchema: { leaseId: z.string().optional(), actions: z.array(action).min(1), observe: z.boolean().optional() },
    },
    ({ leaseId, actions, observe: shouldObserve }) =>
      safe(async () => {
        const id = pick(leaseId);
        const { result } = await leases.op(p, id, { op: 'actions', actions: actions as Action[] });
        const results = result as { ok: boolean; error?: { message: string } }[];
        const failed = results.find((r) => !r.ok);
        const summary: Content = { type: 'text', text: failed ? `Stopped at action ${results.indexOf(failed) + 1}: ${failed.error?.message}` : `Ran ${results.length} action(s).` };
        if (shouldObserve === false) {
          return { content: [summary], ...(failed ? { isError: true } : {}) };
        }
        const obs = await observe(id);
        return { content: [summary, ...obs.content], ...(failed ? { isError: true } : {}) };
      }),
  );

  server.registerTool(
    'install_build',
    { description: 'Install a registered build (uploaded by CI or an operator) by name or sha256.', inputSchema: { build: z.string(), leaseId: z.string().optional() } },
    ({ build, leaseId }) => safe(async () => text(await install(pick(leaseId), build))),
  );

  server.registerTool(
    'launch_app',
    { description: 'Launch an installed app by bundle id.', inputSchema: { bundleId: z.string(), leaseId: z.string().optional() } },
    ({ bundleId, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'launch', bundleId }), text(`Launched ${bundleId}.`))),
  );

  server.registerTool(
    'terminate_app',
    { description: 'Stop a running app by bundle id.', inputSchema: { bundleId: z.string(), leaseId: z.string().optional() } },
    ({ bundleId, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'terminate', bundleId }), text(`Stopped ${bundleId}.`))),
  );

  server.registerTool(
    'open_url',
    { description: 'Open a URL or deep link on the device.', inputSchema: { url: z.string(), leaseId: z.string().optional() } },
    ({ url, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'openUrl', url }), text(`Opened ${url}.`))),
  );

  server.registerTool(
    'react_native',
    { description: 'In a React Native debug build: open the dev menu, or reload the JavaScript bundle.', inputSchema: { action: z.enum(['devMenu', 'reload']), leaseId: z.string().optional() } },
    ({ action, leaseId }) =>
      safe(async () => {
        await leases.op(p, pick(leaseId), { op: 'actions', actions: [{ type: 'key', key: action === 'reload' ? 'r' : 'd', modifiers: ['command'] }] });
        return text(action === 'reload' ? 'Reloaded the bundle.' : 'Opened the dev menu.');
      }),
  );

  server.registerTool(
    'send_push',
    {
      description: 'Deliver a simulated remote notification to an app. payload is APNs JSON, for example {"aps":{"alert":{"title":"Hi","body":"There"}}}.',
      inputSchema: { bundleId: z.string(), payload: z.record(z.string(), z.unknown()), leaseId: z.string().optional() },
    },
    ({ bundleId, payload, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'push', bundleId, payload }), text(`Sent a push to ${bundleId}.`))),
  );

  server.registerTool(
    'set_permission',
    {
      description: 'Grant, revoke or reset a privacy permission for an app without the system prompt, so a flow can test both answers.',
      inputSchema: { bundleId: z.string(), service: z.enum(PRIVACY_SERVICES), action: z.enum(['grant', 'revoke', 'reset']), leaseId: z.string().optional() },
    },
    ({ bundleId, service, action, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'permission', bundleId, service, action }), text(`${action} ${service} for ${bundleId}: done.`))),
  );

  server.registerTool(
    'set_location',
    { description: 'Set the GPS position the device reports, or clear it by leaving out lat and lon.', inputSchema: { lat: z.number().optional(), lon: z.number().optional(), leaseId: z.string().optional() } },
    ({ lat, lon, leaseId }) =>
      safe(async () => {
        await leases.op(p, pick(leaseId), lat === undefined || lon === undefined ? { op: 'clearLocation' } : { op: 'location', lat, lon });
        return text(lat === undefined ? 'Cleared the location.' : `Location set to ${lat}, ${lon}.`);
      }),
  );

  server.registerTool(
    'set_appearance',
    { description: 'Switch the device between light and dark mode.', inputSchema: { mode: z.enum(['light', 'dark']), leaseId: z.string().optional() } },
    ({ mode, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'appearance', mode }), text(`Appearance is ${mode}.`))),
  );

  server.registerTool(
    'set_app_language',
    { description: 'Set the language and region one app uses from its next launch, for example nb-NO or en-US. Relaunch the app afterwards.', inputSchema: { bundleId: z.string(), language: z.string(), leaseId: z.string().optional() } },
    ({ bundleId, language, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'locale', bundleId, language }), text(`${bundleId} uses ${language} from its next launch.`))),
  );

  const cursor = {
    bundleId: z.string().optional().describe('The app; defaults to the last app installed or launched through Hangar'),
    since: z.number().int().min(0).optional().describe('The `next` of the previous call, to get only newer entries'),
    limit: z.number().int().min(1).max(1000).optional(),
    leaseId: z.string().optional(),
  };

  server.registerTool(
    'app_log',
    { description: "The app's own log lines (os_log on iOS, logcat for its pid on Android), newest last. Pass `since` from the previous answer to get only new lines.", inputSchema: cursor },
    ({ leaseId, ...o }) => safe(async () => text((await leases.op(p, pick(leaseId), { op: 'appLog', ...o })).result)),
  );

  server.registerTool(
    'js_evaluate',
    {
      description: "Evaluate a JavaScript expression in the React Native app through Metro's debugger and return its value as JSON. Needs the Metro tunnel that `hangar run` opens.",
      inputSchema: { expression: z.string().min(1).max(100_000), bundleId: z.string().optional(), leaseId: z.string().optional() },
    },
    ({ expression, bundleId, leaseId }) => safe(async () => text((await leases.op(p, pick(leaseId), { op: 'jsEvaluate', expression, ...(bundleId ? { bundleId } : {}) })).result)),
  );

  server.registerTool(
    'js_console',
    { description: "Console messages and uncaught exceptions from the React Native app's JavaScript, collected from the first JavaScript call on this lease.", inputSchema: cursor },
    ({ leaseId, ...o }) => safe(async () => text((await leases.op(p, pick(leaseId), { op: 'jsConsole', ...o })).result)),
  );

  server.registerTool(
    'network_requests',
    { description: "HTTP requests the React Native app made: method, URL, status, time. Uses the debugger's Network domain when the runtime has one, else a patch of XMLHttpRequest; either way only requests after the first JavaScript call on this lease.", inputSchema: cursor },
    ({ leaseId, ...o }) => safe(async () => text((await leases.op(p, pick(leaseId), { op: 'network', ...o })).result)),
  );

  server.registerTool(
    'set_orientation',
    { description: 'Rotate the device. Works on Android emulators; iOS simulators answer UNSUPPORTED.', inputSchema: { orientation: z.enum(ORIENTATIONS), leaseId: z.string().optional() } },
    ({ orientation, leaseId }) => safe(async () => (await leases.op(p, pick(leaseId), { op: 'orientation', orientation }), text(`Orientation is ${orientation}.`))),
  );
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
