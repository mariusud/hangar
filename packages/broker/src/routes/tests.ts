import { testHistory } from '../runs.ts';
import { json, me, route, sameTeam } from './util.ts';

route('GET', '/v1/tests', (req, res, ctx) => {
  const p = me(req, ctx);
  json(res, 200, testHistory(ctx.db.recentRuns(200).filter((r) => sameTeam(ctx, p, r.accountId))));
});
