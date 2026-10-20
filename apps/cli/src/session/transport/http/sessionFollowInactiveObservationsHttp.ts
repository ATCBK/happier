import axios from 'axios';
import { SessionFollowObserveInactiveRequestV1Schema, SessionFollowObserveInactiveResponseV1Schema,
  type SessionFollowObserveInactiveResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';

/** Read-only exact retained placement; this creates neither a runtime principal nor an ACK. */
export async function fetchInactiveSessionFollowObservations(input: Readonly<{
  token: string; destinationSessionId: string; machineId: string; installationId: string;
  signal?: AbortSignal;
}>): Promise<SessionFollowObserveInactiveResponseV1 | null> {
  const body = SessionFollowObserveInactiveRequestV1Schema.parse({ v: 1, machineId: input.machineId, installationId: input.installationId });
  const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.inactiveObservations.replace(':destinationSessionId', encodeURIComponent(input.destinationSessionId));
  const response = await axios.post<unknown>(`${resolveServerHttpBaseUrl()}${path}`, body, {
    headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.token}` },
    timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (response.status === 403 || response.status === 404) return null;
  if (response.status !== 200) throw new Error(`Unexpected inactive Session Follow observation status: ${response.status}`);
  const parsed = SessionFollowObserveInactiveResponseV1Schema.safeParse(response.data);
  if (!parsed.success) throw new Error('Invalid inactive Session Follow observation response');
  if (parsed.data.ok && parsed.data.sessionId !== input.destinationSessionId) throw new Error('Inactive Session Follow identity mismatch');
  if (!parsed.data.ok && parsed.data.error === 'internal') throw new Error('Inactive Session Follow observation unavailable');
  return parsed.data;
}
