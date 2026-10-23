import { SessionTeamCredentialLaunchUnavailableError } from '@/session/services/sessionTeamCredentialLaunch';
import { logger } from '@/ui/logger';

import { readProviderBrokerEndpointUrl } from './providerBrokerPrivateProtocol';

type EndpointDiscoveryFailureCause = 'aborted' | 'timeout' | 'connection_reset' | 'connection_refused'
  | 'socket_closed' | 'http_response' | 'invalid_metadata' | 'transport_error' | 'broker_refresh_refused';

export type ProviderBrokerEndpointDiscoveryFailure = Readonly<{
  httpStatus?: number;
  discoveryCause?: EndpointDiscoveryFailureCause;
}>;

function endpointDiscoveryFailureCause(error: unknown, signal: AbortSignal, httpStatus?: number): EndpointDiscoveryFailureCause {
  if (signal.aborted) return 'aborted';
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'aborted';
    if (error.name === 'TimeoutError') return 'timeout';
  }
  if (httpStatus !== undefined) return httpStatus === 204 ? 'invalid_metadata' : 'http_response';
  // Fetch wraps socket failures in TypeError.cause. Only fixed codes become
  // diagnostics; raw names/messages/objects can contain private broker data.
  const cause = error instanceof Error && error.cause ? error.cause : error;
  const code = cause !== null && typeof cause === 'object' && 'code' in cause ? cause.code : undefined;
  switch (code) {
    case 'ECONNRESET': return 'connection_reset';
    case 'ECONNREFUSED': return 'connection_refused';
    case 'UND_ERR_SOCKET': return 'socket_closed';
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT': return 'timeout';
    default: return 'transport_error';
  }
}

/** Account and Team supply different signed authority, but acquire the same
 * private endpoint. Keep refresh evidence here before native can erase a
 * refused handshake into an HTTP socket close. No authority enters diagnostics. */
export function createProviderBrokerEndpointDiscovery() {
  let httpStatus: number | undefined;
  let discoveryCause: EndpointDiscoveryFailureCause | undefined;
  let refreshOutcome: 'not_requested' | 'pending' | 'accepted' | 'refused' | 'failed' = 'not_requested';
  let refreshStartedAt: number | undefined;
  let refreshElapsedMs: number | undefined;
  const failureDiagnostic = (): ProviderBrokerEndpointDiscoveryFailure => ({
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(discoveryCause === undefined ? {} : { discoveryCause }),
  });
  const refuse = (error: unknown, signal: AbortSignal, startedAt: number): never => {
    discoveryCause ??= endpointDiscoveryFailureCause(error, signal, httpStatus);
    try {
      logger.warnLocalFile('[ProviderBroker] Endpoint discovery refused', {
        reason: 'endpoint_discovery_failed', ...failureDiagnostic(),
        discoveryElapsedMs: Date.now() - startedAt, refreshOutcome,
        ...(refreshStartedAt === undefined ? {} : { refreshElapsedMs: refreshElapsedMs ?? Date.now() - refreshStartedAt }),
      });
    } catch { /* Diagnostic failure must not replace the refusal. */ }
    signal.throwIfAborted();
    if (error instanceof SessionTeamCredentialLaunchUnavailableError) throw error;
    throw new SessionTeamCredentialLaunchUnavailableError('provider_endpoint_unavailable');
  };
  return {
    failureDiagnostic,
    async openTunnel<T>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
      const startedAt = Date.now();
      try { return await open(); }
      catch (error) {
        if (refreshOutcome === 'refused' || refreshOutcome === 'failed') return refuse(error, signal, startedAt);
        throw error;
      }
    },
    async refreshBrokerOpen<T extends Readonly<{ ok: boolean }>>(open: () => Promise<T>, signal: AbortSignal): Promise<T> {
      refreshOutcome = 'pending';
      refreshStartedAt = Date.now();
      refreshElapsedMs = undefined;
      try {
        const refreshed = await open();
        refreshOutcome = refreshed.ok ? 'accepted' : 'refused';
        if (!refreshed.ok) discoveryCause = 'broker_refresh_refused';
        return refreshed;
      } catch (error) {
        refreshOutcome = 'failed';
        discoveryCause = endpointDiscoveryFailureCause(error, signal);
        throw error;
      } finally {
        refreshElapsedMs = Date.now() - refreshStartedAt;
      }
    },
    async readEndpointUrl(input: Parameters<typeof readProviderBrokerEndpointUrl>[0]): Promise<string> {
      const startedAt = Date.now();
      try {
        return await readProviderBrokerEndpointUrl({ ...input, fetchImpl: async (request, options) => {
          const response = await (input.fetchImpl ?? fetch)(request, options);
          httpStatus = response.status;
          return response;
        } });
      } catch (error) {
        return refuse(error, input.signal, startedAt);
      }
    },
  };
}
