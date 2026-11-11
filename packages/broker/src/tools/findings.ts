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

  server.registerTool(
    'open_again',
    {
      description:
        "Reproduce a finding: lease a fresh device of the same image, record it, and replay the taps, swipes, typing, keys, buttons, app launches and URLs taken before the finding. Taps go to the element with the recorded label when it is on screen, else to the recorded point. Returns the new lease id and each step as ok, skipped or failed. You hold the new lease afterwards; release it when done. Only the finding's team can open it again.",
      inputSchema: {
        findingId: z.string(),
        waitSeconds: z.number().min(1).max(3600).optional().describe('How long to wait for a free device. Defaults to 300'),
      },
    },
    ({ findingId, waitSeconds }) =>
      safe(async () => text(await recordings.findings.openAgain(p, findingId, publicUrl, { waitMs: (waitSeconds ?? 300) * 1000 }))),
  );
}
