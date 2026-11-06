// Starts a real broker and agent in this process, on this Mac's simulators, for tests and benchmarks.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@hangar/agent';
import { startBroker, type Broker } from '@hangar/broker';
import { Hangar } from '@hangar/client';
import * as auth from '../packages/broker/src/auth.ts';

export type Harness = {
  broker: Broker;
  agent: Agent;
  client: (name: string) => { hangar: Hangar; token: string };
  stop: () => Promise<void>;
};

export async function start(max: number, log: (line: string) => void = (l) => console.error(`[agent] ${l}`)): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'hangar-e2e-'));
  const broker = await startBroker({ dataDir: dir, port: 0, host: '127.0.0.1' });
  let toAgent: (m: Parameters<Agent['receive']>[0]) => void = () => {};
  const handlers = broker.attach({ send: (m) => setImmediate(() => toAgent(m)), close: () => {} });
  const agent = new Agent({ send: (m) => setImmediate(() => handlers.message(m)), maxDevices: max, warm: 1, log });
  toAgent = (m) => agent.receive(m);
  await agent.start();
  return {
    broker,
    agent,
    client: (name) => {
      const account = auth.createAccount(broker.db, name, 'operator');
      const token = auth.mintToken(broker.db, 'member', { accountId: account.id });
      return { hangar: new Hangar({ url: broker.url, token }), token };
    },
    stop: async () => {
      await agent.stop();
      await broker.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
