import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Install before registering tools; the SDK owns both the inventory and its change signal. */
export function cacheMcpToolList(server: McpServer): void {
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  let invalidate = () => {};
  server.server.setRequestHandler = (schema, handler) => {
    if (schema !== ListToolsRequestSchema) {
      setRequestHandler(schema, handler);
      return;
    }
    let cached: ReturnType<typeof handler> | undefined;
    invalidate = () => { cached = undefined; };
    // SDK 1.25.3 projects its live registered tools synchronously here. A
    // failed projection throws before assignment and is not cached.
    setRequestHandler(schema, (request, extra) => cached ??= handler(request, extra));
  };
  const sendToolListChanged = server.sendToolListChanged.bind(server);
  server.sendToolListChanged = () => {
    invalidate();
    sendToolListChanged();
  };
}
