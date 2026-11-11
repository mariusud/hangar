// Pure helpers for app.js, kept apart so node can test them without a browser.

export function deviceRows(devices, image) {
  const rows = new Map();
  for (const d of devices) {
    if ((d.image ?? null) !== (image ?? null)) continue;
    const key = `${d.platform}|${d.model}|${d.os}`;
    const row = rows.get(key) ?? { platform: d.platform, model: d.model, os: d.os, host: d.host, free: 0, total: 0 };
    row.total += 1;
    if (d.state === 'ready') row.free += 1;
    rows.set(key, row);
  }
  return [...rows.values()];
}

export function leaseClass(row, image) {
  const cls = {};
  if (row) {
    cls.platform = row.platform;
    cls.model = row.model;
    cls.os = row.os;
  }
  if (image) cls.image = image;
  return cls;
}

export function withView(path, view) {
  if (!view) return path;
  return `${path}${path.includes('?') ? '&' : '?'}view=${encodeURIComponent(view)}`;
}

export function viewExpiry(view) {
  const m = /^(\d{1,15})\./.exec(view ?? '');
  return m ? Number(m[1]) : null;
}

export const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['nb-NO', 'Norwegian Bokmål'],
  ['sv-SE', 'Swedish'],
  ['da-DK', 'Danish'],
  ['de-DE', 'German'],
  ['fr-FR', 'French'],
  ['es-ES', 'Spanish'],
  ['pt-BR', 'Portuguese (Brazil)'],
  ['ja-JP', 'Japanese'],
  ['zh-Hans-CN', 'Chinese (Simplified)'],
  ['ar-SA', 'Arabic'],
];

export function isLanguageTag(tag) {
  return /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/.test(tag);
}

// "5 minutes", "2 hours", "1 hour 30 minutes".
export function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (hours === 0) return unit(rest, 'minute');
  return rest ? `${unit(hours, 'hour')} ${unit(rest, 'minute')}` : unit(hours, 'hour');
}

export function limitsText(limits) {
  return `Yours until you release it, leave it idle for ${duration(limits.idleMs)}, or have held it for ${duration(limits.maxMs)}. It is wiped when it ends.`;
}

// The recordings a flow kept: the first failed attempt's, and the latest attempt's when that is another one.
export function flowRecordings(flow) {
  const links = [];
  if (flow.firstRecording) links.push({ label: 'First failure', href: pathOf(flow.firstRecording) });
  if (flow.recording && flow.recording !== flow.firstRecording) {
    links.push({ label: flow.firstRecording ? 'Latest attempt' : 'Recording', href: pathOf(flow.recording) });
  }
  return links;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export function canRerun(run, flow) {
  return run.state !== 'running' && (flow.status === 'failed' || flow.status === 'flaky');
}

// KEY=value lines, as a rerun's `env`. Blank lines and lines starting with # are skipped.
export function parseEnv(text) {
  const env = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`"${line}" is not KEY=value.`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  return env;
}

export function percent(rate) {
  return `${Math.round(rate * 100)}%`;
}

// Only the Android driver rotates; simctl and idb have no call for it.
export function canRotate(platform) {
  return platform === 'android-emulator';
}

export const LIMIT_FIELDS = [
  { key: 'idle', label: 'Idle', unit: 'minutes', ms: 60_000 },
  { key: 'max', label: 'Longest lease', unit: 'hours', ms: 3_600_000 },
  { key: 'grace', label: 'Reconnect grace', unit: 'minutes', ms: 60_000 },
];

// A form value in the field's unit, as the seconds PUT /v1/lease-limits/:role takes. Empty goes back to the built-in cap.
export function capSeconds(value, field) {
  const text = String(value).trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${field.label} must be a positive number of ${field.unit}.`);
  return Math.round((n * field.ms) / 1000);
}

export function capValue(ms, field) {
  return String(Math.round((ms / field.ms) * 100) / 100);
}
