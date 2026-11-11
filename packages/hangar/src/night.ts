import { parseArgs } from 'node:util';
import type { Night } from '@hangar/protocol';
import { Hangar, HangarError } from './client/index.ts';

export const NIGHT_HELP = `Nights
  hangar night open <booking>              start a night for a booking: its leases, findings and runs
  hangar night close <booking | night-id>  end it
  hangar night list [--booking NAME]       recent nights
  hangar night report <booking | night-id> [--format md|json] [--slack-webhook URL]
                                           print the night's report; --slack-webhook posts it
                                           from this machine (Hangar itself never does)`;

const SLACK_LIMIT = 39_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A night id as is, or the newest night of the booking with that name.
export async function resolveNight(client: Hangar, ref: string, state?: 'open'): Promise<Night> {
  if (ID.test(ref)) {
    return client.json<Night>('GET', `/v1/nights/${ref}`);
  }
  const nights = await client.json<Night[]>('GET', `/v1/nights?booking=${encodeURIComponent(ref)}${state ? `&state=${state}` : ''}`);
  const night = nights[0];
  if (!night) {
    throw new HangarError(404, 'NIGHT_NOT_FOUND', `No ${state ? 'open ' : ''}night for the booking "${ref}".`, 'Start one with `hangar night open <booking>`.');
  }
  return night;
}

// Slack's message format: bold instead of headings, and a length it accepts.
export function slackText(markdown: string, reportUrl: string): string {
  const text = markdown
    .split('\n')
    .map((line) => line.replace(/^#{1,6} (.*)$/, '*$1*'))
    .join('\n');
  if (text.length <= SLACK_LIMIT) {
    return text;
  }
  return `${text.slice(0, SLACK_LIMIT)}\n\nThe report is longer than Slack allows. The whole report: ${reportUrl}`;
}

export function slackWebhook(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HangarError(0, 'USAGE', '--slack-webhook takes the https URL of a Slack incoming webhook.');
  }
  if (url.protocol !== 'https:') {
    throw new HangarError(0, 'USAGE', '--slack-webhook takes an https URL.');
  }
  return url;
}

export async function postToSlack(webhook: URL, text: string, send: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await send(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (err) {
    throw new HangarError(0, 'SLACK_UNREACHABLE', `Could not reach the Slack webhook: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new HangarError(res.status, 'SLACK_REFUSED', `Slack refused the report (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export async function nightCommand(args: string[], client?: Hangar): Promise<void> {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { format: { type: 'string' }, 'slack-webhook': { type: 'string' }, booking: { type: 'string' } } });
  const ref = positionals[0];
  if (sub === 'list') {
    const c = client ?? (await Hangar.fromEnv());
    const nights = await c.json<Night[]>('GET', `/v1/nights${values.booking ? `?booking=${encodeURIComponent(values.booking)}` : ''}`);
    for (const n of nights) {
      console.log(`${n.id}  ${n.booking.padEnd(20)} ${n.state.padEnd(7)} ${new Date(n.openedAt).toISOString()}${n.closedAt ? ` to ${new Date(n.closedAt).toISOString()}` : ''}`);
    }
    if (!nights.length) {
      console.log('No nights yet. Start one with `hangar night open <booking>`.');
    }
    return;
  }
  if ((sub !== 'open' && sub !== 'close' && sub !== 'report') || !ref) {
    throw new HangarError(0, 'USAGE', `Usage:\n${NIGHT_HELP}`);
  }
  const format = values.format ?? 'md';
  if (format !== 'md' && format !== 'json') {
    throw new HangarError(0, 'USAGE', '--format is md or json.');
  }
  const webhook = values['slack-webhook'] ? slackWebhook(values['slack-webhook']) : null;
  const c = client ?? (await Hangar.fromEnv());
  if (sub === 'open') {
    const night = await c.json<Night>('POST', '/v1/nights', { booking: ref });
    console.log(`Night ${night.id} for ${night.booking} is open. Close it with \`hangar night close ${night.booking}\`.`);
    return;
  }
  if (sub === 'close') {
    const night = await c.json<Night>('POST', `/v1/nights/${(await resolveNight(c, ref, ID.test(ref) ? undefined : 'open')).id}/close`);
    console.log(`Night ${night.id} for ${night.booking} is closed. Its report: ${night.url}`);
    return;
  }
  const night = await resolveNight(c, ref);
  const body = await (await c.request('GET', `/v1/nights/${night.id}/report?format=${format}`)).text();
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
  if (webhook) {
    const markdown = format === 'md' ? body : await (await c.request('GET', `/v1/nights/${night.id}/report?format=md`)).text();
    await postToSlack(webhook, slackText(markdown, night.url));
    console.error('Posted the report to Slack.');
  }
}
