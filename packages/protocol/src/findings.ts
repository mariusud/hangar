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
  // POST here to lease a fresh device of the same image and replay the actions taken before the finding.
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

// How a replayed tap or swipe found its place: the element with the recorded label on the new screen, or the recorded point.
export type OpenAgainBy = 'label' | 'coordinates';

export type OpenAgainStep = {
  what: string;
  status: 'ok' | 'skipped' | 'failed';
  by: OpenAgainBy | null;
  // Why a step was skipped or failed, or how it was replayed when that differs from the recording.
  note: string | null;
};

export type OpenAgain = {
  finding: string;
  leaseId: string;
  // The console page of the new lease.
  url: string;
  // The console page of the recording of the replay, or null when Hangar could not record it.
  recording: string | null;
  steps: OpenAgainStep[];
  notes: string[];
};
