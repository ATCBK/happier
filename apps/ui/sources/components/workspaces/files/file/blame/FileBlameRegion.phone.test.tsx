import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { ScmBlameFileResponse } from '@happier-dev/protocol/scm';

import { renderHook, renderScreen } from '@/dev/testkit';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));
const { blame } = vi.hoisted(() => ({ blame: vi.fn() }));

installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      { useWindowDimensions: () => viewport },
    );
  },
});
// Device SDK and Machine RPC are the boundaries; the region, its card and the shared sheet stay real.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 34, left: 0 }),
  initialWindowMetrics: null,
}));
vi.mock('@/sync/ops/machineScmBlame', () => ({ machineScmBlameFile: blame }));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
vi.mock('@/sync/domains/state/storage', async () => {
  const { createStorageModuleStub } =
    await import('@/dev/testkit/mocks/storage');
  return createStorageModuleStub({});
});

const { useFileBlameRegion } = await import('./FileBlameRegion');

const uncommitted: ScmBlameFileResponse = {
  success: true,
  commits: [],
  ranges: [{ startLine: 1, lineCount: 2, commitIndex: null }],
};
const line = (newLine: number) =>
  ({
    id: `l${newLine}`,
    kind: 'file',
    oldLine: null,
    newLine,
    renderCodeText: '',
    renderPrefixText: '',
    renderIsHeaderLine: false,
  }) as unknown as CodeLine;

describe('blame card on a phone', () => {
  it('opens as a sheet that names the run once, in the card header, with the grabber as its only chrome', async () => {
    blame.mockResolvedValue(uncommitted);
    const hook = await renderHook(useFileBlameRegion, {
      initialProps: {
        scope: {
          machineId: 'machine',
          rootPath: '/repo',
          serverId: 'home',
          accountId: 'alice',
        },
        path: 'src/a.ts',
        content: { text: 'one\ntwo\n', hash: 'a'.repeat(64) },
        enabled: true,
        readBlame: true,
        sessionAddress: null,
        compact: true,
      },
    });
    const lane = await renderScreen(
      <>{hook.getCurrent().renderLeadingLane!(line(1))}</>,
    );
    await lane.pressByTestIdAsync('blame-run:1');
    await hook.rerender();
    const card = hook.getCurrent().card;
    expect(card).not.toBeNull();
    const sheet = await renderScreen(<>{card}</>);
    expect(sheet.findAll((node) => node.props.role === 'dialog').length).toBe(
      1,
    );
    expect(Boolean(sheet.findByTestId('blame-card'))).toBe(true);
    // The shared sheet band would repeat the card's own title and add a second close.
    expect(sheet.findByTestId('popover-sheet.close')).toBeNull();
    const text = sheet.getTextContent();
    expect(text.match(/files\.blame\.uncommitted(?![A-Za-z])/g)).toHaveLength(1);
    await act(async () => {
      sheet.unmount();
      lane.unmount();
    });
  });
});
