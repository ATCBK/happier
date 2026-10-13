import {
  resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1,
} from '../../reach/capabilityApplyTimingV1.js';
import {
  readSessionCapabilitySelectionFromMetadataV1, writeSessionCapabilitySelectionToMetadataV1,
} from '../../reach/sessionCapabilityMetadataV1.js';
import type { SessionCapabilitiesSetInputV1, SessionCapabilitiesSetOutputV1 } from '../specs/sessionCapabilities.js';
import type { ActionExecutorContext } from './types.js';
import { readSessionCapabilityOverrideV1, setSessionCapabilitySelectionItemV1 } from '../../reach/sessionCapabilitySelectionV1.js';

export type SessionCapabilitiesActionSnapshotV1 = Readonly<{
  metadata: object; revision: number; sessionRunning: boolean;
  agent: CapabilityApplyTimingInputV1['agent']; launchRestart: CapabilityApplyTimingInputV1['launchRestart'];
}>;
export type SessionCapabilitiesActionPortV1 = Readonly<{
  readSession: (input: Readonly<{ sessionId: string; serverId?: string }>, context: ActionExecutorContext) => Promise<SessionCapabilitiesActionSnapshotV1 | null>;
  resolveItem: (input: Readonly<{ kind: SessionCapabilitiesSetInputV1['kind']; id: string; sessionId: string; serverId?: string }>, context: ActionExecutorContext) => Promise<string | null>;
  writeMetadata: (input: Readonly<{ sessionId: string; serverId?: string; expectedRevision: number; metadata: object }>, context: ActionExecutorContext) => Promise<'updated' | 'conflict'>;
}>;

/** Opaque ids win over display names; a duplicate name must never pick an arbitrary item. */
export function resolveSessionCapabilityItemIdentityV1(items: readonly Readonly<{ id: string; name: string }>[], idOrName: string): string | null {
  const exact = items.find(item => item.id === idOrName);
  if (exact) return exact.id;
  const named = items.filter(item => item.name === idOrName);
  return named.length === 1 ? named[0]!.id : null;
}

/** All Session include/exclude writes, including D26 creates, use this operation and the metadata codec. */
export async function setSessionCapabilityV1(input: Readonly<{
  port: SessionCapabilitiesActionPortV1; request: SessionCapabilitiesSetInputV1; context: ActionExecutorContext;
}>): Promise<SessionCapabilitiesSetOutputV1> {
  const { port, request, context } = input;
  const address = { sessionId: request.sessionId, ...(context.serverId ? { serverId: context.serverId } : {}) };
  let snapshot: SessionCapabilitiesActionSnapshotV1 | null;
  try { snapshot = await port.readSession(address, context); }
  catch { context.signal?.throwIfAborted(); return { ok: false, code: 'session_unavailable' }; }
  if (!snapshot) return { ok: false, code: 'not_found' };
  const applyTiming = resolveCapabilityApplyTimingV1({ kind: request.kind, sessionRunning: snapshot.sessionRunning,
    agent: snapshot.agent, launchRestart: snapshot.launchRestart });
  if (applyTiming.t === 'new_sessions_only') return { ok: false, code: 'applies_to_new_sessions_only' };
  let id: string | null;
  try { id = await port.resolveItem({ ...address, kind: request.kind, id: request.id }, context); }
  catch { context.signal?.throwIfAborted(); return { ok: false, code: 'session_unavailable' }; }
  if (!id) return { ok: false, code: 'not_found' };
  const current = readSessionCapabilitySelectionFromMetadataV1(snapshot.metadata);
  const previous = readSessionCapabilityOverrideV1(current, request.kind, id);
  const selection = setSessionCapabilitySelectionItemV1(current, request.kind, id, request.state);
  const metadata = writeSessionCapabilitySelectionToMetadataV1(snapshot.metadata,
    request.kind === 'mcp_server' ? { mcp: selection.mcp } : { skills: selection.skills }, { sessionActive: snapshot.sessionRunning });
  const written = await port.writeMetadata({ ...address, expectedRevision: snapshot.revision, metadata }, context);
  return written === 'conflict' ? { ok: false, code: 'conflict' }
    : { ok: true, state: request.state, previous, applyTiming };
}
