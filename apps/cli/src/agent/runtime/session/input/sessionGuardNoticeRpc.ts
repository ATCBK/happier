import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionGuardNoticeRequestV1Schema, SessionGuardNoticeResponseV1Schema,
  buildSessionStopTranscriptEventV1, readSessionMemoryCeilingOverride, applySessionMemoryCeilingOverrideToMetadata,
  type SessionGuardNoticeRequestV1 } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { SessionGuardStateV1Schema } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { buildSessionStopSystemRecordLocalId } from '@happier-dev/protocol/sessions/system/records/activity/activitySystemRecordKinds';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';
import type { ActivityNotificationEvent } from '@/notifications/activity/activityNotificationEvent';
import { commitRuntimeSessionEvent } from '@/agent/runtime/session/transcripts/publishRuntimeSessionEvent';
import type { RuntimeTranscriptProjectionSession } from '@/agent/runtime/session/transcripts/projectRuntimeTranscriptEvent';

export type SessionGuardNoticeOwner = Readonly<{
  session: Pick<ApiSessionClient, 'sessionId' | 'getMetadataSnapshot' | 'checkCurrentPublisherAuthority' | 'updateMetadataAsCurrentPublisher'>
    & Pick<SessionClientPort, 'getStoredContentEncryptionContext' | 'upsertSessionSystemRecord' | 'fetchSessionSystemRecord'>
    & RuntimeTranscriptProjectionSession;
  machineId: string;
  agentId: string;
  notify: (event: Extract<ActivityNotificationEvent, { topic: 'guard_stop_warning' | 'guard_attention' }>) => Promise<void>;
}>;

/** New runners retire the previous runtime's presentation through the same publisher CAS. */
export async function clearSessionGuardStateOnRunnerStart(owner: SessionGuardNoticeOwner): Promise<void> {
  const session = owner.session;
  if (!session.getMetadataSnapshot()?.sessionGuardStateV1) return;
  if (!await session.checkCurrentPublisherAuthority() || owner.session !== session) return;
  await session.updateMetadataAsCurrentPublisher(metadata => {
    const { sessionGuardStateV1: _previous, ...next } = metadata;
    const ceilingBytes = readSessionMemoryCeilingOverride(metadata);
    return ceilingBytes === undefined ? next : { ...next, sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes } };
  });
}

export function registerSessionGuardNoticeRpc(params: SessionGuardNoticeOwner & Readonly<{
  rpcHandlerRegistrar: RpcHandlerRegistrar;
}>): void {
  params.rpcHandlerRegistrar.registerHandler(SESSION_RPC_METHODS.SESSION_GUARD_NOTICE, async raw => {
    const session = params.session;
    const request = SessionGuardNoticeRequestV1Schema.safeParse(raw);
    if (!request.success || request.data.sessionId !== session.sessionId) return { ok: false };
    const state = request.data.state;
    const isCurrent = async () => params.session === session && await session.checkCurrentPublisherAuthority();
    try {
      if (!await isCurrent()) return { ok: false };
      if (state.kind === 'notify_ceiling') {
        if (!params.machineId) return { ok: false };
        await params.notify({ topic: 'guard_attention', machineId: params.machineId,
          sessionId: session.sessionId, kind: state.notice });
        return { ok: await isCurrent() };
      }
      if (state.kind === 'notify_terminal_warning') {
        if (!params.machineId) return { ok: false };
        const { kind: _kind, ...warning } = state;
        await params.notify({ topic: 'guard_stop_warning', machineId: params.machineId,
          ...warning, rule: 'idle_terminals' });
        return { ok: await isCurrent() };
      }
      if (state.kind === 'stopped') {
        const { kind: _kind, ...facts } = state;
        const localId = buildSessionStopSystemRecordLocalId({ at: state.at });
        const event = buildSessionStopTranscriptEventV1({ v: 1, ...facts, status: 'requested' });
        await createSessionSystemRecordPayloadService(session).write({
          namespace: 'activity', kind: 'session_stop.v1',
          localId, payload: event.sessionStopV1,
        });
        if (!await isCurrent()) return { ok: false };
        await commitRuntimeSessionEvent({ session, agentId: params.agentId, localId, event });
        if (!await isCurrent()) return { ok: false };
      }
      await session.updateMetadataAsCurrentPublisher(metadata => {
        const ceilingBytes = readSessionMemoryCeilingOverride(metadata);
        if (state.kind === 'clear') {
          const { sessionGuardStateV1: _previous, ...next } = metadata;
          return ceilingBytes === undefined ? next : { ...next, sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes } };
        }
        if (state.kind === 'ceiling') {
          return applySessionMemoryCeilingOverrideToMetadata(metadata, state.bytes);
        }
        // Receipt ceilingBytes is the applied cap, not a new Session override.
        const { ceilingBytes: _receipt, ...presentation } = state.kind === 'stopped' ? state : { ...state, ceilingBytes: undefined };
        return { ...metadata, sessionGuardStateV1: SessionGuardStateV1Schema.parse({ v: 1, ...presentation,
          ...(state.kind === 'stopped' ? { kind: 'requested' as const } : {}),
          ...(ceilingBytes === undefined ? {} : { ceilingBytes }) }) };
      });
      if (!await isCurrent()) return { ok: false };
      if (state.kind === 'stopping') {
        if (!params.machineId) return { ok: false };
        // The warning names what stops and where (lab `rg` G3-3); these words never enter the routing data.
        const snapshot = session.getMetadataSnapshot();
        const sessionTitle = typeof snapshot?.name === 'string' && snapshot.name.trim() ? snapshot.name.trim() : undefined;
        const machineName = typeof snapshot?.host === 'string' && snapshot.host.trim() ? snapshot.host.trim() : undefined;
        await params.notify({ topic: 'guard_stop_warning', machineId: params.machineId,
          sessionId: session.sessionId, stopAt: state.stopAt, rule: state.rule,
          ...(sessionTitle ? { sessionTitle } : {}), ...(machineName ? { machineName } : {}) });
        if (!await isCurrent()) return { ok: false };
      }
      return { ok: true };
    } catch {
      // No stop is admitted by the daemon unless this exact runner acknowledges its durable receipt.
      return { ok: false };
    }
  });
}

export async function requestSessionGuardNotice(params: Readonly<{
  callRpc: (method: string, request: SessionGuardNoticeRequestV1) => Promise<unknown>;
  request: SessionGuardNoticeRequestV1;
}>): Promise<Readonly<{ ok: boolean }>> {
  return SessionGuardNoticeResponseV1Schema.parse(await params.callRpc(
    SESSION_RPC_METHODS.SESSION_GUARD_NOTICE, SessionGuardNoticeRequestV1Schema.parse(params.request),
  ));
}
