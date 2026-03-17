/**
 * HTTP entry point for the FI Election Data MCP server.
 *
 * Use this when running on a remote server (e.g. Azure) so that Claude Desktop
 * can connect over the network using the Streamable HTTP transport.
 *
 * Usage:
 *   node dist/server-http.js [port]    (default port: 3000)
 */

import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './server.js';

const rawPort = parseInt(process.argv[2] ?? process.env.PORT ?? '3000', 10);
if (isNaN(rawPort) || rawPort < 1024 || rawPort > 65535) {
  console.error(`Invalid PORT value "${process.argv[2] ?? process.env.PORT}". Falling back to 3000.`);
}
const PORT = (!isNaN(rawPort) && rawPort >= 1024 && rawPort <= 65535) ? rawPort : 3000;

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

const httpServer = http.createServer((req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
  });
  transport.handleRequest(req, res);
});

httpServer.listen(PORT, () => {
  console.log(`FI Election Data MCP running on http://0.0.0.0:${PORT}/mcp`);
});
