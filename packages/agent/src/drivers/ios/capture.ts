import type { CapturePath } from '@hangar/protocol';
import { idbVideoStream } from './idbvideo.ts';
import { companionSocket, DriverError, screenStream, type ScreenStream } from './index.ts';

export type { CapturePath };
export type VideoPath = Exclude<CapturePath, 'jpeg'>;

/** H.264 capture paths, best first. After the last one, viewers get JPEG screenshots. */
export const VIDEO_PATHS: readonly VideoPath[] = ['iosurface', 'idb'];

export type PathHealth = Record<VideoPath, { failures: number; skipUntil: number }>;

/** Failures in a row before new streams skip a path for a while. */
export const MAX_FAILURES = 2;
export const SKIP_MS = 10 * 60_000;
/** How long a requested keyframe may take before the path counts as stalled. */
export const STALL_MS = 3000;
/** The first frame of a path may take longer: a helper that was just built loads SimulatorKit cold. */
export const FIRST_FRAME_MS = 10_000;

// The helper cannot work on this Mac at all, so one failure is enough to skip it.
const PERMANENT = new Set(['SIMULATORKIT_MISSING', 'SIMULATORKIT_CHANGED', 'SCREEN_BUILD_FAILED']);

export function freshHealth(): PathHealth {
  return { iosurface: { failures: 0, skipUntil: 0 }, idb: { failures: 0, skipUntil: 0 } };
}

/** The error code at the start of a helper's last stderr line, such as SIMULATORKIT_CHANGED. */
export function failureCode(message: string): string {
  return /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? '';
}

/** The path to try after `after` (or first, when `after` is null). `forced` limits the choice to that one path. */
export function nextPath(health: PathHealth, now: number, after: VideoPath | null, forced: CapturePath | null = null): CapturePath {
  if (forced) {
    return after === null ? forced : 'jpeg';
  }
  const from = after === null ? 0 : VIDEO_PATHS.indexOf(after) + 1;
  return VIDEO_PATHS.slice(from).find((p) => health[p].skipUntil <= now) ?? 'jpeg';
}

export function recordFailure(health: PathHealth, path: VideoPath, code: string, now: number): PathHealth {
  const failures = PERMANENT.has(code) ? MAX_FAILURES : health[path].failures + 1;
  return { ...health, [path]: { failures, skipUntil: failures >= MAX_FAILURES ? now + SKIP_MS : 0 } };
}

export function recordSuccess(health: PathHealth, path: VideoPath): PathHealth {
  return health[path].failures === 0 && health[path].skipUntil === 0 ? health : { ...health, [path]: { failures: 0, skipUntil: 0 } };
}

/** A path is stalled when a keyframe was asked for `timeoutMs` ago and no frame came since. */
export function isStalled(askedAt: number | null, now: number, timeoutMs = STALL_MS): boolean {
  return askedAt !== null && now - askedAt >= timeoutMs;
}

export function parseForced(value: string | undefined): CapturePath | null {
  return value === 'iosurface' || value === 'idb' || value === 'jpeg' ? value : null;
}

type StreamOpts = { fps?: number; bitrate?: number; maxSize?: number };
export type Starter = (udid: string, onFrame: (record: Buffer) => void, opts: StreamOpts) => Promise<ScreenStream>;

export type CaptureDeps = {
  starters: Record<VideoPath, Starter>;
  now: () => number;
  forced: CapturePath | null;
  stallMs: number;
  firstFrameMs: number;
};

const defaultDeps = (): CaptureDeps => ({
  starters: {
    iosurface: screenStream,
    idb: (udid, onFrame, opts) => {
      const socket = companionSocket(udid);
      if (!socket) {
        return Promise.reject(new DriverError('IDB_NOT_STARTED', `No idb companion is running for ${udid}.`));
      }
      return idbVideoStream(socket, onFrame, opts);
    },
  },
  now: Date.now,
  forced: parseForced(process.env.HANGAR_CAPTURE),
  stallMs: STALL_MS,
  firstFrameMs: FIRST_FRAME_MS,
});

let health = freshHealth();
const paths = new Map<string, CapturePath>();

/** The capture path the device's last H.264 stream used, or null if it has had none. */
export function capturePath(udid: string): CapturePath | null {
  return paths.get(udid) ?? null;
}

export function forgetCapture(udid: string): void {
  paths.delete(udid);
}

