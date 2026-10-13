/** Captured 2026-10-13 from the official v0.1 Registry.
 * Page: https://registry.modelcontextprotocol.io/v0.1/servers?search=playwright&limit=2
 * Read: https://registry.modelcontextprotocol.io/v0.1/servers/com.playwrightgen%2Fplaywrightgen/versions/latest
 * Wire schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 */
export const MCP_REGISTRY_V01_READ_FIXTURE = {
  server: {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: 'com.playwrightgen/playwrightgen',
    description: 'Approved test intent, reviewed Playwright automation and run evidence, inside your editor.',
    title: 'PlaywrightGen', repository: { url: 'https://github.com/hmamut39/playwrightgen', source: 'github' },
    version: '1.0.0', websiteUrl: 'https://playwrightgen.com/mcp',
    remotes: [{ type: 'streamable-http', url: 'https://playwrightgen.com/api/mcp', headers: [{
      description: "Bearer <token>, where the token is the personal editor token from your project's Automation page in PlaywrightGen. It speaks for you, proposes but never approves, and stops working when your access ends.",
      isRequired: true, isSecret: true, name: 'Authorization',
    }] }],
  },
  _meta: { 'io.modelcontextprotocol.registry/official': {
    status: 'active', statusChangedAt: '2026-09-20T13:48:34.38579Z', publishedAt: '2026-09-20T13:48:34.38579Z',
    updatedAt: '2026-09-20T13:48:34.38579Z', isLatest: true,
  } },
};
export const MCP_REGISTRY_V01_PAGE_FIXTURE = {
  servers: [{
    server: {
      $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
      name: 'com.clauxel.playwrightselectorguard/playwrightselectorguard-mcp',
      description: 'Playwright selector risk checks with healing suggestions and receipts.',
      repository: { url: 'https://github.com/clauxel/playwright-selector-guard-mcp', source: 'github' }, version: '1.0.0',
      remotes: [{ type: 'streamable-http', url: 'https://playwrightselectorguard.clauxel.com/mcp', headers: [{
        description: 'Bearer token from the product website.', name: 'Authorization',
      }] }],
      _meta: { 'io.modelcontextprotocol.registry/publisher-provided': {
        server_card_url: 'https://playwrightselectorguard.clauxel.com/server-card.json',
        tags: ['playwright', 'selector-healing', 'browser-automation', 'remote-mcp'], title: 'Playwright Selector Guard MCP',
      } },
    },
    _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', statusChangedAt: '2026-05-19T18:43:54.687989Z',
      publishedAt: '2026-05-19T18:43:54.687989Z', updatedAt: '2026-05-19T18:43:54.687989Z', isLatest: true } },
  }, MCP_REGISTRY_V01_READ_FIXTURE], metadata: { nextCursor: 'com.playwrightgen/playwrightgen:1.0.0', count: 2 },
};

/** Package variant built against the captured 2025-12-11 Package/KeyValueInput schema;
 * the page/read fixtures above remain byte-shape captures, not this derived variant. */
export const MCP_REGISTRY_V01_PACKAGE_FIXTURE = {
  ...MCP_REGISTRY_V01_READ_FIXTURE,
  server: { ...MCP_REGISTRY_V01_READ_FIXTURE.server, remotes: [], packages: [{
    registryType: 'npm', identifier: '@example/mcp-server', version: '2.3.4', runtimeHint: 'npx',
    transport: { type: 'stdio' }, packageArguments: [{ type: 'named', name: '--mode', value: 'read' }],
    environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }, { name: 'REGION', default: 'eu' }],
  }] },
};
