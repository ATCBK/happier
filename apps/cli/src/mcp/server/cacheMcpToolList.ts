import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

type McpRequestHandler = (request: unknown, extra: unknown) => unknown;

/** Install before registering tools; the SDK owns both the inventory and its change signal. */
export function cacheMcpToolList(server: McpServer): void {
  // The SDK's generic handler signature cannot be re-declared by a wrapper; it is typed at this boundary only.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server) as (schema: unknown, handler: McpRequestHandler) => void;
  let invalidate = () => {};
  server.server.setRequestHandler = ((schema: unknown, handler: McpRequestHandler) => {
    if (schema !== ListToolsRequestSchema) {
      setRequestHandler(schema, handler);
      return;
    }
    let cached: unknown;
    invalidate = () => { cached = undefined; };
    // SDK 1.25.3 projects its live registered tools synchronously here. A
    // failed projection throws before assignment and is not cached.
    setRequestHandler(schema, (request, extra) => cached ??= handler(request, extra));
  }) as typeof server.server.setRequestHandler;
  const sendToolListChanged = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {
    invalidate();
    sendToolListChanged();
  };
}
