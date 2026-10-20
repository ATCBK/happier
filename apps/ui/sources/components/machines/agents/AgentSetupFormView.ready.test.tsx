import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { projectMachineAgent } from '@/agents/machineAgents/machineAgentModel';
import {
  pressTestInstanceAsync,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';

import {
  AgentSetupFormView,
  type AgentSetupFormHandlers,
} from './AgentSetupFormView';

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

const noop = () => {};
const HANDLERS: AgentSetupFormHandlers = {
  onInstall: noop,
  onRetry: noop,
  onCancelInstall: noop,
  onCheckAgain: noop,
  onOpenGuide: noop,
  onUseService: noop,
  onConnectService: noop,
  onOpenNativeSignIn: noop,
  onShowTerminal: noop,
  onCancelSignIn: noop,
};

/** A ready, Happier-managed agent that signs in in its own terminal, as the inventory owner projects it. */
function readyAgent() {
  const facts = MachineAgentInventoryItemSchema.parse({
    agentId: 'claude',
    title: 'Claude',
    installed: true,
    managed: true,
    version: '2.1.296',
    latestVersion: null,
    update: { supported: false, command: null },
    signIn: {
      status: 'signedIn',
      required: true,
      accountLabel: 'ai1@happier.dev',
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
  return projectMachineAgent({
    agentId: 'claude',
    title: 'Claude',
    facts,
    checking: false,
    stale: false,
    connectedServices: [],
    job: null,
  });
}

describe('AgentSetupFormView ready (full layout)', () => {
  it('opens into its setup rows, not a second status line, and Change brings back the sign-in choices', async () => {
    const screen = await renderScreen(
      <AgentSetupFormView
        testID="f"
        agent={readyAgent()}
        machineName="nl2"
        layout="full"
        handlers={HANDLERS}
      />,
    );

    expect(screen.findAllByTestId('f.signInRow').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('f.cliRow').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('2.1.296');
    expect(screen.findAllByTestId('f.way.native')).toHaveLength(0);

    await pressTestInstanceAsync(
      screen.findByTestId('f.changeSignIn'),
      'Change',
    );

    expect(screen.findAllByTestId('f.way.native').length).toBeGreaterThan(0);
    expect(screen.findAllByTestId('f.signInRow')).toHaveLength(0);
  });

  it('keeps the one ready line in the compact layout', async () => {
    const screen = await renderScreen(
      <AgentSetupFormView
        testID="f"
        agent={readyAgent()}
        machineName="nl2"
        layout="compact"
        handlers={HANDLERS}
      />,
    );

    expect(screen.findAllByTestId('f.signInRow')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('nl2');
  });
});

describe('AgentSetupFormView install failure (full layout)', () => {
  it('shows a rate-limited install as a limited download source with a local retry time and Try again, not the raw reset', async () => {
    const resetIso = '2026-10-19T14:20:00.000Z';
    const facts = MachineAgentInventoryItemSchema.parse({
      agentId: 'codex',
      title: 'Codex',
      installed: false,
      managed: true,
      version: null,
      latestVersion: null,
      update: { supported: false, command: null },
      signIn: { status: 'unknown', required: true, loginSupport: 'login_terminal' },
      platform: { supported: true },
      install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null },
      dependencies: [],
    });
    const agent = projectMachineAgent({
      agentId: 'codex',
      title: 'Codex',
      facts,
      checking: false,
      stale: false,
      connectedServices: [],
      job: {
        jobId: 'job-1',
        intent: 'install',
        startedAtMs: 0,
        logLine: null,
        steps: [],
        outcome: {
          kind: 'failed',
          code: 'rate_limited',
          stepId: 'download',
          message: `GitHub's API rate limit has been reached. Try again after ${resetIso}.`,
        },
      },
    });
    const screen = await renderScreen(
      <AgentSetupFormView testID="f" agent={agent} machineName="nl2" layout="full" handlers={HANDLERS} />,
    );

    const text = screen.getTextContent();
    expect(text).toContain('Downloads are temporarily limited');
    expect(text).toContain('The download source is limiting requests right now. Try again after ');
    expect(text).not.toContain(resetIso);
    expect(text).not.toContain('GitHub');
    expect(screen.findAllByTestId('f.retry').length).toBeGreaterThan(0);
  });
});
