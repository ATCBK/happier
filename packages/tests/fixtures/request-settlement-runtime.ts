import { readFile } from 'node:fs/promises';

import type { Session } from '../../../apps/cli/src/api/types';
import { waitFor } from '../src/testkit/timing';

const input = JSON.parse(await readFile(process.argv[2], 'utf8')) as {
  phase: 'admit' | 'recover'; token: string; secret: number[]; session: Session; requestId: string;
};
process.stdout.write(`Runtime ${input.phase}: loading current CLI source\n`);
const { writeCredentialsLegacy } = await import('../../../apps/cli/src/persistence');
await writeCredentialsLegacy({ token: input.token, secret: Uint8Array.from(input.secret) });
const { ApiSessionClient } = await import('../../../apps/cli/src/api/session/sessionClient');
const { AgentStateRequestStore } = await import('../../../apps/cli/src/agent/permissions/agentStateRequestStore');
process.stdout.write(`Runtime ${input.phase}: constructing session client\n`);
const client = new ApiSessionClient(input.token, input.session);
if (input.phase === 'admit') {
  const requests = new AgentStateRequestStore({ session: client, logPrefix: '[Settlement recovery test]' });
  await requests.completeRequest({ requestId: input.requestId, status: 'approved', decision: 'approved' });
  // Model the runtime ending immediately after durable admission, without a graceful flush.
  process.exit(0);
}
await waitFor(() => {
  const state = client.getAgentStateSnapshot();
  return state?.completedRequests?.[input.requestId]?.status === 'approved'
    && state.requests?.[input.requestId] === undefined;
}, { timeoutMs: 60_000, context: 'recovered request settlement acknowledgement' });
await client.close();
process.exit(0);
