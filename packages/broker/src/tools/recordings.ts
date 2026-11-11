import { z } from 'zod';
import type { ToolDeps } from './util.ts';

export function registerRecordingTools({ server, p, recordings, publicUrl, pick, safe, text }: ToolDeps): void {
  server.registerTool(
    'record',
    {
      description:
        'Record the screen, the app log, network requests and every action on the device. Start before reproducing a bug, stop after: stop returns a link with the video, the timeline, the log and the requests, for a bug report or a person to check. To file the bug itself, use report_finding.',
      inputSchema: { action: z.enum(['start', 'stop']), leaseId: z.string().optional() },
    },
    ({ action, leaseId }) =>
      safe(async () => {
        if (action === 'start') {
          await recordings.start(p, pick(leaseId));
          return text('Recording. Call record with action "stop" for the link.');
        }
        const rec = await recordings.stop(p, pick(leaseId));
        return text({ url: `${publicUrl}/recordings/${rec.id}`, state: rec.state, error: rec.error });
      }),
  );
}
