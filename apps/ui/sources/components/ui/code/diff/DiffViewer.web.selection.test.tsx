import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { InitialPresentationReadinessProvider } from '@/components/ui/presentation/InitialPresentationReadinessContext';
import { storage } from '@/sync/domains/state/storageStore';
import { BrowserWorker } from './pierre/pierreWorkerTestHelpers';

let fileDiffMounts = 0;


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
// Only the third-party renderer's DOM paint port is replaced. Happier parses
// the patch, chooses the renderer and mounts its real virtualized owner.
vi.mock('@pierre/diffs/react', async importOriginal => {
    const actual = await importOriginal<typeof import('@pierre/diffs/react')>();
    return { ...actual,
        FileDiff: (props: React.ComponentProps<typeof actual.FileDiff>) => {
            React.useEffect(() => { fileDiffMounts += 1; }, []);
            return React.createElement('pierre-file-diff', props);
        },
        Virtualizer: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
    };
});
const { PierreDiffViewer } = await import('./pierre/PierreDiffViewer.web');
const { HappierUnifiedDiffViewer } = await import('./happier/HappierUnifiedDiffViewer');
const { LazyMountOnScreen } = await import('@/components/ui/performance/LazyMountOnScreen');
const pierreViewerType = Reflect.get(PierreDiffViewer, 'type') ?? PierreDiffViewer;
const unifiedViewerType = Reflect.get(HappierUnifiedDiffViewer, 'type') ?? HappierUnifiedDiffViewer;
const initialState = storage.getState();

describe('DiffViewer (web renderer selection)', () => {
    const previousEnv = process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;

    beforeEach(async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        browser = await installBrowserRuntimeForTests({ url: 'http://localhost/' });
        BrowserWorker.reset();
        vi.stubGlobal('Worker', BrowserWorker);
        fileDiffMounts = 0;
        storage.setState({ settings: { ...storage.getState().settings, filesDiffRendererMode: 'pierre' } });
    });

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED;
        else process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = previousEnv;

        standardCleanup();
        storage.setState(initialState, true);
        browser?.restore();
    });

    it('uses Pierre when enabled by setting + env and runtime supports it', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeNull();
        expect(screen.findAllByType(LazyMountOnScreen)[0] ?? null).toBeNull();
    });

    it('wraps virtualized Pierre diffs in LazyMountOnScreen for lazy mounting', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" virtualized={true} />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(LazyMountOnScreen)[0] ?? null).toBeTruthy();
    });

    it('eagerly mounts only already-rendered virtualized Pierre rows while initial presentation is pending', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(
            <InitialPresentationReadinessProvider value={{
                presentationPending: true,
                registerProducer: () => ({ complete: () => {}, dispose: () => {} }),
            }}>
                <DiffViewer
                    mode="unified"
                    unifiedDiff={'diff --git a/a.ts b/a.ts'}
                    filePath="a.ts"
                    virtualized
                />
            </InitialPresentationReadinessProvider>,
        );

        expect(
            screen.findAllByType(LazyMountOnScreen)[0]?.props.initiallyVisible,
        ).toBe(true);
    });

    it('falls back to Happier renderer when the env kill-switch disables pierre', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_PIERRE_DIFFS__ENABLED = '0';
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(<DiffViewer mode="unified" unifiedDiff={'diff --git a/a.ts b/a.ts'} filePath="a.ts" />);

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeNull();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeTruthy();
    });

    it('keeps Pierre renderer for click-only interactivity', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');

        const screen = await renderScreen(
            <DiffViewer
                mode="unified"
                unifiedDiff={'diff --git a/a.ts b/a.ts'}
                filePath="a.ts"
                onPressLine={() => {}}
            />,
        );

        expect(screen.findAllByType(pierreViewerType)[0] ?? null).toBeTruthy();
        expect(screen.findAllByType(unifiedViewerType)[0] ?? null).toBeNull();
    });

    it('retains the Pierre host while Find and range selection open and close', async () => {
        const { DiffViewer } = await import('./DiffViewer.web');
        const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after\n';
        const onPressLineRange = () => {};
        const screen = await renderScreen(
            <DiffViewer
                mode="unified"
                unifiedDiff={patch}
                filePath="a.ts"
                interactionMode="read"
                onPressLineRange={onPressLineRange}
            />,
        );

        const host = screen.findAllByType('pierre-file-diff')[0];
        expect(host).toBeTruthy();
        for (const [findActive, interactionMode] of [[true, 'read'], [false, 'commitSelection'], [false, 'read']] as const) {
            await screen.update(<DiffViewer mode="unified" unifiedDiff={patch} filePath="a.ts"
                findActive={findActive} interactionMode={interactionMode} onPressLineRange={onPressLineRange} />);
            expect(screen.findAllByType('pierre-file-diff')[0]).toBe(host);
        }
        expect(fileDiffMounts).toBe(1);
    });
});
