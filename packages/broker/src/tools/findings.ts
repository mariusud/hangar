import { z } from 'zod';
import { FINDING_SEVERITIES } from '@hangar/protocol';
import { findingView, parseFinding } from '../findings.ts';
import type { ToolDeps } from './util.ts';

export function registerFindingTools({ server, p, db, recordings, publicUrl, pick, safe, text }: ToolDeps): void {
  server.registerTool(
    'report_finding',
    {
      description:
        'File a bug you found on the device: a one-line title and a description of what you did, what you expected and what happened. Hangar attaches the last two minutes of video, the steps taken, the app log, the network requests and a screenshot, and adds it to the night report. Starts a recording if the lease has none, in which case the video starts with the finding.',
      inputSchema: {
        title: z.string().min(1).max(200),
        description: z.string().max(10_000),
        severity: z.enum(FINDING_SEVERITIES).optional().describe('Defaults to medium'),
        leaseId: z.string().optional(),
      },
    },
    ({ title, description, severity, leaseId }) =>
      safe(async () => {
        const row = await recordings.findings.report(p, pick(leaseId), parseFinding({ title, description, severity }));
        const f = findingView(db, row, publicUrl);
        return text({ id: f.id, url: `${publicUrl}/v1/findings/${f.id}`, video: f.video?.video ?? null, screenshot: f.screenshot, steps: f.steps.length, logLines: f.log.length, notes: f.notes });
      }),
  );
}
