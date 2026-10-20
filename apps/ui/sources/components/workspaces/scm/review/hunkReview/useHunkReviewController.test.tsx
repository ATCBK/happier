/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScmReviewedMarksRecordPort } from '@happier-dev/protocol/scm/reviewedMarks';
import type { ScmReviewedMarksRecord } from '@happier-dev/protocol/scm/reviewedMarks';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { storage } from '@/sync/domains/state/storage';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { useReviewKeyboard } from './useReviewKeyboard';
import { useHunkReviewController } from './useHunkReviewController';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

const initialSettings = storage.getState().settings;
afterEach(() => { standardCleanup(); storage.setState({ settings: initialSettings }); });
const patch = '@@ -1,3 +1,3 @@\n-old\n+new\n middle\n-before\n+after\n';

describe('hunk review through the shared keyboard and Account port', () => {
    it('R keeps the current change offline, advances the comparison counter and rejects a stale row', async () => {
        storage.setState({ settings: { ...initialSettings, keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true, keyboardShortcutOverridesV1: {}, keyboardShortcutDisabledCommandIdsV1: [] } });
        let unifiedDiff = patch;
        let root = '/repo';
        let value: unknown = null;
        let version = -1;
        const keys = buildReviewUnits('a.ts', undefined, patch).map(unit => unit.key);
        const port = createScmReviewedMarksRecordPort({ source: {
            repositoryRootPath: '/repo', source: { kind: 'workingTree' }, changeKeys: keys,
        }, transport: {
            read: async () => ({ value, version }),
            compareAndSet: async next => { value = next; version += 1; return { success: true, version }; },
        } });
        let controller!: ReturnType<typeof useHunkReviewController>;
        const outOfDate = vi.fn();
        function Review() {
            const [record, setRecord] = React.useState<ScmReviewedMarksRecord | null>(null);
            const setReviewedKeys = React.useCallback((selected: readonly string[], reviewed: boolean) => {
                void port.setReviewedKeys(selected, reviewed).then(result => { if (result.success) setRecord(result.record); });
            }, []);
            controller = useHunkReviewController({ source: { kind: 'live', root },
                path: 'a.ts', unifiedDiff, host: null, serverId: null, onOutOfDate: outOfDate,
                marks: { record, unavailableReason: null, setReviewed: () => {}, setReviewedKeys, clear: () => {} } });
            useReviewKeyboard(controller, { active: true });
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        expect(controller.strip).toMatchObject({ total: 2, reviewed: 0 });
        const staleKeep = controller.keepCurrent;
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true })); });
        expect(controller.strip).toMatchObject({ total: 2, reviewed: 1, fileComplete: false });
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
        unifiedDiff = patch.replace('+new', '+different');
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { staleKeep(); });
        expect(outOfDate).toHaveBeenCalledOnce();
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
        unifiedDiff = patch;
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        const beforeScopeChange = controller.keepCurrent;
        root = '/other-repository';
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Review /></KeyboardShortcutProvider>);
        await act(async () => { beforeScopeChange(); });
        expect(outOfDate).toHaveBeenCalledTimes(2);
        expect((await port.read()).record.reviewedChangeKeys).toEqual([keys[0]]);
    });
});
