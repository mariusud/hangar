import type { Page } from '@hangar/protocol';

// A bounded buffer with a cursor. Pushing with a key that is already held moves that item to the end with a new seq.
export class Ring<T> {
  private items = new Map<string, { seq: number; item: T }>();
  private last = 0;
  private lostAfter = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get seq(): number {
    return this.last;
  }

  get size(): number {
    return this.items.size;
  }

  push(item: T, key?: string): number {
    const seq = ++this.last;
    const k = key ?? `#${seq}`;
    this.items.delete(k);
    this.items.set(k, { seq, item });
    for (const [oldest, entry] of this.items) {
      if (this.items.size <= this.capacity) {
        break;
      }
      this.items.delete(oldest);
      this.lostAfter = Math.max(this.lostAfter, entry.seq);
    }
    return seq;
  }

  values(): T[] {
    return [...this.items.values()].map((e) => e.item);
  }

  // Empties the buffer without counting it as lost; seq keeps counting so cursors stay valid.
  clear(): void {
    this.items.clear();
  }

  get(key: string): T | undefined {
    return this.items.get(key)?.item;
  }

  // Without `since`, the newest `limit` items. With it, the first `limit` items after it.
  page(since: number | undefined, limit: number): Page<T> {
    const n = Math.max(1, Math.min(Math.floor(limit) || 1, this.capacity));
    const all = [...this.items.values()];
    const picked = since === undefined ? all.slice(-n) : all.filter((e) => e.seq > since).slice(0, n);
    const items = picked.map((e) => ({ ...e.item, seq: e.seq }));
    const next = items.at(-1)?.seq ?? (since === undefined ? this.last : Math.min(since, this.last));
    return { items, next, dropped: since !== undefined && since < this.lostAfter };
  }
}
