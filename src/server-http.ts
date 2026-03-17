/**
 * HTTP entry point for the FI Election Data MCP server.
 *
 * Use this when running on a remote server (e.g. Azure) so that Claude Desktop
 * can connect over the network using the Streamable HTTP transport.
 *
 * Usage:
 *   node dist/server-http.js [port]    (default port: 3000)
 *
 * Per-IP rate limit: 30 requests / 60 seconds (sliding window).
 * Clients that exceed the limit receive HTTP 429 with a JSON body.
 */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './server.js';

// ─── Port configuration ───────────────────────────────────────────────────────

const rawPort = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
if (isNaN(rawPort) || rawPort < 1024 || rawPort > 65535) {
  console.error(`Invalid PORT value "${process.argv[2] ?? process.env.PORT}". Falling back to 3000.`);
}
const PORT = (!isNaN(rawPort) && rawPort >= 1024 && rawPort <= 65535) ? rawPort : 3000;

// ─── Per-IP rate limiter ──────────────────────────────────────────────────────

const RATE_LIMIT_REQUESTS  = parseInt(process.env.RATE_LIMIT_REQUESTS  ?? '30', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);

const ipTimestamps = new Map<string, number[]>();

/**
 * Returns the client IP from the request, honouring X-Forwarded-For when the
 * server sits behind a reverse proxy (nginx/Cloudflare). Falls back to
 * socket.remoteAddress for direct connections.
 */
function getClientIp(req: http.IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Sliding-window rate limiter.
 * @returns true if the request is allowed, false if it should be rejected.
 */
function checkRateLimit(ip: string): boolean {
  const now  = Date.now();
  const ts   = ipTimestamps.get(ip) ?? [];
  const recent = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_REQUESTS) {
    ipTimestamps.set(ip, recent); // keep filtered; don't add new timestamp
    return false;
  }
  recent.push(now);
  ipTimestamps.set(ip, recent);
  return true;
}

// Evict stale IP entries every 5 minutes to prevent unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, ts] of ipTimestamps) {
    const recent = ts.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (recent.length === 0) {
      ipTimestamps.delete(ip);
    } else {
      ipTimestamps.set(ip, recent);
    }
  }
}, 5 * 60 * 1000);

// ─── MCP server + transport ───────────────────────────────────────────────────

const server = new McpServer({
  name: 'fi-election-data-mcp',
  version: '0.1.0',
});

registerAllTools(server);

// One stateless transport instance — each POST/GET goes through it.
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // stateless mode: no session tracking needed
});

await server.connect(transport);

// ─── HTTP server ──────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  const start    = Date.now();
  const clientIp = getClientIp(req);

  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${duration}ms ip=${clientIp}`);
  });

  if (!checkRateLimit(clientIp)) {
    const body = JSON.stringify({
      error: 'rate_limit_exceeded',
      message:
        `You have made too many requests (limit: ${RATE_LIMIT_REQUESTS} per ${RATE_LIMIT_WINDOW_MS / 1000}s). ` +
        'Please wait a moment and try again.',
      retry_after_seconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1000),
    });
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Retry-After': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
    });
    res.end(body);
    return;
  }

  transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`FI Election Data MCP running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Rate limit: ${RATE_LIMIT_REQUESTS} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
});
