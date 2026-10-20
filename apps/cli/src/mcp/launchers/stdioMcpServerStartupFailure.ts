import { z } from 'zod/mini';

// Private launcher → MCP client error.data, not a server capability or error heuristic.
export const StdioMcpServerStartupFailureSchema = z.strictObject({
  t: z.literal('happier-mcp-stdio-spawn-failure-v1'),
  code: z.optional(z.string().check(z.minLength(1))),
  path: z.optional(z.string().check(z.minLength(1))),
});

export type StdioMcpServerStartupFailure = z.infer<typeof StdioMcpServerStartupFailureSchema>;
