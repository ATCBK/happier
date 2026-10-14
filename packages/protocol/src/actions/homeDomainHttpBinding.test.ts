import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';

import { bindHomeDomainHttpRequestV1 } from './homeDomainHttpBinding.js';

describe('Home-domain HTTP binding', () => {
  const schema = z.strictObject({
    v: z.literal(1),
    teamId: z.string(),
    sourceId: z.string(),
    limit: z.optional(z.number().check(z.int())),
    query: z.optional(z.string()),
  });

  it('binds exact path parameters and remaining GET input as a query', () => {
    expect(bindHomeDomainHttpRequestV1({
      transport: { method: 'GET', path: '/v1/teams/:teamId/directory-sources/:sourceId/groups' },
      inputSchema: schema,
      input: { v: 1, teamId: 'team/a', sourceId: 'source b', limit: 25, query: 'R&D' },
    })).toEqual({
      method: 'GET',
      path: '/v1/teams/team%2Fa/directory-sources/source%20b/groups?limit=25&query=R%26D',
      body: undefined,
    });
  });

  it('keeps existing unbound POST input intact and rejects missing path values', () => {
    const input = { v: 1, teamId: 'team_1', sourceId: 'source_1' };
    expect(bindHomeDomainHttpRequestV1({
      transport: { method: 'POST', path: '/v1/teams/action' },
      inputSchema: schema,
      input,
    })).toEqual({ method: 'POST', path: '/v1/teams/action', body: input });
    expect(() => bindHomeDomainHttpRequestV1({
      transport: { method: 'GET', path: '/v1/teams/:missing' },
      inputSchema: schema,
      input,
    })).toThrow('missing');
  });
});
