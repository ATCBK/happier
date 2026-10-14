import { useAgentModelChoices, type AgentModelSelection } from '@/components/settings/pickers/useAgentModelChoices';

export type ScmDiffSummaryModelSelection = AgentModelSelection;

/** SCM's observation adapter; the Agent/model choices have one owner. */
export function useScmDiffSummaryModelChoices(params: Omit<Parameters<typeof useAgentModelChoices>[0], 'purpose'>) {
    return useAgentModelChoices({ ...params, purpose: 'walkthrough' });
}
