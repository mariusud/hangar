// bench/lease: from asking for a device to using it, through the real broker and agent: the
// lease is active, then a screenshot, then the accessibility tree. The target is a p95 under 2 s
// from the warm pool (milestone 1).
//
// Each trial waits until the pool has a ready device again, so it measures a warm lease. It also
// reports how long the pool takes to replace a released device (delete, clone, boot), which is
// the time a second lease right after the first would wait.
//
//   pnpm bench:lease

import { start } from '../e2e/harness.ts';

const TRIALS = Number(process.env.TRIALS ?? 10);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function q(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]!) : NaN;
}

const h = await start(1, () => {});
try {
  const { hangar } = h.client('bench');
  const ready = async (): Promise<void> => {
    while (!(await hangar.devices()).some((d) => d.state === 'ready')) {
      await sleep(100);
    }
  };

  const active: number[] = [];
  const shot: number[] = [];
  const lease: number[] = [];
  const refill: number[] = [];
  for (let i = 0; i < TRIALS; i++) {
    await ready();
    const t0 = performance.now();
    const l = await hangar.lease({}, { autoRenew: false });
    active.push(performance.now() - t0);
    await l.screenshot('jpeg');
    shot.push(performance.now() - t0);
    await l.ui();
    lease.push(performance.now() - t0);

    const t1 = performance.now();
    await l.release();
    await ready();
    refill.push(performance.now() - t1);
  }
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString().slice(0, 10),
        trials: TRIALS,
        leaseToActive: { p50: q(active, 0.5), p95: q(active, 0.95) },
        leaseToScreenshot: { p50: q(shot, 0.5), p95: q(shot, 0.95) },
        leaseToTree: { p50: q(lease, 0.5), p95: q(lease, 0.95) },
        releaseToReady: { p50: q(refill, 0.5), p95: q(refill, 0.95) },
      },
      null,
      2,
    ),
  );
} finally {
  await h.stop();
}
