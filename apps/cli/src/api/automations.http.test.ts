import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { deleteAutomationDefinition } from './automations';
import { runWithServerHttpBaseUrl } from './client/serverHttpBaseUrl';

describe('Automation HTTP transport', () => {
  it('deletes through a real JSON-parsing HTTP boundary without an empty JSON body', async () => {
    const server = Fastify();
    let deleted = false;
    server.delete('/v3/automations/:id', async () => { deleted = true; return { ok: true, removedRevision: 2 }; });
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    try {
      await expect(runWithServerHttpBaseUrl(address, () => deleteAutomationDefinition({ token: 'test-token', automationId: 'empty-set' })))
        .resolves.toEqual({ ok: true, removedRevision: 2 });
      expect(deleted).toBe(true);
    } finally { await server.close(); }
  });
});
