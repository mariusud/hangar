import { after, test } from 'node:test';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import type { Night } from '@hangar/protocol';
import { Hangar } from './client/index.ts';
import { postToSlack, resolveNight, slackText, slackWebhook } from './night.ts';

const night: Night = { id: '0b5c7a52-5a3e-4d8e-9a43-0a8e5b1d2c3f', booking: 'nightly', team: 'Mobile', state: 'closed', openedAt: 1, closedAt: 2, openedBy: 'ci', closedBy: 'ci', url: 'http://h/r' };

test('resolveNight takes a night id as is and a booking name as its newest night', async () => {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    asked.push(path);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(path.startsWith('/v1/nights?') ? (path.includes('empty') ? [] : [night]) : night));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = new Hangar({ url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, token: 't' });
  after(() => server.close());
  assert.equal((await resolveNight(client, night.id)).id, night.id);
  assert.equal((await resolveNight(client, 'nightly', 'open')).id, night.id);
  assert.deepEqual(asked, [`/v1/nights/${night.id}`, '/v1/nights?booking=nightly&state=open']);
  await assert.rejects(resolveNight(client, 'empty'), /No night for the booking "empty"/);
});

test('slackText turns headings bold and cuts a long report with a link to the whole one', () => {
  assert.equal(slackText('# nightly: night report\n\n### [high] Crash\ntext', 'http://h/r'), '*nightly: night report*\n\n*[high] Crash*\ntext');
  const long = slackText('x'.repeat(50_000), 'http://h/r');
  assert.ok(long.length < 40_000);
  assert.match(long, /The whole report: http:\/\/h\/r$/);
});

test('the Slack webhook must be https, and a refusal is an error', async () => {
  assert.throws(() => slackWebhook('http://hooks.example/x'), /https/);
  assert.throws(() => slackWebhook('not a url'), /https URL/);
  const sent: { url: string; body: string }[] = [];
  const ok: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), body: String(init?.body) });
    return new Response('ok');
  };
  await postToSlack(slackWebhook('https://hooks.example/x'), 'hello', ok);
  assert.deepEqual(sent, [{ url: 'https://hooks.example/x', body: '{"text":"hello"}' }]);
  const refused: typeof fetch = async () => new Response('invalid_token', { status: 403 });
  await assert.rejects(postToSlack(slackWebhook('https://hooks.example/x'), 'hello', refused), /HTTP 403\): invalid_token/);
});
