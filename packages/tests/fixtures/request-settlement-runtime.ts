import { readFile } from 'node:fs/promises';

import type { Session } from '../../../apps/cli/src/api/types';
import { waitFor } from '../src/testkit/timing';

const input = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  phase: 'admit' | 'recover'; token: string; session: Session; requestId: string;
};
process.stdout.write('Loading session runtime\n');
const { ApiSessionClient } = await import('../../../apps/cli/src/api/session/sessionClient');
const { createAccountSessionClientTransport } = await import('../../../apps/cli/src/api/client/createAccountSessionClientTransport');
const { AgentStateRequestStore } = await import('../../../apps/cli/src/agent/permissions/agentStateRequestStore');
const { createPermissionRequestCoordinator } = await import('../../../apps/cli/src/agent/permissions/permissionRequestCoordinator');
process.stdout.write('Constructing session runtime\n');
const client = new ApiSessionClient(input.token, input.session, {
  transport: createAccountSessionClientTransport(input.token),
  metadataAuthority: { kind: 'owner', credentials: { token: input.token, encryption: null } },
});
process.stdout.write(`Starting ${input.phase} phase\n`);
if (input.phase === 'admit') {
  const store = new AgentStateRequestStore({ session: client, logPrefix: '[Settlement recovery live]' });
  const coordinator = createPermissionRequestCoordinator({ store });
  const request = store.readOutstandingRequest(input.requestId);
  if (!request) throw new Error('Missing observed retirement request');
  const controller = new AbortController();
  const pending = coordinator.requestDecision({ requestId: input.requestId, toolName: request.toolName,
    toolInput: request.toolInput, createdAt: request.createdAt }, { signal: controller.signal });
  controller.abort();
  await pending.then(() => { throw new Error('Offline cancellation unexpectedly acknowledged'); }, error => {
    if (!(error instanceof Error) || !error.message.includes('awaiting acknowledged delivery')) throw error;
  });
  process.stdout.write('Observed cancellation privately admitted before failed ACK\n');
  // End this process without a graceful flush after the journal proves admission.
  process.exit(0);
}
await waitFor(async () => {
  await client.flushDurableMutationDelivery();
  const state = client.getAgentStateSnapshot();
  return state?.completedRequests?.[input.requestId]?.status === 'canceled'
    && state.requests?.[input.requestId] === undefined;
}, { timeoutMs: 60_000, context: 'recovered observed cancellation acknowledgement' });
await client.close();
process.stdout.write('Observed cancellation acknowledged through current metadata tuple owner\n');
process.exit(0);
