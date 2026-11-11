import type { LogLine, NetworkEntry } from './devicetools.ts';
import type { LeaseEndReason } from './index.ts';

export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

// `at` is milliseconds from the start of the recording's video.
export type FindingStep = { at: number; what: string; failed?: string };

export type FindingVideo = {
  recordingId: string;
  // The page with the video; `video` is the file with a media fragment for the span.
  url: string;
  video: string;
  fromMs: number;
  toMs: number;
  // True when the recording started because of this finding, so there is no video before it.
  startedWithFinding: boolean;
};

export type Finding = {
  id: string;
  leaseId: string;
  nightId: string | null;
  title: string;
  description: string;
  severity: FindingSeverity;
  by: string;
  createdAt: number;
  device: string | null;
  video: FindingVideo | null;
  steps: FindingStep[];
  log: LogLine[];
  logError: string | null;
  network: NetworkEntry[];
  screenshot: string | null;
  notes: string[];
  // A link that replays the steps on a fresh lease of the same image. Null until Hangar can do that.
  openAgainUrl: string | null;
};

export type NightLease = {
  id: string;
  owner: string;
  image: string | null;
  device: string | null;
  activatedAt: number | null;
  endedAt: number | null;
  reason: LeaseEndReason | null;
  recording: string | null;
};

export type NightRun = {
  id: string;
  state: string;
  url: string;
  passed: number;
  flaky: number;
  failed: number;
  failures: { flow: string; message: string | null; recording: string | null }[];
};

export type Night = {
  id: string;
  booking: string;
  team: string;
  state: 'open' | 'closed';
  openedAt: number;
  closedAt: number | null;
  openedBy: string;
  closedBy: string | null;
  url: string;
};

export type NightReport = {
  night: Night;
  generatedAt: number;
  summary: {
    leases: number;
    findings: number;
    bySeverity: Record<FindingSeverity, number>;
    runs: number;
    failedFlows: number;
    flakyFlows: number;
  };
  findings: Finding[];
  leases: NightLease[];
  runs: NightRun[];
  notes: string[];
};
