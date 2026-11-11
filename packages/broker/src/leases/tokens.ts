import type { LimitRole, Priority, TokenLimits } from '@hangar/protocol';
import * as auth from '../auth.ts';
import type { Db, TokenPriorityRow } from '../db.ts';
import { capFor, isLimitRole, roleOf, tokenLimits, type Ask, type Limits, type Overrides } from './limits.ts';
import { ApiError } from './service.ts';

export function overrides(db: Db): Overrides {
  const out: Overrides = {};
  for (const row of db.leaseLimitCaps()) {
    if (isLimitRole(row.role)) {
      out[row.role] = {
        ...(row.idleMs !== null ? { idleMs: row.idleMs } : {}),
        ...(row.maxMs !== null ? { maxMs: row.maxMs } : {}),
        ...(row.graceMs !== null ? { graceMs: row.graceMs } : {}),
      };
    }
  }
  return out;
}

export function caps(db: Db): Record<LimitRole, Limits> {
  const o = overrides(db);
  return { member: capFor('member', o), operator: capFor('operator', o), agent: capFor('agent', o) };
}

// What a principal's leases may have now: the token's own limits, under today's cap for its role.
export function limitsOf(db: Db, p: auth.Principal): TokenLimits {
  const agent = p.token?.agent ?? false;
  return tokenLimits(p.token ?? {}, capFor(roleOf(p.role, agent), overrides(db)), agent);
}

export type TokenRequest = { label?: unknown; scopes?: unknown; agent?: unknown; idleSeconds?: unknown; maxSeconds?: unknown; graceSeconds?: unknown; priority?: unknown };

// The priority a principal's leases get, and the booking they lease from. Without a token row, interactive.
export function priorityOf(db: Db, p: auth.Principal): TokenPriorityRow {
  return (p.token ? db.tokenPriority(p.token.hash) : null) ?? { priority: 'interactive', bookingId: null };
}

export function mintMemberToken(db: Db, p: auth.Principal, b: TokenRequest, bookingId: string | null = null): { token: string; limits: TokenLimits; priority: Priority } {
  if (b.priority !== undefined && b.priority !== 'ci' && b.priority !== 'interactive') {
    throw new ApiError(400, 'BAD_PRIORITY', '`priority` is "ci" or "interactive".', 'A token for a booking comes from POST /v1/bookings/:name/tokens, or `hangar connect <booking>`.');
  }
  const priority: Priority = bookingId ? 'booked' : b.priority === 'ci' ? 'ci' : 'interactive';
  const minted = mintPlainToken(db, p, b);
  if (priority !== 'interactive') {
    db.setTokenPriority(auth.sha256(minted.token), { priority, bookingId });
  }
  return { ...minted, priority };
}

function mintPlainToken(db: Db, p: auth.Principal, b: TokenRequest): { token: string; limits: TokenLimits } {
  const scopes = Array.isArray(b.scopes) ? b.scopes.filter((s) => s === 'install:upload') : [];
  if (scopes.length && p.role !== 'operator') {
    throw new ApiError(403, 'FORBIDDEN', 'Only operators can make tokens that upload apps.');
  }
  const agent = b.agent === true;
  const ask: Ask = { idleMs: seconds(b.idleSeconds, 'idleSeconds'), maxMs: seconds(b.maxSeconds, 'maxSeconds'), graceMs: seconds(b.graceSeconds, 'graceSeconds') };
  const limits = tokenLimits(ask, capFor(roleOf(p.role, agent), overrides(db)), agent);
  const token = auth.mintToken(db, 'member', { accountId: p.accountId, label: typeof b.label === 'string' ? b.label : null, scopes });
  const asked = ask.idleMs !== null || ask.maxMs !== null || ask.graceMs !== null;
  if (agent || asked) {
    db.setTokenLimits(auth.sha256(token), {
      agent,
      idleMs: ask.idleMs === null ? null : limits.idleMs,
      maxMs: ask.maxMs === null ? null : limits.maxMs,
      graceMs: ask.graceMs === null ? null : limits.graceMs,
    });
  }
  return { token, limits };
}

// A positive whole number of seconds as milliseconds, or null when left out.
export function seconds(value: unknown, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new ApiError(400, 'BAD_LIMIT', `\`${field}\` must be a positive number of seconds.`);
  }
  return Math.round(value * 1000);
}
