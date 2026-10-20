import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { mergeSessionWorkStateMetadataV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateMerge';
import { buildDeterministicSessionWorkStateItemId } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateItemIds';
import { readSessionWorkStateV1FromMetadata, type SessionWorkStateItemV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { SessionGoalSetRequestV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';

import type { SessionGoalControlAdapter, SessionGoalControlAdapterParams } from './sessionGoalControlTypes';

const goalId = buildDeterministicSessionWorkStateItemId({ kind: 'goal', sourceFamily: 'happier', stableParts: ['session-goal'] });

function result(metadata: Record<string, unknown>) {
  return { metadata, workState: readSessionWorkStateV1FromMetadata(metadata), nativeGoalOwner: false };
}

function writeGoal(params: SessionGoalControlAdapterParams, goal: SessionWorkStateItemV1 | null) {
  const current = readSessionWorkStateV1FromMetadata(params.metadata);
  const agentId = resolveAgentIdFromSessionMetadata(params.metadata);
  return result(mergeSessionWorkStateMetadataV1({ metadata: params.metadata,
    ownedItemIds: [goalId], nextOwned: {
      v: 1, backendId: current?.backendId ?? agentId ?? 'happier',
      ...(agentId ? { agentId } : {}), updatedAt: Date.now(), items: goal ? [goal] : [],
    },
  }));
}

/** Session-owned objectives for Agents without native Goal controls. Continuation belongs to Keep going. */
export const happierSessionGoalControlAdapter: SessionGoalControlAdapter = {
  async getGoal(params) {
    return result(params.metadata);
  },
  async setGoal(params) {
    const parsed = SessionGoalSetRequestV1Schema.safeParse(params.request);
    if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
    const request = parsed.data;
    const current = readSessionWorkStateV1FromMetadata(params.metadata)?.items.find(item => item.id === goalId);
    const title = request.objective ?? current?.title;
    if (!title) return { ok: false, errorCode: 'goal_objective_required', error: 'goal_objective_required' };
    const now = Date.now();
    const status = request.status ?? current?.status ?? 'active';
    const { completedAt: _completedAt, ...retained } = current ?? {};
    return writeGoal(params, {
      ...retained, id: goalId, kind: 'goal', origin: 'happier', title, status,
      ...(request.tokenBudget === undefined ? {} : { tokenBudget: request.tokenBudget }),
      createdAt: current?.createdAt ?? now, startedAt: current?.startedAt ?? now, updatedAt: now,
      ...(status === 'complete' ? { completedAt: current?.completedAt ?? now } : {}),
    });
  },
  async clearGoal(params) {
    return writeGoal(params, null);
  },
};
