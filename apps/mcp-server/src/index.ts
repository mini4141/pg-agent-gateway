/**
 * MCP server (stdio). Every tool calls the gateway over HTTP as caller type `mcp`, so MCP traffic goes
 * through the same auth, rate limit, read-only and timeout pipeline as every other caller.
 * Env: GATEWAY_URL (default http://localhost:8080), MCP_API_KEY (default dev-mcp).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:8080';
const API_KEY = process.env.MCP_API_KEY ?? 'dev-mcp';

async function gateway(tenant: string, path: string, body?: object) {
  const res = await fetch(`${GATEWAY}/v1/tenants/${tenant}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'x-caller-type': 'mcp' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) return { isError: true as const, content: [{ type: 'text' as const, text: `${res.status} ${json.error?.code}: ${json.error?.message}` }] };
  return { content: [{ type: 'text' as const, text: JSON.stringify(json.rows, null, 1) + (json.truncated ? '\n(truncated)' : '') }] };
}

const server = new McpServer({ name: 'pg-agent-gateway', version: '1.0.0' });
const tenant = z.string().describe('tenant id, e.g. tenant_a');

server.registerTool('list_tables', { description: 'List the tables of a tenant database', inputSchema: { tenant } }, ({ tenant }) =>
  gateway(tenant, 'tables'),
);

server.registerTool(
  'describe_table',
  { description: 'Describe the columns of a table', inputSchema: { tenant, table: z.string() } },
  ({ tenant, table }) =>
    gateway(tenant, 'query', {
      sql: 'select column_name, data_type, is_nullable from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position',
      params: ['public', table],
    }),
);

server.registerTool(
  'run_sql',
  { description: 'Run a read-only SQL statement (5 s timeout, 1000 rows max)', inputSchema: { tenant, sql: z.string() } },
  ({ tenant, sql }) => gateway(tenant, 'query', { sql }),
);

await server.connect(new StdioServerTransport());
