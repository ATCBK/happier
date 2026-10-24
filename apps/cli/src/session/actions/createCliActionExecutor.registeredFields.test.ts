import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { V2SessionRecordSchema } from '@happier-dev/protocol/sessions/control/contract';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { AgentStartSessionCallerV1Schema } from '@happier-dev/protocol/account/settings/admitAgentStartV1';
import { SessionEffectiveAccessV1Schema, projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { createPlainSessionOwnerMetadataEnvelopeV1, SessionMetadataOwnerPatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createCliActionDeps } from './createCliActionDeps';

const boundary = vi.hoisted(() => ({
  session: null as RawSessionRecord | null,
  patches: [] as unknown[],
  refuse: false,
  reads: 0,
  race: null as 'unrelated' | 'same-field' | null,
  raceField: 'memory' as 'memory' | 'context' | 'instructions' | 'voice',
}));

// Only HTTP adapters are replaced: target lookup, Account-mode parsing, the
// registered field engine, envelope projection and metadata CAS remain real.
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById: async () => { boundary.reads += 1; return boundary.session; },
  fetchSessionByIdCompat: async () => { boundary.reads += 1; return boundary.session; },
  lookupSessionsByTags: async () => ({ state: 'available' as const, sessions: [] }),
  fetchSessionsPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  fetchSessionsQueryPage: async () => ({ sessions: [], nextCursor: null, hasNext: false }),
  patchSessionMetadataEnvelopeTuple: async (request: Readonly<{ patch: unknown }>) => {
    if (boundary.refuse) throw Object.assign(new Error('forbidden'), { status: 403 });
    boundary.patches.push(request.patch);
    if (boundary.session?.metadataLayoutVersion === 1) {
      const patch = SessionMetadataOwnerPatchV1Schema.parse(request.patch);
      const current = boundary.session;
      if (boundary.race) {
        if (current.ownerMetadata?.t !== 'plain') throw new Error('Missing plain owner fixture');
        const work = current.ownerMetadata.v.work;
        boundary.session = { ...current, metadataVersion: current.metadataVersion + 1,
          ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ ...current.ownerMetadata.v, work: {
            ...work, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Concurrent notes' },
            ...(boundary.race === 'same-field' ? boundary.raceField === 'memory' ? { memoryEnabled: true }
              : boundary.raceField === 'voice' ? { voicePreference: { providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'competing' } }
              : { promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'competing' }, enabled: true, placement: 'system_append' }] } : {}),
          } }) };
        boundary.race = null;
        return { success: false, error: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: boundary.session.metadataVersion }, agentState: { version: current.agentStateVersion } };
      }
      expect(patch.sharedMetadata.expectedVersion).toBe(current.metadataVersion);
      expect(patch.expectedOwnerMetadata).toEqual(current.ownerMetadata);
      boundary.session = { ...current, metadataVersion: current.metadataVersion + 1, metadata: patch.sharedMetadata.ciphertext,
        ownerMetadata: patch.ownerMetadata, agentState: patch.agentState.ciphertext, agentStateVersion: current.agentStateVersion! + 1 };
      return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: boundary.session.metadataVersion },
        agentState: { version: boundary.session.agentStateVersion } };
    }
    return { success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 5 }, agentState: { version: 8 } };
  },
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: async () => { boundary.reads += 1; return ({
    mode: 'plain', version: 1, signingKeyFingerprint: null,
    contentKeyFingerprint: null, updatedAt: 1,
    recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
  }); },
}));
vi.mock('@/session/transport/rpc/sessionRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/sessionRpc')>(),
  callSessionRpc: async () => { throw new Error('Account metadata Actions must not invoke execution-host RPC'); },
}));

const sessionId = 'c123456789012345678901234';

