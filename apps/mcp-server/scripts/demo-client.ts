/** Tiny MCP client: spawns the server over stdio, lists its tools and calls each one. Output is logged as proof. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', 'tsx', 'src/index.ts'],
  env: { ...process.env, GATEWAY_URL: process.env.GATEWAY_URL ?? 'http://localhost:8080', MCP_API_KEY: process.env.MCP_API_KEY ?? 'dev-mcp' } as Record<string, string>,
});
const client = new Client({ name: 'demo-client', version: '1.0.0' });
await client.connect(transport);

const show = (title: string, r: unknown) => {
  const content = (r as { content: { text: string }[] }).content[0]!.text;
  console.log(`\n== ${title}\n${content.length > 600 ? content.slice(0, 600) + '\n...' : content}`);
};

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
show('list_tables(tenant_a)', await client.callTool({ name: 'list_tables', arguments: { tenant: 'tenant_a' } }));
show('describe_table(tenant_a, orders)', await client.callTool({ name: 'describe_table', arguments: { tenant: 'tenant_a', table: 'orders' } }));
show(
  'run_sql(tenant_b, revenue by status)',
  await client.callTool({ name: 'run_sql', arguments: { tenant: 'tenant_b', sql: 'select status, count(*)::int as orders, sum(total) as revenue from orders group by status order by 1' } }),
);
show('run_sql write attempt (must be refused)', await client.callTool({ name: 'run_sql', arguments: { tenant: 'tenant_b', sql: 'delete from orders' } }));
await client.close();
