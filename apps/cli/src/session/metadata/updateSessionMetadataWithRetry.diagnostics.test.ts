import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { readSessionMetadataTupleWriterSnapshot, updateSessionMetadataEnvelopeTupleWithRetry } from './updateSessionMetadataWithRetry';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { V2SessionByIdResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';

const credentials = { token: 'private-fixture-token', encryption: null };
const accountEncryptionCurrentness = { mode: 'plain' as const, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable' as const, reason: 'plain_account' as const } };

function createRequest() {
  const initialSnapshot = readSessionMetadataTupleWriterSnapshot({ credentials, accountEncryptionCurrentness, rawSession: {
    metadataLayoutVersion: 0, encryptionMode: 'plain', metadata: JSON.stringify({ path: '/private/workspace', host: 'host' }), metadataVersion: 4, ownerMetadata: null, agentState: null, agentStateVersion: 2,
  } });
  if (initialSnapshot.mode !== 'legacy_owner') throw new Error('Expected legacy owner fixture');
  return { token: credentials.token, sessionId: 'diagnostic-session', authority: { kind: 'owner' as const, credentials, accountEncryptionCurrentness }, mode: 'plain' as const, ctx: null, initialSnapshot,
    mutation: { kind: 'metadata' as const, update: (metadata: typeof initialSnapshot.value.metadata) => ({ ...metadata, name: 'private-title' }) } };
}

describe('metadata tuple terminal diagnostics', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(['unchanged', 'committed', 'retired', 'exhausted'] as const)('reconciles an HTTP 500 tuple publication with a %s source through the real transport', async disposition => {
    const request = createRequest();
    let raw = V2SessionByIdResponseSchema.parse({ session: {
      id: request.sessionId, seq: 0, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
      encryptionMode: 'plain', metadataLayoutVersion: 0,
      metadata: request.initialSnapshot.metadataCiphertext,
      agentState: null, metadataVersion: 4, agentStateVersion: 2, dataEncryptionKey: null,
    } }).session;
    let current = true;
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      const submitted = SessionMetadataTuplePatchV1Schema.parse(body);
      if (submitted.mode !== 'owner_migration') throw new Error('Expected owner migration');
      if (disposition === 'committed' || (disposition !== 'exhausted' && patch.mock.calls.length > 1)) {
        raw = V2SessionByIdResponseSchema.parse({ session: { ...raw,
          metadataLayoutVersion: 1, metadata: submitted.target.sharedMetadata.ciphertext,
          ownerMetadata: submitted.target.ownerMetadata, agentState: submitted.target.agentState.ciphertext,
          metadataVersion: 5, agentStateVersion: 3, share: null,
        } }).session;
      }
      if (patch.mock.calls.length === 1 || disposition === 'exhausted') return { status: 500, data: { code: 'internal_error' } };
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 5 }, agentState: { version: 3 } } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).includes('/v1/account/encryption/currentness')) return { status: 200, data: accountEncryptionCurrentness };
      if (disposition === 'retired') current = false;
      return { status: 200, data: { session: raw } };
    });
    const run = updateSessionMetadataEnvelopeTupleWithRetry({ ...request, maxAttempts: 2,
      currentness: { verifyCurrent: async () => current } });
    if (disposition === 'exhausted') {
      const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
      const failure: unknown = await run.catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'metadata_tuple_ambiguous', retryable: false });
      const issue = SessionRuntimeIssueV1Schema.parse(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: failure }));
      expect(issue).toMatchObject({ code: 'preparation_pending', source: 'dependency_failure' });
      expect(reportSessionRunnerFailure(failure)).toBe(1);
      expect(fatal).not.toHaveBeenCalled();
      expect(patch).toHaveBeenCalledTimes(2);
    } else if (disposition === 'retired') {
      await expect(run).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
      expect(patch).toHaveBeenCalledOnce();
    } else {
      await expect(run).resolves.toMatchObject({ metadataVersion: 5, agentStateVersion: 3,
        value: { metadata: { name: 'private-title' } } });
      expect(patch).toHaveBeenCalledTimes(disposition === 'committed' ? 1 : 2);
    }
  });

  it('reports terminal failure once at the canonical tuple writer without logging secrets or changing the snapshot', async () => {
    const failure = new Error('private-transport-response');
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    const patch = vi.spyOn(axios, 'patch').mockRejectedValue(failure);
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const request = createRequest();
    const before = JSON.stringify(request.initialSnapshot);
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(request)).rejects.toBe(failure);
    expect(patch).toHaveBeenCalledOnce();
    expect(JSON.stringify(request.initialSnapshot)).toBe(before);
    expect(info).toHaveBeenCalledExactlyOnceWith('[API] session_metadata_update_failed', { phase: 'terminal_failure', operation: 'update-metadata', sessionId: 'diagnostic-session' });
    const diagnostic = JSON.stringify(info.mock.calls);
    expect(diagnostic).not.toContain('private-transport-response');
    expect(diagnostic).not.toContain('private-title');
    expect(diagnostic).not.toContain(credentials.token);
    expect(diagnostic).not.toContain('/private/workspace');
    expect(reportSessionRunnerFailure(failure)).toBe(1);
    expect(fatal).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it('keeps cancellation and superseded-publisher outcomes quiet and preserves their original result', async () => {
    const info = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 409, data: { code: 'session_publisher_authority_lost' } });
    await expect(updateSessionMetadataEnvelopeTupleWithRetry(createRequest())).rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
    const controller = new AbortController();
    const cancelled = new Error('fixture-cancelled');
    controller.abort(cancelled);
    await expect(updateSessionMetadataEnvelopeTupleWithRetry({ ...createRequest(), currentness: { signal: controller.signal } })).rejects.toBe(cancelled);
    expect(patch).toHaveBeenCalledOnce();
    expect(info).not.toHaveBeenCalled();
  });
});
