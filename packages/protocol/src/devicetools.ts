import type { Point } from './index.ts';

export type Orientation = 'portrait' | 'landscapeLeft' | 'landscapeRight' | 'portraitUpsideDown';

export const ORIENTATIONS = ['portrait', 'landscapeLeft', 'landscapeRight', 'portraitUpsideDown'] as const;

export type DeviceToolOp =
  | { op: 'appLog'; bundleId?: string; since?: number; limit?: number }
  | { op: 'jsEvaluate'; expression: string; bundleId?: string }
  | { op: 'jsConsole'; bundleId?: string; since?: number; limit?: number }
  | { op: 'network'; bundleId?: string; since?: number; limit?: number }
  | { op: 'orientation'; orientation: Orientation }
  | { op: 'gesture'; gesture: 'pinch' | 'rotate'; center: Point; scale?: number; degrees?: number; durationMs?: number };

// `next` is the cursor for the following call's `since`. `dropped` is true when lines after `since` fell out of the buffer.
export type Page<T> = { items: (T & { seq: number })[]; next: number; dropped: boolean };

export type LogLine = { time: number; level: string; message: string; tag?: string };

export type AppLogPage = Page<LogLine> & { bundleId: string; running: boolean };

export type ConsoleMessage = { time: number; level: string; text: string };

export type NetworkEntry = {
  id: string;
  method: string;
  url: string;
  startedAt: number;
  status?: number;
  mimeType?: string;
  durationMs?: number;
  bytes?: number;
  error?: string;
};

export type NetworkPage = Page<NetworkEntry> & { source: 'cdp' | 'xhr-patch' };

export type EvaluateResult = { value?: unknown; description?: string; type: string; exception?: string };
