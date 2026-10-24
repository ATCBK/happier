import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderInCollectionLayout, type CollectionLayoutHarnessMode } from '@/dev/testkit';
import {
    installPromptTemplatesCommonModuleMocks,
    promptTemplatesRouterPushSpy,
} from '../templates/promptTemplatesScreenTestHelpers';


Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const routerReplaceSpy = vi.hoisted(() => vi.fn());
const pathnameState = vi.hoisted(() => ({ value: '/settings/prompts/templates' }));

installPromptTemplatesCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            ScrollView: 'ScrollView',
            View: 'View',
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: { web?: unknown; default?: unknown }) =>
                    web ?? defaultValue,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: 'white' },
                    accent: { blue: '#00f' },
                    textSecondary: '#999',
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: promptTemplatesRouterPushSpy, replace: routerReplaceSpy },
            pathname: () => pathnameState.value,
        });
        return routerMock.module;
    },
    modal: async () => vi.importActual('@/modal'),
    text: async () => vi.importActual('@/text'),
    storage: importOriginal => importOriginal(),
});

const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const scope = { serverId: 'prompt-collection-home', accountId: 'prompt-collection-account' };

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));


async function renderIndex(mode: CollectionLayoutHarnessMode) {
    const { PromptCollectionIndex } = await import('./PromptCollectionList');
    return renderInCollectionLayout(<PromptCollectionIndex kind="template" />, mode);
}

describe('PromptCollectionIndex', () => {
    beforeEach(() => {
        resetPromptLibraryCatalogEngineForTests();
        resetPromptLibraryCatalogSnapshotsForTests();
        storage.setState({ settings: settingsDefaults, settingsVersion: 7, settingsScope: scope, profileScope: scope, isDataReady: true, artifactsLoaded: true, artifacts: {} });
        publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://prompt-collection.invalid', generation: 1 });
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 4,
            record: { key: 'invocations', value: { v: 1, entries: [{ id: 'template-1', token: '/daily', title: 'Daily',
                target: { kind: 'doc', artifactId: 'doc-1' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] } } }],
            tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        promptTemplatesRouterPushSpy.mockClear();
        routerReplaceSpy.mockClear();
        pathnameState.value = '/settings/prompts/templates';
    });

    it('beside the rail, lands on an item instead of leaving the detail empty', async () => {
        const screen = await renderIndex('split');

        const redirect = screen.findAllByType('Redirect' as never)[0] as unknown as { props: { href: string } } | undefined;
        expect(redirect?.props.href).toBe('/settings/prompts/templates/template-1');
    });

    it('where no rail shows, lists the templates with their command and adds a draft from the header', async () => {
        const screen = await renderIndex('stacked');

        const row = screen.tree.root.findAll((node) => node.props?.testID === 'promptLibrary.collection.template.row.template-1')[0];
        expect(row?.props.title).toBe('Daily');
        expect(row?.props.subtitle).toBe('/daily');

        await act(async () => {
            screen.findByTestId('promptLibrary.collection.template.add')?.props.onPress();
        });
        expect(promptTemplatesRouterPushSpy).toHaveBeenCalledWith('/settings/prompts/templates/new');
    });

    it.each(['stacked', 'split'] as const)('does not report an empty %s collection before the authoritative catalog arrives', async (mode) => {
        resetPromptLibraryCatalogSnapshotsForTests();
        const screen = await renderIndex(mode);
        expect(screen.findByTestId('promptLibrary.collection.template.empty') !== null).toBe(false);
        expect(screen.findByTestId('promptLibrary.collection.template.readState-loading-spinner')).not.toBeNull();
        expect(screen.findAllByType('Redirect' as never)).toHaveLength(0);

        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 5,
                record: { key: 'invocations', value: { v: 1, entries: [{ id: 'template-1', token: '/daily', title: 'Daily',
                    target: { kind: 'doc', artifactId: 'doc-1' }, behavior: 'insert', allowArgs: false, availableIn: 'global' }] } } }],
                tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        if (mode === 'stacked') {
            expect(screen.findByTestId('promptLibrary.collection.template.row.template-1')).not.toBeNull();
        } else {
            const redirect = screen.findAllByType('Redirect' as never)[0] as unknown as { props: { href: string } } | undefined;
            expect(redirect?.props.href).toBe('/settings/prompts/templates/template-1');
        }

        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 6,
                record: { key: 'invocations', value: { v: 1, entries: [] } } }], tombstones: [], diagnostics: [] },
                rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptLibrary.collection.template.empty')).not.toBeNull();
        expect(screen.findByTestId('promptLibrary.collection.template.empty-scene')).not.toBeNull();
    });

    it('does not report an empty authored collection before its artifact read completes', async () => {
        storage.setState({ artifactsLoaded: false });
        const { PromptCollectionIndex } = await import('./PromptCollectionList');
        const screen = await renderInCollectionLayout(<PromptCollectionIndex kind="doc" />, 'stacked');
        expect(screen.findByTestId('promptLibrary.collection.doc.empty') !== null).toBe(false);
        expect(screen.findByTestId('promptLibrary.collection.doc.readState-loading-spinner')).not.toBeNull();
        await act(async () => { storage.setState({ artifactsLoaded: true }); });
        expect(screen.findByTestId('promptLibrary.collection.doc.empty')).not.toBeNull();
        expect(screen.findByTestId('promptLibrary.collection.doc.empty-scene')).not.toBeNull();
    });

    it('says an empty rail is empty once the collection is known, as the MCP and Skills rails do', async () => {
        const { PromptCollectionRail } = await import('./PromptCollectionList');
        const screen = await renderInCollectionLayout(<PromptCollectionRail kind="template" />, 'split');
        expect(screen.findByTestId('promptLibrary.collection.template.railEmpty')).toBeNull();

        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 6,
                record: { key: 'invocations', value: { v: 1, entries: [] } } }], tombstones: [], diagnostics: [] },
                rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptLibrary.collection.template.railEmpty')).not.toBeNull();
    });

    it('retains known templates during revalidation but withdraws them when access is refused', async () => {
        const screen = await renderIndex('stacked');
        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'loading' }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptLibrary.collection.template.row.template-1')).not.toBeNull();
        expect(screen.findByTestId('promptLibrary.collection.template.freshness')).not.toBeNull();
        await act(async () => {
            applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'forbidden' }, rawSettings: {}, sourceSettingsVersion: 7 }, true);
        });
        expect(screen.findByTestId('promptLibrary.collection.template.row.template-1') !== null).toBe(false);
        expect(screen.findByTestId('promptLibrary.collection.template.empty') !== null).toBe(false);
        expect(screen.findByTestId('promptLibrary.collection.template.readState')).not.toBeNull();
        expect(screen.findByTestId('promptLibrary.collection.template.readState-loading-spinner') !== null).toBe(false);
        expect(screen.findByTestId('promptLibrary.collection.template.readState-action')).not.toBeNull();
    });
});
