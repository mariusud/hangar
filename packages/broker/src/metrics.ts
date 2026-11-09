
import type { Op } from '@hangar/protocol';
import type { Db } from './db.ts';
import type { Hosts } from './hosts.ts';
import type { Lease } from './leases/machine.ts';
import type { Leases } from './leases/service.ts';

type Labels = Record<string, string>;

const key = (labels: Labels): string =>
  Object.entries(labels)
    .map(([k, v]) => `${k}="${v.replace(/["\\\n]/g, '_')}"`)
    .join(',');

class Counter {
  readonly values = new Map<string, number>();
  readonly name: string;
  readonly help: string;
  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }
  render(): string[] {
    return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`, ...[...this.values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ''} ${v}`)];
  }
}

class Histogram {
  private series = new Map<string, { counts: number[]; sum: number; count: number }>();
  readonly name: string;
  readonly help: string;
  readonly buckets: number[];
  constructor(name: string, help: string, buckets: number[]) {
    this.name = name;
    this.help = help;
    this.buckets = buckets;
  }
  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const s = this.series.get(k) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
    this.buckets.forEach((b, i) => {
      if (value <= b) {
        s.counts[i]! += 1;
      }
    });
    s.sum += value;
    s.count += 1;
    this.series.set(k, s);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.buckets.forEach((b, i) => lines.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
      lines.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`, `${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`, `${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return lines;
  }
}

export class Metrics {
  readonly leaseWait = new Histogram('hangar_lease_wait_seconds', 'From asking for a device to holding it.', [0.25, 0.5, 1, 2, 5, 10, 30, 60, 300]);
  readonly leasesEnded = new Counter('hangar_leases_ended_total', 'Leases that ended, by reason.');
  readonly opDuration = new Histogram('hangar_op_duration_seconds', 'Device operations that succeeded, by op, as the broker saw them.', [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10, 60]);
  readonly framesDropped = new Counter('hangar_stream_frames_dropped_total', 'Frames a viewer skipped because its connection fell behind.');
  readonly framesSent = new Counter('hangar_stream_frames_sent_total', 'Frames sent to viewers, by codec.');

  private db: Db;
  private hosts: Hosts;

  constructor(db: Db, hosts: Hosts, leases: Leases) {
    this.db = db;
    this.hosts = hosts;
    const active = new Set<string>();
    leases.events.on('any', (lease: Lease) => {
      if (lease.state === 'active' && lease.activatedAt && !active.has(lease.id)) {
        active.add(lease.id);
        this.leaseWait.observe((lease.activatedAt - lease.createdAt) / 1000);
      } else if (lease.state === 'ended') {
        active.delete(lease.id);
        this.leasesEnded.inc({ reason: lease.reason ?? 'unknown' });
      }
    });
    leases.events.on('op', (_id: string, body: Op, startedAt: number) => this.opDuration.observe((Date.now() - startedAt) / 1000, { op: body.op }));
  }

  render(): string {
    const gauge = (name: string, help: string, rows: [Labels, number][]): string[] => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} gauge`,
      ...rows.map(([labels, v]) => `${name}${Object.keys(labels).length ? `{${key(labels)}}` : ''} ${v}`),
    ];
    const devices = new Map<string, number>();
    for (const d of this.hosts.devices()) {
      const state = d.connected ? d.state : 'offline';
      devices.set(state, (devices.get(state) ?? 0) + 1);
    }
    const states = ['queued', 'preparing', 'active'] as const;
    return [
      ...gauge('hangar_devices', 'Devices on connected and recently lost hosts, by state.', [...devices].map(([state, n]) => [{ state }, n])),
      ...gauge('hangar_leases', 'Live leases, by state.', states.map((state) => [{ state }, this.db.leasesIn([state]).length])),
      ...gauge('hangar_hosts_connected', 'Macs connected to the broker.', [[{}, this.hosts.connectedCount()]]),
      ...this.leaseWait.render(),
      ...this.leasesEnded.render(),
      ...this.opDuration.render(),
      ...this.framesSent.render(),
      ...this.framesDropped.render(),
      '',
    ].join('\n');
  }
}
