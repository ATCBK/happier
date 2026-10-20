import * as React from 'react';

import { formatMachineAgentAction } from '@/components/machines/agents/machineAgentCopy';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { t } from '@/text';

import type { AgentMachineAction } from './agentMachinesModel';

function actionLabel(action: AgentMachineAction): string {
  return action.kind === 'checkAgain'
    ? t('machineAgents.actionRetry')
    : formatMachineAgentAction(action);
}

/**
 * A machine row's operations, in the row's control column: bordered for the machine's own work (Install, Update,
 * Sign in, Try again), quiet for Remove. Each is named with its machine for assistive tech. Pure: the caller runs it.
 */
export function AgentMachineActionButtons(
  props: Readonly<{
    actions: readonly AgentMachineAction[];
    machineName: string;
    onAction: (action: AgentMachineAction) => void;
    testID: string;
  }>,
) {
  return (
    <>
      {props.actions.map((action) => (
        <RoundButton
          key={action.kind}
          testID={`${props.testID}:action:${action.kind}`}
          size="small"
          display={action.kind === 'remove' ? 'inverted' : 'secondary'}
          title={actionLabel(action)}
          accessibilityLabel={`${actionLabel(action)} · ${props.machineName}`}
          onPress={() => props.onAction(action)}
        />
      ))}
    </>
  );
}
