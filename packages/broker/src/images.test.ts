import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION, type BrokerMessage, type DeviceImage } from '@hangar/protocol';
import * as auth from './auth.ts';
import { imageId, parseImageSetup } from './images.ts';
import { startBroker } from './index.ts';
import { ApiError } from './leases/service.ts';

const FLOW = 'appId: com.example.app\n---\n- launchApp\n- inputText: ${USER_EMAIL}\n';

test('an image keeps its id until its declaration changes', () => {
  const spec = { name: 'Signed-In', apps: ['abc'] };
  const plain = imageId(spec);
  assert.equal(imageId(spec, {}), plain, 'images without a setup keep the id they had before setups existed');
  assert.equal(imageId({ ...spec, name: 'signed-in' }), plain);
  const withGrants = imageId(spec, { grants: ['photos'] });
  const withFlow = imageId(spec, { signIn: { flow: FLOW, env: ['USER_EMAIL'] } });
  assert.notEqual(withGrants, plain);
  assert.notEqual(withFlow, plain);
  assert.notEqual(imageId(spec, { grants: ['photos', 'location'] }), withGrants);
  assert.notEqual(imageId(spec, { signIn: { flow: `${FLOW}- tapOn: Next\n`, env: ['USER_EMAIL'] } }), withFlow);
  assert.notEqual(imageId(spec, { signIn: { flow: FLOW, env: ['USER_EMAIL', 'USER_PASSWORD'] } }), withFlow);
  assert.equal(imageId(spec, parseImageSetup({ grants: ['photos', 'photos'] })), withGrants);
});

test('a setup declaration is checked and normalized', () => {
  assert.deepEqual(parseImageSetup({}), {});
  assert.deepEqual(parseImageSetup({ grants: [] }), {});
  assert.deepEqual(parseImageSetup({ grants: ['photos', 'location', 'photos'] }), { grants: ['location', 'photos'] });
  assert.deepEqual(parseImageSetup({ signIn: { flow: FLOW, env: ['B', 'A'] } }), { signIn: { flow: FLOW, env: ['A', 'B'] } });
  assert.deepEqual(parseImageSetup({ signIn: { flow: FLOW } }), { signIn: { flow: FLOW, env: [] } });
  const code = (input: { grants?: unknown; signIn?: unknown }): string => {
    try {
      parseImageSetup(input);
    } catch (err) {
      assert.ok(err instanceof ApiError);
      return err.code;
    }
    return 'OK';
  };
  assert.equal(code({ grants: ['camera'] }), 'BAD_GRANT');
  assert.equal(code({ grants: ['bluetooth'] }), 'BAD_GRANT');
  assert.equal(code({ grants: 'photos' }), 'BAD_GRANTS');
  assert.equal(code({ signIn: { flow: '  ' } }), 'BAD_SIGN_IN');
  assert.equal(code({ signIn: 'flow.yaml' }), 'BAD_SIGN_IN');
  assert.equal(code({ signIn: { flow: 'x'.repeat(65 * 1024) } }), 'BAD_SIGN_IN');
  assert.equal(code({ signIn: { flow: FLOW, env: { USER_EMAIL: 'me@example.com' } } }), 'BAD_SIGN_IN');
  assert.equal(code({ signIn: { flow: FLOW, env: ['USER EMAIL'] } }), 'BAD_ENV_NAME');
  assert.equal(code({ signIn: { flow: FLOW, env: ['USER=me'] } }), 'BAD_ENV_NAME');
});

test('a signed-in image sends its flow and secrets to hosts, and the API returns neither', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-images-test-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  try {
    const messages: BrokerMessage[] = [];
    const handlers = broker.attach({ send: (m) => messages.push(m), close: () => {} });
    handlers.message({ type: 'hello', protocol: PROTOCOL_VERSION, hostName: 'fake-mac', versions: {}, memoryBytes: 0, offers: [{ model: 'iPhone 17', os: '26.5' }], devices: [], leases: [] });
    const op = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'ops', 'operator').id });
    const qa = auth.mintToken(broker.db, 'member', { accountId: auth.createAccount(broker.db, 'qa', 'member').id });
    broker.db.insertBuild('abc123', 'App.app', join(dir, 'nothing'), 1);
    const call = async (token: string, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
      const res = await fetch(`${broker.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, text: await res.text() };
    };
    const lastImages = (): DeviceImage[] => {
      const m = messages.filter((x) => x.type === 'images').at(-1);
      assert.ok(m?.type === 'images');
      return m.images;
    };

    assert.equal((await call(qa, 'PUT', '/v1/image-secrets/USER_PASSWORD', { value: 'hunter2' })).status, 403);
    assert.equal((await call(op, 'PUT', '/v1/image-secrets/BAD-NAME', { value: 'x' })).status, 400);
    assert.equal((await call(op, 'PUT', '/v1/image-secrets/USER_PASSWORD', { value: 'hunter2' })).status, 204);
    assert.equal((await call(op, 'PUT', '/v1/images/signed-in', { grants: ['photos'] })).status, 400, 'grants need an app to grant to');
    assert.equal((await call(op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'], grants: ['camera'] })).status, 400);

    const declared = await call(op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'], grants: ['photos', 'location'], signIn: { flow: FLOW, env: ['USER_EMAIL', 'USER_PASSWORD'] } });
    assert.equal(declared.status, 200);
    const image = lastImages()[0];
    assert.deepEqual(image?.setup, { grants: ['location', 'photos'], signIn: { flow: FLOW, env: ['USER_EMAIL', 'USER_PASSWORD'], values: { USER_PASSWORD: 'hunter2' } } });

    const listed = await call(qa, 'GET', '/v1/images');
    const secrets = await call(op, 'GET', '/v1/image-secrets');
    for (const r of [declared, listed, secrets]) {
      assert.doesNotMatch(r.text, /hunter2/);
    }
    assert.doesNotMatch(listed.text, /inputText/, 'the list shows the flow by its hash');
    const row = JSON.parse(listed.text)[0];
    assert.equal(row.id, image?.id);
    assert.deepEqual(row.grants, ['location', 'photos']);
    assert.deepEqual(row.signIn.env, ['USER_EMAIL', 'USER_PASSWORD']);
    assert.match(row.signIn.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(secrets.text).map((s: { name: string }) => s.name), ['USER_PASSWORD']);

    assert.equal((await call(op, 'PUT', '/v1/image-secrets/USER_EMAIL', { value: 'qa@example.com' })).status, 204);
    assert.equal(lastImages()[0]?.id, image?.id, 'a new secret value does not rebuild the image');
    assert.deepEqual(lastImages()[0]?.setup?.signIn?.values, { USER_EMAIL: 'qa@example.com', USER_PASSWORD: 'hunter2' });

    assert.equal((await call(op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'] })).status, 200);
    assert.notEqual(lastImages()[0]?.id, image?.id, 'dropping the sign-in rebuilds the image');
    assert.equal(lastImages()[0]?.setup, undefined);

    assert.equal((await call(op, 'PUT', '/v1/images/signed-in', { apps: ['App.app'], signIn: { flow: FLOW } })).status, 200);
    assert.equal((await call(op, 'DELETE', '/v1/images/signed-in')).status, 204);
    assert.equal(broker.db.imageSetup('signed-in'), null, 'removing an image removes its setup');
    assert.equal((await call(op, 'DELETE', '/v1/image-secrets/USER_EMAIL')).status, 204);
    assert.equal((await call(op, 'DELETE', '/v1/image-secrets/USER_EMAIL')).status, 404);
  } finally {
    await broker.close();
    await rm(dir, { recursive: true, force: true });
  }
});
