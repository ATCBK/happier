import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1 } from '@happier-dev/protocol/server/http/connectionLifetimeV1';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type DirectHttpAgents = Readonly<{
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}>;

function createKeepAliveAgentOptions(input: Readonly<{
  serverKeepAliveTimeoutMs: number;
  retireBufferMs: number;
}>) {
  if (!Number.isSafeInteger(input.serverKeepAliveTimeoutMs) || input.serverKeepAliveTimeoutMs < 2) {
    throw new Error('Server keep-alive timeout must be an integer of at least 2ms');
  }
  if (!Number.isSafeInteger(input.retireBufferMs)
    || input.retireBufferMs < 1
    || input.retireBufferMs >= input.serverKeepAliveTimeoutMs) {
    throw new Error('HTTP free-socket retirement buffer must be below the server keep-alive timeout');
  }
  return {
    keepAlive: true,
    agentKeepAliveTimeoutBuffer: input.retireBufferMs,
    // Node's Agent timeout handler destroys a timed-out socket only while it
    // is in the free pool, so this bounds idle reuse without capping a request.
    timeout: input.serverKeepAliveTimeoutMs - input.retireBufferMs,
  };
}

export function createDirectHttpAgents(input: Readonly<{
  serverKeepAliveTimeoutMs: number;
  retireBufferMs: number;
}>): DirectHttpAgents {
  const options = createKeepAliveAgentOptions(input);
  return {
    httpAgent: new HttpAgent(options),
    httpsAgent: new HttpsAgent(options),
  };
}

// Node's own keep-alive race buffer is one second. Reuse that established
// transport margin: 72_000ms server idle close - 1_000ms = 71_000ms maximum
// client free-socket lifetime. The timer is unconditional because an HTTP
// intermediary is not required to preserve the server's Keep-Alive hint.
const CLIENT_HTTP_FREE_SOCKET_RETIRE_BUFFER_MS = 1_000;
const clientKeepAliveAgentOptions = createKeepAliveAgentOptions({
  serverKeepAliveTimeoutMs: SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1,
  retireBufferMs: CLIENT_HTTP_FREE_SOCKET_RETIRE_BUFFER_MS,
});
const directAgents: DirectHttpAgents = {
  httpAgent: new HttpAgent(clientKeepAliveAgentOptions),
  httpsAgent: new HttpsAgent(clientKeepAliveAgentOptions),
};

export function getDirectHttpAgents(): DirectHttpAgents {
  return directAgents;
}

// Cache by normalized proxy URL so we don't allocate new agents per request.
const httpsProxyAgentByProxyUrl = new Map<string, HttpsProxyAgent<string>>();

export function getHttpsProxyAgent(proxyUrl: string): HttpsProxyAgent<string> {
  const existing = httpsProxyAgentByProxyUrl.get(proxyUrl);
  if (existing) return existing;
  const agent = new HttpsProxyAgent(proxyUrl, clientKeepAliveAgentOptions);
  httpsProxyAgentByProxyUrl.set(proxyUrl, agent);
  return agent;
}

