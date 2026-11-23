import type { LeaseLimits, LimitRole, TokenLimits } from '@devicepool/protocol';
import { DEFAULTS } from './machine.ts';

export type Limits = { idleMs: number; maxMs: number; graceMs: number };
export type Overrides = Partial<Record<LimitRole, Partial<Limits>>>;
export type Ask = { idleMs?: number | null; maxMs?: number | null; graceMs?: number | null };

export const LIMIT_ROLES: LimitRole[] = ['member', 'operator', 'agent'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TOKEN_DEFAULTS: Limits = { idleMs: DEFAULTS.idleMs, maxMs: DEFAULTS.maxMs, graceMs: 60_000 };

export const DEFAULT_CAPS: Record<LimitRole, Limits> = {
  member: { idleMs: 2 * HOUR, maxMs: 12 * HOUR, graceMs: 10 * MINUTE },
  operator: { idleMs: 2 * HOUR, maxMs: 12 * HOUR, graceMs: 10 * MINUTE },
  agent: { idleMs: 2 * HOUR, maxMs: 8 * HOUR, graceMs: 10 * MINUTE },
};

export function isLimitRole(value: unknown): value is LimitRole {
  return LIMIT_ROLES.some((r) => r === value);
}

export function roleOf(accountRole: 'member' | 'operator', agent: boolean): LimitRole {
  return agent ? 'agent' : accountRole;
}

export function capFor(role: LimitRole, overrides: Overrides): Limits {
  return { ...DEFAULT_CAPS[role], ...stripUnset(overrides[role] ?? {}) };
}

export function tokenLimits(ask: Ask, cap: Limits, agent = false): TokenLimits {
  return {
    agent,
    idleMs: Math.min(ask.idleMs ?? TOKEN_DEFAULTS.idleMs, cap.idleMs),
    maxMs: Math.min(ask.maxMs ?? TOKEN_DEFAULTS.maxMs, cap.maxMs),
    graceMs: Math.min(ask.graceMs ?? TOKEN_DEFAULTS.graceMs, cap.graceMs),
  };
}

export type LeaseAsk = { idleMs?: number; maxMs?: number; ttlMs?: number | null };

export type Resolved = { ok: true; limits: LeaseLimits } | { ok: false; field: 'idle' | 'max'; allowedMs: number };

export function leaseLimits(token: TokenLimits, ask: LeaseAsk): Resolved {
  if (ask.idleMs !== undefined && ask.idleMs > token.idleMs) {
    return { ok: false, field: 'idle', allowedMs: token.idleMs };
  }
  if (ask.maxMs !== undefined && ask.maxMs > token.maxMs) {
    return { ok: false, field: 'max', allowedMs: token.maxMs };
  }
  const idleMs = ask.idleMs ?? token.idleMs;
  const maxMs = ask.maxMs ?? token.maxMs;
  const ttl = ask.ttlMs === undefined ? (token.agent ? null : DEFAULTS.ttlMs) : ask.ttlMs;
  return { ok: true, limits: { idleMs, maxMs, ttlMs: ttl ?? maxMs, graceMs: token.graceMs } };
}

function stripUnset(limits: Partial<Limits>): Partial<Limits> {
  const out: Partial<Limits> = {};
  if (limits.idleMs !== undefined) {
    out.idleMs = limits.idleMs;
  }
  if (limits.maxMs !== undefined) {
    out.maxMs = limits.maxMs;
  }
  if (limits.graceMs !== undefined) {
    out.graceMs = limits.graceMs;
  }
  return out;
}

export type Caps = { maxLeasesPerAccount: number; maxShards: number };

export const DEFAULT_CAPS_PER_ACCOUNT: Caps = { maxLeasesPerAccount: 50, maxShards: 50 };

export function capsFromEnv(env: Record<string, string | undefined>): Caps {
  const whole = (value: string | undefined, fallback: number): number => {
    const n = Number(value);
    return value !== undefined && Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    maxLeasesPerAccount: whole(env.DEVICEPOOL_MAX_LEASES_PER_ACCOUNT, DEFAULT_CAPS_PER_ACCOUNT.maxLeasesPerAccount),
    maxShards: whole(env.DEVICEPOOL_MAX_SHARDS, DEFAULT_CAPS_PER_ACCOUNT.maxShards),
  };
}
