import { z } from 'zod';

// Private launcher → MCP client error.data, not a server capability or error heuristic.
export const StdioMcpServerStartupFailureSchema = z.object({
  t: z.literal('happier-mcp-stdio-spawn-failure-v1'),
  code: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
}).strict();

export type StdioMcpServerStartupFailure = z.infer<typeof StdioMcpServerStartupFailureSchema>;
