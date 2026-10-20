import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

import { openCursorAcpExecutionRun, openCursorAcpSession } from '../acp/connection.js';

export const createCursorAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return openCursorAcpSession(request, context);
    },
    executionRunContextV1: { open: openCursorAcpExecutionRun },
  },
});
export { cursorExternalSessionsContribution } from '../externalSessions/contribution.js';
