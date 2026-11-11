import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type * as auth from '../auth.ts';
import type { Db } from '../db.ts';
import type { Leases } from '../leases/service.ts';
import type { Recordings } from '../recordings.ts';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type Result = { content: Content[]; isError?: boolean };

export type ToolDeps = {
  server: McpServer;
  p: auth.Principal;
  db: Db;
  leases: Leases;
  recordings: Recordings;
  internalUrl: string;
  publicUrl: string;
  pick: (leaseId?: string) => string;
  safe: (fn: () => Promise<Result>) => Promise<Result>;
  text: (value: unknown) => Result;
  install: (leaseId: string, build: string) => Promise<unknown>;
};
