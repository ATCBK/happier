import { describe, expect, it } from 'vitest';

import { RUNTIME_ACTION_SPECS } from './index.js';

describe('service relocation Action surfaces', () => {
  it('exposes the real relocation producer to UI, Agent, MCP, Voice, and CLI', () => {
    const spec = RUNTIME_ACTION_SPECS.find(({ id }) => id === 'projects.service.relocate');

    expect(spec?.surfaces).toMatchObject({
      ui: true,
      agent: true,
      mcp: true,
      voice: true,
      cli: true,
    });
    expect(spec?.bindings).toMatchObject({
      mcpToolName: 'projects_service_relocate',
      voiceClientToolName: 'projects_service_relocate',
    });
    const voiceArgs = JSON.parse(spec?.examples?.voice?.argsExample ?? 'null');
    expect(spec?.inputSchema.safeParse(voiceArgs).success).toBe(true);
  });
});
