import { registerDeviceTools } from './device.ts';
import { registerFindingTools } from './findings.ts';
import { registerLeaseTools } from './leases.ts';
import { registerMobileTools } from './mobile.ts';
import { registerRecordingTools } from './recordings.ts';
import { registerScheduleTools } from './schedule.ts';
import type { ToolDeps } from './util.ts';

export const TOOLS: ((deps: ToolDeps) => void)[] = [
  registerLeaseTools,
  registerDeviceTools,
  registerRecordingTools,
  registerScheduleTools,
  registerFindingTools,
  registerMobileTools,
];
