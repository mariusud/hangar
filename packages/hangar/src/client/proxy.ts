import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';

export type StreamTarget = { url: string; token: string; leaseId: string; codec?: 'h264' | 'jpeg' };

const PASSED = ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];

export function proxyStream(req: IncomingMessage, socket: Duplex, head: Buffer, target: StreamTarget): void {
  const url = new URL(`/v1/leases/${encodeURIComponent(target.leaseId)}/stream?codec=${target.codec ?? 'h264'}`, target.url);
  const headers: Record<string, string> = { connection: 'Upgrade', upgrade: 'websocket', authorization: `Bearer ${target.token}` };
  for (const name of PASSED) {
    const value = req.headers[name];
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }
  const up = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers });
  up.on('upgrade', (res, upstream, upHead) => {
    const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`];
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead.length) {
      socket.write(upHead);
    }
    if (head.length) {
      upstream.write(head);
    }
    upstream.pipe(socket).pipe(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  up.on('response', (res) => {
    socket.end(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\nconnection: close\r\n\r\n`);
    res.resume();
  });
  up.on('error', () => {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
  });
  up.end();
}
