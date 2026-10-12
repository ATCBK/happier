export const MCP_SERVER_ACTION_IDS_V1 = [
  'mcp.servers.list', 'mcp.servers.read', 'mcp.servers.create', 'mcp.servers.update',
  'mcp.servers.duplicate', 'mcp.servers.delete', 'mcp.servers.test', 'mcp.servers.probe',
  'mcp.servers.signIn.start',
] as const;
export type McpServerActionIdV1 = typeof MCP_SERVER_ACTION_IDS_V1[number];
export function isMcpServerActionIdV1(value: string): value is McpServerActionIdV1 {
  return (MCP_SERVER_ACTION_IDS_V1 as readonly string[]).includes(value);
}
