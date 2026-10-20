import { describe, expect, it, vi } from 'vitest';

import type { Update } from '../types';
import { handleSessionNewMessageUpdate } from './sessionNewMessageUpdate';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

function createUserUpdate(): Update {
  return {
    id: 'update-1',
    seq: 1,
    createdAt: 1_000,
    body: {
      t: 'new-message',
      sid: 'session-1',
      message: {
        id: 'message-1',
        seq: 7,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'observation only' },
            localId: 'local-1',
            meta: { source: 'cli' },
          },
        },
        localId: 'local-1',
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    },
  } as Update;
}

function handle(
  update: Update,
  overrides: Partial<Omit<
    Parameters<typeof handleSessionNewMessageUpdate>[0],
    'mode' | 'ctx'
  >> & { mode?: 'e2ee' | 'plain' } = {},
) {
  return handleSessionNewMessageUpdate({
    update,
    serverId: 'home',
    sessionId: 'session-1',
    receivedMessageIds: new Set<string>(),
    lastObservedMessageSeq: 0,
    lastObservedUserMessageSeq: 0,
    emit: vi.fn(),
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    ...overrides,
    ...(overrides.mode === 'e2ee'
      ? { mode: 'e2ee' as const, ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' as const } }
      : { mode: 'plain' as const, ctx: null }),
  });
}

describe('handleSessionNewMessageUpdate', () => {
  it('stamps the exact authenticated requester and committed origin, ignoring authored attribution', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message' || update.body.message.content.t !== 'plain') throw new Error('unexpected fixture');
    Object.assign(update.body.message, {
      messageRole: 'user',
      inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: 'bob', sessionRelationship: 'sharedEditor' },
    });
    Object.assign(update.body.message.content.v as object, {
      actionRequestAttributionV1: { requester: { accountId: 'mallory' } },
    });
    const emit = vi.fn();
    handle(update, { emit });
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      actionRequestAttributionV1: {
        requestRef: 'local-1', requester: { accountId: 'bob' },
        persona: { sessionId: 'session-1' },
        origin: { kind: 'session', session: { sessionId: 'session-1' }, messageId: 'message-1' },
      },
    });
    const untrusted = createUserUpdate();
    if (untrusted.body?.t !== 'new-message' || untrusted.body.message.content.t !== 'plain') throw new Error('unexpected fixture');
    Object.assign(untrusted.body.message.content.v as object, { actionRequestAttributionV1: { requester: { accountId: 'mallory' } } });
    const untrustedEmit = vi.fn();
    handle(untrusted, { emit: untrustedEmit });
    expect(untrustedEmit.mock.calls[0]?.[1]).toHaveProperty('actionRequestAttributionV1', undefined);
  });

  it.each([
    { mode: 'plain', legacy: false },
    { mode: 'e2ee', legacy: false },
    { mode: 'plain', legacy: true },
  ] as const)('takes per-input constraints from the server receipt and overwrites body-authored claims ($mode, legacy: $legacy)', ({ mode, legacy }) => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message' || update.body.message.content.t !== 'plain') throw new Error('unexpected fixture');
    const callerInputConstraints = { models: null, permissionModes: ['default' as const] };
    const payload = update.body.message.content.v as Record<string, unknown>;
    if (legacy) payload.content = 'observation only';
    payload.callerInputConstraints = { models: null, permissionModes: null };
    const inputAdmissionReceipt = {
      v: 1, issuer: 'authenticatedMachine', callerInputConstraints,
    } as const;
    Object.assign(update.body.message, { inputAdmissionReceipt });
    if (mode === 'e2ee') update.body.message.content = { t: 'encrypted', c: encryptSessionPayload({
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' }, payload,
    }) };
    const emit = vi.fn();
    handle(update, { emit, mode });
    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ callerInputConstraints, inputAdmissionReceipt }));
    const untrusted = createUserUpdate();
    if (untrusted.body?.t !== 'new-message' || untrusted.body.message.content.t !== 'plain') throw new Error('unexpected fixture');
    (untrusted.body.message.content.v as Record<string, unknown>).callerInputConstraints = callerInputConstraints;
    const untrustedEmit = vi.fn();
    handle(untrusted, { emit: untrustedEmit });
    expect(untrustedEmit.mock.calls[0]?.[1]).toHaveProperty('callerInputConstraints', undefined);
  });

  it('does not weaken a malformed trusted caller constraint into unrestricted input', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    Object.assign(update.body.message, { inputAdmissionReceipt: {
      v: 1, issuer: 'authenticatedMachine', callerInputConstraints: { models: [], permissionModes: null },
    } });
    const emit = vi.fn();
    const result = handle(update, { emit });
    expect(emit).not.toHaveBeenCalledWith('user-message', expect.anything());
    expect(result.lastObservedUserMessageSeq).toBe(0);
  });

  it('emits ordinary transcript user observations', () => {
    const emit = vi.fn();

    const result = handle(createUserUpdate(), { emit });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(result.lastObservedUserMessageSeq).toBe(7);
  });

  it.each(['plain', 'e2ee'] as const)('rejects content that mismatches established %s mode before observation or cursor advancement', (mode) => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    if (mode === 'plain') {
      update.body.message.content = { t: 'encrypted', c: encryptSessionPayload({
        ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
        payload: { role: 'user', content: { type: 'text', text: 'wrong mode' } },
      }) };
    }
    const emit = vi.fn();
    const observeMessage = vi.fn();
    const receivedMessageIds = new Set<string>();
    const result = handle(update, { mode, emit, observeMessage, receivedMessageIds });
    expect(result).toMatchObject({ handled: true, lastObservedMessageSeq: 0, lastObservedUserMessageSeq: 0 });
    expect(emit).not.toHaveBeenCalled();
    expect(observeMessage).not.toHaveBeenCalled();
    expect(receivedMessageIds.size).toBe(0);
  });

  // cli-v0.2.11 SessionStoredMessageContentSchema accepts all three wire forms.
  it.each(['envelope', 'ciphertext', 'string'] as const)('opens the supported E2EE %s wire form before emitting its user observation', (wireForm) => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message' || update.body.message.content.t !== 'plain') throw new Error('unexpected fixture');
    const ciphertext = encryptSessionPayload({
      ctx: { encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' },
      payload: update.body.message.content.v,
    });
    // Simulate the actual transport boundary before its compatibility parser.
    Reflect.set(update.body.message, 'content', wireForm === 'string' ? ciphertext
      : wireForm === 'ciphertext' ? { ciphertext } : { t: 'encrypted', c: ciphertext });
    const emit = vi.fn();
    const result = handle(update, { mode: 'e2ee', emit });
    expect(result.lastObservedUserMessageSeq).toBe(7);
    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
  });

  it('suppresses a user row whose local id is owned by the durable transcript observation outbox', () => {
    const emit = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();
    const consumeLocallyAuthoredTranscriptObservationLocalId = vi.fn((localId: string) => localId === 'local-1');

    const result = handle(createUserUpdate(), {
      emit,
      observeCommittedUserMessageSeq,
      onConnectedServiceTurnLifecycleEvent,
      consumeLocallyAuthoredTranscriptObservationLocalId,
    });

    expect(consumeLocallyAuthoredTranscriptObservationLocalId).toHaveBeenCalledWith('local-1');
    expect(emit).not.toHaveBeenCalledWith('user-message', expect.anything());
    expect(observeCommittedUserMessageSeq).not.toHaveBeenCalled();
    expect(onConnectedServiceTurnLifecycleEvent).not.toHaveBeenCalled();
    expect(result.lastObservedUserMessageSeq).toBe(7);
  });

  it('does not let the legacy string marker forge catch-up history classification', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    Reflect.set(update.body.message, 'transcriptObservationProvenance', 'history');
    const emit = vi.fn();
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();

    const result = handle(update, {
      emit,
      observeMessage,
      observeCommittedUserMessageSeq,
      onConnectedServiceTurnLifecycleEvent,
    });

    expect(emit).toHaveBeenCalledWith('user-message', expect.objectContaining({ localId: 'local-1' }));
    expect(observeMessage).toHaveBeenCalledOnce();
    expect(observeCommittedUserMessageSeq).toHaveBeenCalledOnce();
    expect(onConnectedServiceTurnLifecycleEvent).toHaveBeenCalledOnce();
    expect(result.lastObservedUserMessageSeq).toBe(7);
  });

  it('does not let an ordinary live update forge history classification', () => {
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    update.body.message.sourceCreatedAt = 123;
    update.body.message.sourceUpdatedAt = 456;
    update.body.message.transcriptObservationProvenance = { kind: 'non_dependent', source: 'history' };
    const observeMessage = vi.fn();
    const observeCommittedUserMessageSeq = vi.fn();
    const onConnectedServiceTurnLifecycleEvent = vi.fn();

    handle(update, {
      observeMessage,
      observeCommittedUserMessageSeq,
      onConnectedServiceTurnLifecycleEvent,
    });

    expect(observeMessage).toHaveBeenCalledOnce();
    expect(observeCommittedUserMessageSeq).toHaveBeenCalledOnce();
    expect(onConnectedServiceTurnLifecycleEvent).toHaveBeenCalledOnce();
  });

  it('logs an invalid envelope by shape without leaking its string contents', () => {
    const debug = vi.fn();
    const update = createUserUpdate();
    if (update.body?.t !== 'new-message') throw new Error('unexpected fixture');
    update.body.message.content = { secret: 'DO_NOT_LOG' } as never;

    handle(update, { debug });

    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).toContain('secret');
    expect(logged).not.toContain('DO_NOT_LOG');
  });
});
