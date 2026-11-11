import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capFor, DEFAULT_CAPS, leaseLimits, roleOf, TOKEN_DEFAULTS, tokenLimits } from './limits.ts';
import { DEFAULTS } from './machine.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

test('a token that asks for nothing keeps the limits leases always had', () => {
  const t = tokenLimits({}, capFor('member', {}));
  assert.deepEqual(t, { agent: false, idleMs: 5 * MIN, maxMs: 4 * HOUR, graceMs: 60_000 });
  const r = leaseLimits(t, {});
  assert.deepEqual(r, { ok: true, limits: { idleMs: 5 * MIN, maxMs: 4 * HOUR, ttlMs: DEFAULTS.ttlMs, graceMs: 60_000 } });
});

test('agent tokens are capped at 8 hours by default, and the operator can lower any cap', () => {
  assert.equal(DEFAULT_CAPS.agent.maxMs, 8 * HOUR);
  const agent = tokenLimits({ idleMs: 30 * MIN, maxMs: 24 * HOUR }, capFor(roleOf('member', true), {}), true);
  assert.deepEqual(agent, { agent: true, idleMs: 30 * MIN, maxMs: 8 * HOUR, graceMs: TOKEN_DEFAULTS.graceMs });
  const lowered = capFor('agent', { agent: { idleMs: 10 * MIN } });
  assert.deepEqual(lowered, { ...DEFAULT_CAPS.agent, idleMs: 10 * MIN });
  assert.equal(tokenLimits({ idleMs: 30 * MIN }, lowered, true).idleMs, 10 * MIN);
  assert.equal(tokenLimits({}, capFor('member', { member: { idleMs: MIN } })).idleMs, MIN, 'a cap below the default lowers the default');
});

test('a lease may ask for less than its token allows, never more', () => {
  const t = tokenLimits({ idleMs: 30 * MIN, maxMs: 8 * HOUR }, DEFAULT_CAPS.agent, true);
  const less = leaseLimits(t, { idleMs: 10 * MIN, maxMs: HOUR });
  assert.deepEqual(less, { ok: true, limits: { idleMs: 10 * MIN, maxMs: HOUR, ttlMs: HOUR, graceMs: 60_000 } });
  assert.deepEqual(leaseLimits(t, { idleMs: 31 * MIN }), { ok: false, field: 'idle', allowedMs: 30 * MIN });
  assert.deepEqual(leaseLimits(t, { maxMs: 9 * HOUR }), { ok: false, field: 'max', allowedMs: 8 * HOUR });
});

test('an agent lease has no ttl unless it asks for one; a person lease keeps the 10 minute ttl', () => {
  const agent = tokenLimits({}, DEFAULT_CAPS.agent, true);
  const a = leaseLimits(agent, {});
  assert.ok(a.ok && a.limits.ttlMs === a.limits.maxMs);
  const b = leaseLimits(agent, { ttlMs: 120_000 });
  assert.ok(b.ok && b.limits.ttlMs === 120_000);
  const person = tokenLimits({}, DEFAULT_CAPS.member);
  const c = leaseLimits(person, { ttlMs: null });
  assert.ok(c.ok && c.limits.ttlMs === c.limits.maxMs, 'null asks for no ttl');
});

test('property: a token never allows more than its cap, and a lease never more than its token', () => {
  let seed = 3;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const maybe = (n: number): number | undefined => (rand(3) === 0 ? undefined : 1 + rand(n));
  for (let i = 0; i < 1000; i++) {
    const cap = { idleMs: 1 + rand(10 * HOUR), maxMs: 1 + rand(24 * HOUR), graceMs: 1 + rand(HOUR) };
    const t = tokenLimits({ idleMs: maybe(10 * HOUR) ?? null, maxMs: maybe(24 * HOUR) ?? null, graceMs: maybe(HOUR) ?? null }, cap, rand(2) === 0);
    assert.ok(t.idleMs <= cap.idleMs && t.maxMs <= cap.maxMs && t.graceMs <= cap.graceMs);
    const idleMs = maybe(10 * HOUR);
    const maxMs = maybe(24 * HOUR);
    const r = leaseLimits(t, { ...(idleMs ? { idleMs } : {}), ...(maxMs ? { maxMs } : {}) });
    if (r.ok) {
      assert.ok(r.limits.idleMs <= t.idleMs && r.limits.maxMs <= t.maxMs && r.limits.graceMs === t.graceMs);
    } else {
      assert.ok((idleMs ?? 0) > t.idleMs || (maxMs ?? 0) > t.maxMs);
    }
  }
});
