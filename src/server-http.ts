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
//
// NEW-SEC-8: Multi-instance limitation.
// This in-process rate limiter is per-instance. If multiple Node.js processes
// run behind a load balancer (e.g. Azure App Service with multiple workers),
// each process maintains its own ipTimestamps Map, so the effective limit is
// RATE_LIMIT_REQUESTS × number-of-instances. For true global rate limiting
// across instances, replace this with a shared Redis counter (e.g. rate-limiter-
// flexible with ioredis). Until then, keep instance count to 1 for enforcement
// guarantees, or accept the per-instance semantics as a best-effort safeguard.

const RATE_LIMIT_REQUESTS  = parseInt(process.env.RATE_LIMIT_REQUESTS  ?? '30', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);

const ipTimestamps = new Map<string, number[]>();

// Known trusted proxy IPs/ranges. X-Forwarded-For is only honoured when the
// actual socket connection comes from one of these addresses. Direct clients
// cannot spoof the header to bypass per-IP rate limiting.
const TRUSTED_PROXY_LITERALS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isTrustedProxy(ip: string): boolean {
  if (TRUSTED_PROXY_LITERALS.has(ip)) return true;
  // RFC-1918 private ranges (and their IPv4-mapped IPv6 equivalents)
  return /^(::ffff:)?(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(ip);
}

/**
 * Returns the client IP from the request. X-Forwarded-For is only trusted
 * when the socket connection originates from a known trusted proxy (loopback
 * or RFC-1918). Otherwise the raw socket address is used to prevent spoofing.
 */
function getClientIp(req: http.IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? '0.0.0.0';
  if (isTrustedProxy(socketIp)) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      return xff.split(',')[0]!.trim();
    }
  }
  return socketIp;
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

// ─── Security helpers ─────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 1_048_576; // 1 MB

/** Sets standard defensive headers on every outgoing response. */
function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
}

/**
 * Strips control characters from user-supplied strings and truncates to 200
 * chars. Use before including any external input in error messages to reduce
 * prompt-injection surface.
 */
export function sanitizeForLog(s: unknown): string {
  return String(s).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200);
}

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

  // NEW-SEC-7: Structured access logging — populated inside the body buffer
  // callback below after we parse the MCP JSON request.
  let toolName = '';
  let toolArgsSummary = '';

  // Always register finish listener first so it fires even for rejected requests.
  res.on('finish', () => {
    const duration = Date.now() - start;
    const toolPart = toolName ? ` tool=${toolName} args=${toolArgsSummary}` : '';
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${duration}ms ip=${clientIp}${toolPart}`);
  });

  // Set security headers on all responses we control. The transport-handled
  // responses also pick these up because setHeader() writes to the same object.
  setSecurityHeaders(res);

  // Reject oversized requests before buffering the body.
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    const body = JSON.stringify({ error: 'Request body too large' });
    res.writeHead(413, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

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

  // Buffer the full request body before passing to the transport.
  //
  // Passing parsedBody as the third argument to transport.handleRequest lets the
  // MCP SDK skip its own body-stream read — which is required because attaching
  // our 'data' listener here puts the IncomingMessage into flowing mode before
  // Hono's internal body reader inside the transport runs. Without this, the
  // transport receives an already-drained stream and silently gets empty input,
  // causing all HTTP-mode tool calls to fail.
  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('end', () => {
    let parsedBody: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8')) as Record<string, unknown>;
      parsedBody = parsed;
      const params = parsed['params'] as Record<string, unknown> | undefined;
      if (parsed['method'] === 'tools/call' && typeof params?.['name'] === 'string') {
        toolName = sanitizeForLog(params['name']);
        const args = params['arguments'];
        toolArgsSummary = sanitizeForLog(JSON.stringify(args ?? {}));
      }
    } catch { /* not JSON or not a tool call — omit from log */ }
    transport.handleRequest(req, res, parsedBody);
  });
});

httpServer.listen(PORT, () => {
  console.log(`FI Election Data MCP running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Rate limit: ${RATE_LIMIT_REQUESTS} req / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`);
});
