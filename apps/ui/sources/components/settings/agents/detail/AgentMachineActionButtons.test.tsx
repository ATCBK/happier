import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import {
  pressTestInstanceAsync,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';

import { AgentMachineActionButtons } from './AgentMachineActionButtons';
import {
  buildAgentMachineRows,
  type AgentMachineAction,
} from './agentMachinesModel';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

afterEach(() => {
  standardCleanup();
});

/** A machine that is online but whose last agent check failed, as the inventory owner projects it. */
function failedCheckRow() {
  const facts = MachineAgentInventoryItemSchema.parse({
    agentId: 'claude',
    title: 'Claude',
    installed: true,
    version: '2.1.296',
    latestVersion: null,
    update: { supported: false, command: null },
    signIn: {
      status: 'signedIn',
      required: true,
      loginSupport: 'login_terminal',
    },
    platform: { supported: true },
    install: {
      available: true,
      mode: 'managed',
      sizeBytes: null,
      guideUrl: null,
    },
    dependencies: [],
  });
  const agent = projectMachineAgent({
    agentId: 'claude',
    title: 'Claude',
    facts,
    checking: false,
    stale: false,
    unavailableReason: { reason: 'probe_failed' },
    connectedServices: [],
    job: null,
  });
  const [row] = buildAgentMachineRows({
    machines: [
      {
        machineId: 'nl2',
        serverId: 'srv',
        name: 'nl2',
        sentenceName: 'nl2',
        namePending: false,
        os: 'Linux',
        online: true,
        lastSeenAt: null,
      },
    ],
    agentsByMachineId: new Map([['nl2', agent]]),
    inventoryStatusByMachineId: new Map([['nl2', 'ready']]),
    pinnedVersion: null,
  });
  return row!;
}

describe('AgentMachineActionButtons', () => {
  it('asks the failed machine again when Try again is pressed', async () => {
    const row = failedCheckRow();
    const pressed: AgentMachineAction[] = [];
    const screen = await renderScreen(
      <AgentMachineActionButtons
        actions={row.actions}
        machineName={row.machine.name}
        onAction={(action) => pressed.push(action)}
        testID="m"
      />,
    );

    await pressTestInstanceAsync(
      screen.findByTestId('m:action:checkAgain'),
      'Try again',
    );

    expect(pressed).toEqual([{ kind: 'checkAgain' }]);
  });
});
