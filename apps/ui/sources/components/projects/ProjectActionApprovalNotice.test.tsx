import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

const pushSpy = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => {
  const { createReactNativeNativeMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', async () => {
  const { createExpoVectorIconsMock } =
    await import('@/dev/testkit/mocks/icons');
  return createExpoVectorIconsMock();
});
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: { push: pushSpy } }).module;
});
describe('ProjectActionApprovalNotice', () => {
  beforeEach(() => {
    pushSpy.mockClear();
    storage.getState().activateProfileScope({ serverId: 'home a', accountId: 'acct' });
  });
  it('is the shared pending notice: it says the change waits and Review opens that exact approval on its Home', async () => {
    const { ProjectActionApprovalNotice } =
      await import('./ProjectActionApprovalNotice');
    const onDismiss = vi.fn();
    const screen = await renderScreen(
      <ProjectActionApprovalNotice
        testID="notice"
        request={{
          kind: 'approval_request_created',
          artifactId: 'art/1',
          actionId: 'projects.workspace.rename',
        }}
        onDismiss={onDismiss}
      />,
    );
    const text = screen.getTextContent();
    expect(text).toContain('projects.identity.waitingForApproval');
    // The shared notice's own action, not a Project-specific label.
    expect(text).toContain('approvals.review');
    expect(text).not.toContain('approvals.details');
    await React.act(async () => {
      screen.findByProps({ title: 'approvals.review' }).props.onPress();
    });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(pushSpy).toHaveBeenCalledWith(
      '/inbox/approvals/art%2F1?serverId=home%20a',
    );
  });
});
