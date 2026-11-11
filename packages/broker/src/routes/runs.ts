import { ApiError } from '../leases/service.ts';
import { failureGroups, junit, testHistory, type RerunRequest, type Run, type RunRequest } from '../runs.ts';
import { body, json, me, route, sameTeam, type Ctx, type Req } from './util.ts';

function teamRun(req: Req, ctx: Ctx): Run {
  const run = ctx.runs.get(req.params.id ?? '');
  if (!sameTeam(ctx, me(req, ctx), run.accountId)) {
    throw new ApiError(404, 'RUN_NOT_FOUND', `No run ${req.params.id}.`);
  }
  return run;
}

route('POST', '/v1/runs', async (req, res, ctx) => {
  const b = await body<RunRequest>(req, 15_000_000);
  json(res, 201, ctx.runs.view(ctx.runs.start(me(req, ctx), b)));
});

route('GET', '/v1/runs', (req, res, ctx) => {
  const p = me(req, ctx);
  json(res, 200, ctx.runs.list().filter((r) => sameTeam(ctx, p, r.accountId)).map((r) => ctx.runs.view(r)));
});

route('GET', '/v1/runs/:id', (req, res, ctx) => {
  json(res, 200, ctx.runs.view(teamRun(req, ctx)));
});

route('GET', '/v1/runs/:id/events', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (r: typeof run): void => {
    res.write(`event: ${r.state}\ndata: ${JSON.stringify(ctx.runs.view(r))}\n\n`);
    if (r.state !== 'running') {
      res.end();
    }
  };
  send(run);
  ctx.runs.events.on(run.id, send);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    ctx.runs.events.off(run.id, send);
  });
});

route('GET', '/v1/runs/:id/junit.xml', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
  res.end(junit(run));
});

route('DELETE', '/v1/runs/:id', (req, res, ctx) => {
  json(res, 200, ctx.runs.view(ctx.runs.cancel(me(req, ctx), req.params.id ?? '')));
});

route('POST', '/v1/runs/:id/flows/:flow/rerun', async (req, res, ctx) => {
  const run = teamRun(req, ctx);
  const b = await body<RerunRequest>(req);
  json(res, 202, ctx.runs.view(ctx.runs.rerun(me(req, ctx), run.id, req.params.flow ?? '', b)));
});

// The device a failed flow was left on, for a person on the run's team (runs started with a hold).
route('POST', '/v1/runs/:id/flows/:flow/hold-lease', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  json(res, 201, ctx.leases.view(ctx.runs.holdLease(me(req, ctx), run.id, req.params.flow ?? '')));
});

route('DELETE', '/v1/runs/:id/flows/:flow/hold', (req, res, ctx) => {
  const run = teamRun(req, ctx);
  json(res, 200, ctx.runs.view(ctx.runs.releaseHold(me(req, ctx), run.id, req.params.flow ?? '')));
});

route('GET', '/v1/tests/flaky', (req, res, ctx) => {
  const p = me(req, ctx);
  const runs = ctx.db.recentRuns(200).filter((r) => sameTeam(ctx, p, r.accountId));
  const tests = testHistory(runs)
    .filter((t) => t.flaky + t.failed > 0)
    .sort((a, b) => b.flakeRate - a.flakeRate || b.failRate - a.failRate || a.test.localeCompare(b.test));
  json(res, 200, { runs: runs.filter((r) => r.state !== 'running').length, tests, failures: failureGroups(runs) });
});
