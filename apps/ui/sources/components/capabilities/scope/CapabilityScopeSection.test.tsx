import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { t } from '@/text';

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

// Load the real UI graph during collection, not inside the behavior timeout budget.
const { ScopeSheet } = await import('./CapabilityScopeSection');

afterEach(() => standardCleanup());

function renderUnavailableSheet(offlineMachine: string | null, retry = vi.fn(), state: 'unavailable' | 'loading' = 'unavailable') {
  return renderScreen(
    <ScopeSheet
      testID="scope.skills"
      kind="skill"
      title="Skills"
      list={{ state, total: 0, rows: [], retry }}
      place={{ place: { t: 'project', projectKey: 'invoice-client' }, label: 'invoice-client' }}
      data={{ machines: [], names: {} as never, open: () => {} }}
      offlineMachine={offlineMachine}
    />,
  );
}

describe('capability scope sheet when its list could not be read', () => {
  it('names the offline machine, not the project, as what the list waits for, with no error and no Retry', async () => {
    const screen = await renderUnavailableSheet('studio');
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.whenRunning', { machine: 'studio' }),
    );
    expect(screen.getTextContent()).not.toContain('invoice-client');
    expect(screen.findByTestId('scope.skills.unavailable')).toBeNull();
    expect(screen.getTextContent()).not.toContain(
      t('capabilities.scopeSection.loadFailed'),
    );
    await screen.unmount();
  });

  it('keeps a failed read of a running machine an error with its Retry', async () => {
    const retry = vi.fn();
    const screen = await renderUnavailableSheet(null, retry);
    expect(screen.findByTestId('scope.skills.offline')).toBeNull();
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.loadFailed'),
    );
    expect(screen.getTextContent()).toContain(t('common.retry'));
    await screen.unmount();
  });

  it('never holds a skeleton for a list its unreachable machine has not answered', async () => {
    const screen = await renderUnavailableSheet('studio', vi.fn(), 'loading');
    expect(screen.getTextContent()).toContain(
      t('capabilities.scopeSection.whenRunning', { machine: 'studio' }),
    );
    await screen.unmount();
  });
});
