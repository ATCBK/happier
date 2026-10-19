import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';

import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionAccessCandidatesInspectRequestV1Schema, SessionAccessCandidatesInspectResponseV1Schema,
  ResolveSessionAccessPrincipalsRequestV1Schema, ResolveSessionAccessPrincipalsResponseV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { UsersSearchQueryV1Schema, UsersSearchResponseSchema } from '@happier-dev/protocol/social/friends';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';

describe('Session access discovery HTTP adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
  });
  afterEach(async () => { restore(); await app.close(); });

  it.each([
    { payload: { error: 'credential_scope_denied' }, denied: true },
    { payload: { error: 'credential_scope_denied', details: {} }, denied: false },
  ])('preserves only strict scope refusals through the real Action executor ($denied)', async ({ payload, denied }) => {
    app.post('/v2/sessions/access-candidates/inspect', async (_request, reply) => reply.code(403).send(payload));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'bound', serverId: 'home', serverHttpBaseUrl: 'http://access.test',
    }) });
    await expect(executor.execute('session.access.candidates.inspect', { v: 1, sessionId: 'same', subjects: [] },
      { surface: 'agent', authority: 'account_automation', serverId: 'home' }))
      .resolves.toMatchObject({ ok: false, errorCode: denied ? 'credential_scope_denied' : 'not_authenticated' });
  });

  it('executes sharing discovery through the real Account executor and declared HTTP transport', async () => {
    const inspected = { v: 1 as const, context: null, candidates: [
      { subject: { kind: 'account' as const, accountId: 'recipient' }, reason: 'session_access_subject_ineligible' as const },
    ] };
    const subjects = [{ kind: 'team' as const, teamId: 'team' }];
    const resolved = { v: 1 as const, principals: [{ ...subjects[0], name: 'Team' }], creationDecision: {
      v: 1 as const, teamId: 'team', teamName: 'Team', requiredByPolicy: false,
      defaultGrant: null, externalSharingPolicy: 'allowed' as const,
    } };
    // HTTP is the substituted system boundary. Executor admission, family
    // registration, request binding and response decoding remain production code.
    app.post('/v2/sessions/access-candidates/inspect', async (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer bound-home-token');
      const input = SessionAccessCandidatesInspectRequestV1Schema.parse(request.body);
      if (input.sessionId === 'forbidden') return reply.code(403).send({ error: 'session_access_forbidden' });
      return SessionAccessCandidatesInspectResponseV1Schema.parse(inspected);
    });
    app.post('/v1/session-access/principals/resolve', async (request) => {
      expect(ResolveSessionAccessPrincipalsRequestV1Schema.parse(request.body))
        .toEqual({ v: 1, subjects, creationTeamId: 'team' });
      return ResolveSessionAccessPrincipalsResponseV1Schema.parse(resolved);
    });
    app.get('/v1/user/search', async (request) => {
      expect(UsersSearchQueryV1Schema.parse(request.query))
        .toEqual({ query: 'a & b', purpose: 'collaboration', cursor: 'opaque-cursor' });
      return UsersSearchResponseSchema.parse({ users: [], nextCursor: null });
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
      token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test',
    }) });
    const context = { surface: 'agent' as const, authority: 'account_automation' as const, serverId: 'home' };
    await expect(executor.execute('session.access.candidates.inspect', {
      v: 1, sessionId: 'session', subjects: [{ kind: 'account', accountId: 'recipient' }],
    }, context)).resolves.toEqual({ ok: true, result: inspected });
    await expect(executor.execute('session.access.principals.resolve', {
      v: 1, subjects, creationTeamId: 'team',
    }, context)).resolves.toEqual({ ok: true, result: resolved });
    await expect(executor.execute('session.access.accounts.search', {
      query: 'a & b', purpose: 'collaboration', cursor: 'opaque-cursor',
    }, context)).resolves.toEqual({ ok: true, result: { users: [], nextCursor: null } });
    await expect(executor.execute('session.access.candidates.inspect', {
      v: 1, sessionId: 'forbidden', subjects: [],
    }, context)).resolves.toMatchObject({ ok: false, errorCode: 'session_access_forbidden' });
    await expect(executor.execute('session.access.principals.resolve', {
      v: 1, subjects, creationTeamId: 'team',
    }, { ...context, serverId: 'other-home' })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });
});