export function resetCaptureHealth(): void {
  health = freshHealth();
}

/**
 * A screen stream that starts on the best capture path and moves to the next one when a path
 * fails to start, exits, or sends no frame within `stallMs` of a keyframe request. When no H.264
 * path is left, `exited` resolves with the reasons, and the agent moves viewers to JPEG.
 */
export async function captureStream(
  udid: string,
  onFrame: (record: Buffer) => void,
  opts: StreamOpts & { onPath?: (path: CapturePath) => void } = {},
  deps: CaptureDeps = defaultDeps(),
): Promise<ScreenStream> {
  const reasons: string[] = [];
  let stopping = false;
  let current: { path: VideoPath; stream: ScreenStream } | null = null;
  let askedAt: number | null = null;
  let healthy = false;
  let watchdog: NodeJS.Timeout | null = null;
  let finish: (err: string | null) => void = () => {};
  const exited = new Promise<string | null>((resolve) => {
    finish = resolve;
  });

  const setPath = (path: CapturePath): void => {
    if (paths.get(udid) !== path) {
      paths.set(udid, path);
      opts.onPath?.(path);
    }
  };

  const limit = (): number => (healthy ? deps.stallMs : Math.max(deps.stallMs, deps.firstFrameMs));

  const ask = (): void => {
    askedAt ??= deps.now();
    if (!watchdog) {
      watchdog = setTimeout(check, limit());
    }
  };

  const check = (): void => {
    watchdog = null;
    if (!current || stopping) {
      return;
    }
    if (isStalled(askedAt, deps.now(), limit())) {
      const failed = current;
      void failed.stream.stop().catch(() => {});
      void fail(failed, 'STALLED', `${failed.path}: no frame within ${limit()} ms of a keyframe request`);
    } else if (askedAt !== null) {
      watchdog = setTimeout(check, Math.max(1, askedAt + limit() - deps.now()));
    }
  };

  const fail = async (failed: { path: VideoPath }, code: string, message: string): Promise<void> => {
    if (stopping || (current && current !== failed)) {
      return;
    }
    current = null;
    reasons.push(message);
    health = recordFailure(health, failed.path, code, deps.now());
    await start(failed.path);
  };

  const start = async (after: VideoPath | null): Promise<void> => {
    let path = nextPath(health, deps.now(), after, deps.forced);
    while (path !== 'jpeg' && !stopping) {
      const attempt = path;
      const entry: { path: VideoPath; stream: ScreenStream | null } = { path: attempt, stream: null };
      try {
        entry.stream = await deps.starters[attempt](udid, (record) => {
          if (current?.stream !== entry.stream) {
            return;
          }
          askedAt = null;
          if (!healthy) {
            healthy = true;
            health = recordSuccess(health, attempt);
          }
          onFrame(record);
        }, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reasons.push(`${attempt}: ${message}`);
        health = recordFailure(health, attempt, err instanceof DriverError ? err.code : failureCode(message), deps.now());
        path = nextPath(health, deps.now(), attempt, deps.forced);
        continue;
      }
      const stream = entry.stream;
      if (stopping) {
        await stream.stop().catch(() => {});
        return;
      }
      const live = { path: attempt, stream };
      current = live;
      healthy = false;
      askedAt = null;
      setPath(attempt);
      void stream.exited.then((err) => {
        if (current === live && !stopping) {
          const message = err ?? 'exited';
          void fail(live, failureCode(message), `${attempt}: ${message}`);
        }
      });
      ask();
      stream.keyframe();
      return;
    }
    if (!stopping) {
      if (deps.forced === 'jpeg') {
        reasons.push('HANGAR_CAPTURE is jpeg');
      }
      setPath('jpeg');
      finish(`No H.264 capture works for this device (${reasons.join('; ')}).`);
    }
  };

  await start(null);
  if (!current) {
    throw new DriverError('CAPTURE_FAILED', `No H.264 capture works for this device (${reasons.join('; ')}).`);
  }
  return {
    keyframe: () => {
      ask();
      current?.stream.keyframe();
    },
    record: (path) => {
      ask();
      current?.stream.record(path);
    },
    stopRecording: () => current?.stream.stopRecording() ?? Promise.resolve(),
    stop: async () => {
      stopping = true;
      if (watchdog) {
        clearTimeout(watchdog);
      }
      const stream = current?.stream;
      current = null;
      await stream?.stop();
      finish(null);
    },
    exited,
  };
}