function executor() {
  return createActionExecutor(createCliActionDeps({
    token: 'token', credentials: { token: 'token', encryption: null,
      requesterSessionCredentialScope: { serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' } },
    sessionId, mode: 'plain', ctx: null, serverId: 'home',
    serverHttpBaseUrl: 'https://home.example.test',
  }));
}

describe('headless registered Session field Actions', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    boundary.patches.length = 0;
    boundary.refuse = false;
    boundary.reads = 0;
    boundary.race = null;
    boundary.session = V2SessionRecordSchema.parse({
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 0, metadataVersion: 4,
      metadata: JSON.stringify({ path: '/repo', host: 'host', summary: { text: 'Keep', updatedAt: 1 },
        work: { viewPreferences: { showToolCalls: true } } }),
      agentState: null, agentStateVersion: 7, dataEncryptionKey: null,
      effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }),
    });
  });

  it.each(['memory', 'context', 'instructions', 'voice'] as const)(
    'reapplies the headless %s Action after an unrelated writer, without overwriting a competing field edit', async field => {
      if (!boundary.session) throw new Error('Missing Home fixture');
      const initialOwner = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1, work: { memoryEnabled: false,
        promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: 'original' }, enabled: true, placement: 'system_append' }],
        voicePreference: { providerContributionId: 'example.voice/speech', settingFieldPath: 'voice', value: 'original' },
      } });
      boundary.session = { ...boundary.session, active: true, metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), ownerMetadata: initialOwner };
      boundary.raceField = field;
      const owner = executor();
      const target = { sessionId, serverId: 'home', expectedMetadataRevision: 3 };
      for (const surface of ['cli', 'agent', 'mcp'] as const) {
        boundary.session = { ...boundary.session, metadataVersion: 4, ownerMetadata: initialOwner };
        const context = { surface, authority: 'present_user', serverId: 'home', defaultSessionId: sessionId } as const;
        const execute = () => field === 'memory' ? owner.execute('session.memory.set', { ...target, enabled: true }, context)
          : field === 'context' ? owner.execute('session.context.update', { ...target, intent: { kind: 'detach', entryId: 'session.instructions' } }, context)
          : field === 'instructions' ? owner.execute('session.instructions.set', { ...target, ref: null }, context)
          : owner.execute('session.voice.preference.set', { ...target, preference: null }, context);
        boundary.race = 'unrelated';
        const applied = await execute();
        expect(applied, JSON.stringify({ surface, applied })).toMatchObject({ ok: true, result: { version: 6 } });
        expect(boundary.session.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Concurrent notes' },
          ...(field === 'memory' ? { memoryEnabled: true } : field === 'context' || field === 'instructions' ? { promptStack: [] } : {}),
        } } });
        if (field === 'voice' && boundary.session.ownerMetadata?.t === 'plain') expect(boundary.session.ownerMetadata.v.work).not.toHaveProperty('voicePreference');
        boundary.session = { ...boundary.session, ownerMetadata: initialOwner };
        boundary.race = 'same-field';
        const commitsBeforeConflict = boundary.patches.length;
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'conflict' });
        expect(boundary.patches).toHaveLength(commitsBeforeConflict + 1);
        expect(boundary.session.ownerMetadata).toMatchObject({ t: 'plain', v: { work: { sessionRolesV1: { notes: 'Concurrent notes' } } } });
      }
    },
  );

  it('refuses the real Action when its registered-field dependency is missing, without any metadata write', async () => {
    const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
      sessionId, mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.example.test' });
    const miswired = createActionExecutor({ ...deps, sessionStateFieldSet: undefined });
    expect(await miswired.execute('session.memory.set', { sessionId, serverId: 'home', expectedMetadataRevision: 4, enabled: true },
      { surface: 'cli', authority: 'present_user', serverId: 'home' })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(boundary.patches).toEqual([]);
  });

  it('refuses caller-local next-prompt mode selection before Home reads or writes, while immediate retains its metadata owner', async () => {
    const owner = executor();
    const input = { sessionId, permissionMode: 'read-only' };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
    expect(await owner.execute('session.permission_mode.set', { ...input, applyTiming: 'next_prompt' }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters', error: expect.stringContaining('session.message.send') });
    expect(boundary.reads).toBe(0);
    expect(boundary.patches).toEqual([]);
    expect(await owner.execute('session.permission_mode.set', { ...input, applyTiming: 'immediate' }, context))
      .toMatchObject({ ok: true, result: { ok: true, permissionMode: 'read-only' } });
    expect(boundary.reads).toBeGreaterThan(0);
    expect(boundary.patches.length).toBeGreaterThan(0);
  });

  it('writes owner metadata while the execution host is inactive, without any runtime RPC', async () => {
    const owner = executor();
    expect(await owner.execute('session.bot.set', { sessionId, bot: { kind: 'bot' } }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { ok: true, version: 5 } });
    expect(boundary.patches[0]).toMatchObject({ mode: 'owner_migration', target: { ownerMetadata: { t: 'plain', v: {
      work: { bot: { kind: 'bot' }, memoryEnabled: false, viewPreferences: { showToolCalls: true } },
    } } } });
    for (const surface of ['ui', 'voice', 'cli'] as const) {
      for (const showToolCalls of [true, false, null]) {
        if (!boundary.session) throw new Error('Missing Home fixture');
        boundary.session = { ...boundary.session, metadata: JSON.stringify({
          path: '/repo', host: 'host', summary: { text: 'Keep', updatedAt: 1 },
          work: { viewPreferences: { showToolCalls: showToolCalls === true ? false : true } },
        }) };
        expect(await owner.execute('session.view.toolCalls.set', { sessionId, showToolCalls }, {
          surface, authority: 'present_user', serverId: 'home',
        })).toMatchObject({ ok: true, result: { ok: true, version: 5 } });
        const patch = boundary.patches.at(-1);
        expect(patch).toMatchObject({ mode: 'owner_migration', target: { ownerMetadata: { t: 'plain' } } });
        if (showToolCalls === null) {
          expect(JSON.stringify(patch)).not.toContain('"showToolCalls"');
        } else {
          expect(patch).toMatchObject({ target: { ownerMetadata: { v: {
            work: { viewPreferences: { showToolCalls } },
          } } } });
        }
      }
    }
  });

  it('refuses denied or unavailable metadata rather than reporting success', async () => {
    boundary.refuse = true;
    expect(await executor().execute('session.bot.set', { sessionId, bot: null }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'forbidden' });
    boundary.refuse = false;
    boundary.session = null;
    expect(await executor().execute('session.bot.set', { sessionId, bot: null }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(boundary.patches).toEqual([]);
  });

  it('admits current Artifact headers and applies field intents despite older metadata observations', async () => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.session = { ...boundary.session, metadata: JSON.stringify({ path: '/repo', host: 'host', work: {
      memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Keep notes' },
      promptStack: [{ id: 'neighbor', ref: { kind: 'doc', artifactId: 'neighbor-doc' }, enabled: true, placement: 'composer_insert' }],
    } }) };
    const headers = ['instructions', 'dashboard'].map(id => ({
      id, ownerAccountId: 'account', access: 'owner', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent(id === 'instructions'
        ? { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' }
        : { v: 1, kind: 'prompt_bundle.v2', title: 'Dashboard', bundleSchemaId: 'dashboard.v1' }),
      publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    }));
    // The same Account Artifact store used by prompt Actions sees genuine HTTP-shaped data.
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      const request = new URL(String(url));
      expect(request.origin).toBe('https://home.example.test');
      expect(request.pathname).toBe('/v1/artifacts/read');
      expect(options?.headers?.Authorization).toBe('Bearer token');
      const { artifactIds } = ArtifactReadHeadersBatchInputV1Schema.parse(body);
      expect(artifactIds).toHaveLength(1);
      return { status: 200, data: ArtifactReadHeadersBatchResponseV1Schema.parse({
        projection: 'headers', items: artifactIds.map(artifactId => {
          const artifact = headers.find(header => header.id === artifactId);
          if (!artifact) throw new Error(`Unexpected selected Artifact: ${artifactId}`);
          return { artifactId, ok: true, artifact };
        }),
      }) };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const request = new URL(url);
      expect(request.origin).toBe('https://home.example.test');
      if (request.pathname === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      throw new Error(`Unexpected Artifact HTTP read: ${url}`);
    });
    const owner = createActionExecutor(createCliActionDeps({
      token: 'token', credentials: { token: 'token', encryption: null,
        requesterSessionCredentialScope: { serverId: 'home-profile', serverHttpBaseUrl: 'https://home.example.test' } },
      sessionId, mode: 'plain', ctx: null, serverId: 'home-profile', serverIdentityId: 'home',
      serverHttpBaseUrl: 'https://home.example.test',
    }));
    const target = { sessionId, serverId: 'home', expectedMetadataRevision: 4 };
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const deniedIntent = { kind: 'attach', entry: { id: 'dashboard', ref: { kind: 'bundle', artifactId: 'dashboard' } } };
    const denied = await owner.execute('session.context.update', { ...target, intent: deniedIntent }, context);
    expect(denied, JSON.stringify(denied))
      .toMatchObject({ ok: false, errorCode: 'attachment_unavailable' });
    expect(boundary.patches).toEqual([]);
    const ref = { kind: 'doc', artifactId: 'instructions', serverId: 'home' };
    expect(await owner.execute('session.instructions.set', { ...target, ref }, context))
      .toMatchObject({ ok: true, result: { version: 5, work: { memoryEnabled: false, sessionRolesV1: { notes: 'Keep notes' }, promptStack: [
        { id: 'neighbor', placement: 'composer_insert' }, { id: 'session.instructions', ref, required: true, placement: 'system_append' },
      ] } } });
    expect(await owner.execute('session.memory.set', { ...target, enabled: true }, context))
      .toMatchObject({ ok: true, result: { enabled: true, version: 5 } });
    expect(await owner.execute('session.memory.set', { ...target, expectedMetadataRevision: 3, enabled: true }, context))
      .toMatchObject({ ok: true });
    expect(await owner.execute('session.context.update', { ...target, expectedMetadataRevision: 3,
      intent: { kind: 'inherited_enable', entryId: 'inherited', enabled: false } }, context))
      .toMatchObject({ ok: true });
  });

  it('selects a Plan through the Context Action against the reviewed revision, preserving current neighboring metadata', async () => {
    if (!boundary.session) throw new Error('Missing Home fixture');
    boundary.session = { ...boundary.session, metadataVersion: 5, metadata: JSON.stringify({ path: '/repo', host: 'host', work: {
      memoryEnabled: false, sessionRolesV1: { overrides: {}, sessionRoles: {}, notes: 'Concurrent notes' }, promptStack: [
        { id: 'a', ref: { kind: 'doc', artifactId: 'doc-a' }, enabled: true, placement: 'system_append', plan: true },
        { id: 'b', ref: { kind: 'doc', artifactId: 'doc-b' }, enabled: false, placement: 'composer_insert', maxChars: 42 },
      ],
    } }) };
    const owner = executor();
    const context = { surface: 'cli', authority: 'present_user', serverId: 'home' } as const;
    const target = { sessionId, serverId: 'home', expectedMetadataRevision: 4, intent: { kind: 'set_plan', entryId: 'b' } };
    const selected = await owner.execute('session.context.update', target, context);
    expect(selected, JSON.stringify(selected))
      .toMatchObject({ ok: true, result: { work: { memoryEnabled: false, sessionRolesV1: { notes: 'Concurrent notes' }, promptStack: [
        { id: 'a' }, { id: 'b', plan: true, enabled: false, placement: 'composer_insert', maxChars: 42 },
      ] } } });
    expect(boundary.patches.at(-1)).toMatchObject({ target: { ownerMetadata: { t: 'plain', v: { work: {
      sessionRolesV1: { notes: 'Concurrent notes' }, promptStack: [
        { id: 'a' }, { id: 'b', plan: true, enabled: false, maxChars: 42 },
      ],
    } } } } });
    expect(JSON.stringify(boundary.patches.at(-1))).not.toContain('"planEntryId"');
    const patch = boundary.patches.at(-1) as { target: { ownerMetadata: { v: { work: { promptStack: unknown[] } } } } };
    expect(patch.target.ownerMetadata.v.work.promptStack[0]).not.toHaveProperty('plan');
  });

  it('preserves an existing Session memory choice and context when promoting or demoting its Bot marker', async () => {
    const stack = [{ id: 'own', ref: { kind: 'doc', artifactId: 'own-doc' }, enabled: true, placement: 'system_append' }];
    const owner = executor();
    for (const { bot, choice, expected } of [
      { bot: { kind: 'bot' }, choice: false, expected: false },
      { bot: null, choice: false, expected: false },
      { bot: null, choice: undefined, expected: true },
    ]) {
      if (!boundary.session) throw new Error('Missing Home fixture');
      boundary.session = { ...boundary.session, metadata: JSON.stringify({ path: '/repo', host: 'host',
        ...(bot === null ? { bot: { kind: 'bot' } } : {}), work: {
        ...(choice === undefined ? {} : { memoryEnabled: choice }), promptStack: stack, disabledInheritedEntryIds: ['inherited'],
      } }) };
      expect(await owner.execute('session.bot.set', { sessionId, bot }, { surface: 'cli', serverId: 'home' }))
        .toMatchObject({ ok: true, result: { version: 5 } });
      expect(boundary.patches.at(-1)).toMatchObject({ target: { ownerMetadata: { v: { work: {
        memoryEnabled: expected, promptStack: stack, disabledInheritedEntryIds: ['inherited'],
      } } } } });
    }
  });

  it('does not advertise autonomous write access to the human transcript preference', async () => {
    expect(await executor().execute('settings.list', { pageId: 'transcript' }, { surface: 'agent' }))
      .toMatchObject({ ok: true, result: { items: expect.arrayContaining([expect.objectContaining({ anchor: 'transcript.showToolCalls', writable: false })]) } });
  });

  it('does not let an authenticated Session agent hide tool calls through a human-looking surface', async () => {
    const owner = executor();
    const initialMetadata = boundary.session?.metadata;
    const actionCaller = AgentStartSessionCallerV1Schema.parse({ kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 });
    for (const surface of ['agent', 'mcp', 'ui', 'voice', 'cli'] as const) {
      const context = { surface, serverId: 'home', authority: 'present_user' as const, actionCaller };
      for (const showToolCalls of [false, null]) {
        const input = { sessionId, showToolCalls };
        expect(await owner.prepare('session.view.toolCalls.set', input, context))
          .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'action_disabled' } });
        expect(await owner.execute('session.view.toolCalls.set', input, context))
          .toMatchObject({ ok: false, errorCode: 'action_disabled' });
      }
      for (const actionId of ['settings.set', 'settings.invoke'] as const) {
        const input = { anchor: 'transcript.showToolCalls', ...(actionId === 'settings.set' ? { value: false } : {}) };
        expect(await owner.prepare(actionId, input, context))
          .toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'unsupported_action' } });
        expect(await owner.execute(actionId, input, context))
          .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      }
    }
    expect(boundary.patches).toEqual([]);
    expect(boundary.session?.metadata).toBe(initialMetadata);
  });
});
