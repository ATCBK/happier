import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks, resetSettingsViewCommonModuleMockState } from '../settingsViewTestHelpers';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';
import {
    createMachineAdministrationTargetSelectionFixture,
    createMachineAdministrationTargetSelectionMock,
    installMachineAdministrationTargetSelectionBoundary,
} from '@/dev/testkit/mocks/machineAdministrationTargetSelection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const capture = vi.hoisted(() => ({
    items: [] as Array<Record<string, unknown>>,
    searchHeaders: [] as Array<Record<string, unknown>>,
    itemListsWithSearchHeader: 0,
    itemGroupsWithSearchHeader: 0,
    renderOrder: [] as string[],
    segmentedTabBars: [] as Array<Record<string, unknown>>,
    dropdownMenus: [] as Array<Record<string, unknown>>,
    rawSettings: { v: 1, actions: {} } as unknown,
    rawPolicy: { v: 1, allowEnvironmentVariables: false, allowCrossMachine: false } as unknown,
    rawAllowLists: { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: null } as unknown,
    setPolicy: vi.fn(),
    setAllowLists: vi.fn(),
    stackOptions: null as Record<string, unknown> | null,
    switches: [] as Array<Record<string, unknown>>,
    windowWidth: 800,
    routeActionId: 'review.start',
    setRawSettings: vi.fn(),
    reset() {
        this.items = [];
        this.searchHeaders = [];
        this.itemListsWithSearchHeader = 0;
        this.itemGroupsWithSearchHeader = 0;
        this.renderOrder = [];
        this.segmentedTabBars = [];
        this.dropdownMenus = [];
        this.rawSettings = { v: 1, actions: {} };
        this.rawPolicy = { v: 1, allowEnvironmentVariables: false, allowCrossMachine: false };
        this.rawAllowLists = { v: 1, allowedRoleIds: null, allowedAgentTargetKeys: null };
        this.setPolicy.mockReset();
        this.setAllowLists.mockReset();
        this.stackOptions = null;
        this.switches = [];
        this.windowWidth = 800;
        this.routeActionId = 'review.start';
        this.setRawSettings.mockReset();
    },
}));

const administrationTargetSelection = createMachineAdministrationTargetSelectionMock({
    selectedMachineId: null,
});
const disabledAdministrationTargetSelection = createMachineAdministrationTargetSelectionFixture({
    selectedMachineId: null,
});
installMachineAdministrationTargetSelectionBoundary(administrationTargetSelection);
const administrationSelectionCalls: Array<Readonly<{
    selectionKey: string;
    options: unknown;
}>> = [];
vi.doMock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    ...administrationTargetSelection.module,
    useMachineAdministrationTargetSelection: (selectionKey: string, options: { enabled?: boolean } | undefined) => {
        administrationSelectionCalls.push({ selectionKey, options });
        if (options?.enabled === false) {
            return disabledAdministrationTargetSelection;
        }
        return administrationTargetSelection.module.useMachineAdministrationTargetSelection(selectionKey);
    },
}));

const daemonProjection = vi.hoisted(() => ({
    byMachineId: {} as Record<string, unknown>,
    reset() {
        this.byMachineId = {};
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: (params: Readonly<{ machineId?: unknown }>) => {
        const machineId = typeof params.machineId === 'string' ? params.machineId : '';
        return daemonProjection.byMachineId[machineId] ?? { phase: 'idle', inputs: null };
    },
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            useWindowDimensions: () => ({
                width: capture.windowWidth,
                height: 844,
                scale: 2,
                fontScale: 1,
            }),
        });
    },
    router: async () => {
        const { createExpoRouterMock, createStackOptionsCapture } = await import('@/dev/testkit/mocks/router');
        const stackOptionsCapture = createStackOptionsCapture();
        const routerMock = createExpoRouterMock({
            params: () => ({ actionId: capture.routeActionId }),
            stackOptionsCapture,
        });
        const StackScreen = routerMock.module.Stack.Screen;
        return {
            ...routerMock.module,
            Stack: Object.assign(routerMock.module.Stack, {
                Screen: (props: { options?: Record<string, unknown> }) => {
                    StackScreen(props);
                    capture.stackOptions = stackOptionsCapture.getResolved();
                    return React.createElement('StackScreen', props);
                },
            }),
        };
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: createUseSettingMutableMockFromReader((key) => key === 'sessionAgentSpawnPolicyV1'
                    ? [capture.rawPolicy, capture.setPolicy] as const
                    : key === 'sessionAgentStartAllowListsV1'
                        ? [capture.rawAllowLists, capture.setAllowLists] as const
                        : [capture.rawSettings, (next: unknown) => {
                    capture.rawSettings = next;
                    capture.setRawSettings(next);
                }] as const),
                useSetting: createUseSettingMock({ fallback: () => ({ privacy: { shareDeviceInventory: true } }) }),
            },
        });
    },
});

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: (props: Record<string, unknown>) => {
        capture.searchHeaders.push(props);
        capture.renderOrder.push('search');
        return React.createElement('SearchHeaderMock', props);
    },
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => {
        capture.switches.push(props);
        return React.createElement('Switch', props);
    },
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: Record<string, unknown>) => {
        capture.segmentedTabBars.push(props);
        return React.createElement('SegmentedTabBar', props);
    },
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => {
        capture.dropdownMenus.push(props);
        return React.createElement('DropdownMenu', props);
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => {
        capture.items.push(props);
        if (typeof props.testID === 'string') {
            capture.renderOrder.push(props.testID);
        }
        return React.createElement('ItemMock', {
            testID: props.testID,
        }, props.subtitleAccessory as React.ReactNode, props.rightElement as React.ReactNode);
    },
}));

function containsSearchHeaderMock(node: React.ReactNode): boolean {
    return React.Children.toArray(node).some((child) => {
        if (!React.isValidElement(child)) {
            return false;
        }
        if (child.type === 'SearchHeaderMock') {
            return true;
        }
        if (typeof child.type === 'function' && child.type.name === 'SearchHeader') {
            return true;
        }
        return containsSearchHeaderMock((child.props as { children?: React.ReactNode }).children);
    });
}

vi.mock('@/components/ui/lists/ItemGroup', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/lists/ItemGroup')>(),
    ItemGroup: ({ children }: { children?: React.ReactNode }) => {
        if (containsSearchHeaderMock(children)) {
            capture.itemGroupsWithSearchHeader += 1;
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: { children?: React.ReactNode }) => {
        if (containsSearchHeaderMock(children)) {
            capture.itemListsWithSearchHeader += 1;
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

afterEach(() => {
    standardCleanup();
    capture.reset();
    administrationTargetSelection.controller.reset();
    administrationSelectionCalls.length = 0;
    daemonProjection.reset();
    resetSettingsViewCommonModuleMockState();
});

// Resolve the shared catalog/module graph during collection, outside individual
// interaction-test deadlines; the page and domain logic remain real.
await import('./ActionSettingsDetailView');

describe('ActionSettingsDetailView', () => {
    it('keeps built-in action rows stable when the machine inventory refreshes', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);
        const renderedItems = capture.items.length;

        await React.act(async () => {
            administrationTargetSelection.controller.setMachines([
                { machineId: 'machine-a', displayName: 'Mac updated' },
            ]);
        });

        expect(administrationSelectionCalls).toContainEqual({
            selectionKey: 'actions.settings',
            options: { enabled: false },
        });
        expect(capture.items).toHaveLength(renderedItems);
    });

    it('lets the user waive host capture viewing only for the selected plugin', async () => {
        daemonProjection.byMachineId = {
            'machine-a': { phase: 'ready', inputs: { pluginProjectionById: {
                'acme.viewer': { pluginId: 'acme.viewer', title: 'My viewer', actions: [] },
                'acme.other': { pluginId: 'acme.other', title: 'Other viewer', actions: [] },
            } } },
        };
        administrationTargetSelection.controller.select('machine-a');
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        await renderScreen(<ActionSettingsDetailContent actionId="capture.view" />);
        const control = capture.segmentedTabBars.find(bar => (
            bar.testIDPrefix === 'settings-actions:host-capture:acme.viewer:mode'
        ));
        expect(control?.activeTabId).toBe('ask_first');
        expect(control?.accessibilityLabel).toBe('My viewer');
        (control?.onSelectTab as (value: string) => void)('allowed');
        expect(capture.setRawSettings).toHaveBeenLastCalledWith(expect.objectContaining({
            pluginHostCaptureApprovalWaived: ['acme.viewer'],
        }));
    });

    it('renders approval-capable targets as mode tabs and ordinary placements as switches', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        expect(administrationSelectionCalls).toContainEqual({
            selectionKey: 'actions.settings',
            options: undefined,
        });
        // The page opens on the action itself (entity header with its on/off switch); the surface
        // filter sits between the header and the surfaces, outside any section sheet.
        expect(capture.searchHeaders).toHaveLength(1);
        expect(capture.itemGroupsWithSearchHeader).toBe(0);
        expect(await screen.findByTestId('settings-actions:action:review.start:summary')).toBeTruthy();
        const summarySwitch = capture.switches.find((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:enabled',
        );
        expect(summarySwitch?.accessibilityLabel).toBe('Start review');
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start:target:cli')).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start:target:api')).toBe(true);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:review.start:target:plugin')).toBe(true);
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.activeTabId === 'default',
        )).toBe(true);
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:api:mode'
            && bar.activeTabId === 'default',
        )).toBe(true);
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:plugin:mode'
            && bar.activeTabId === 'default',
        )).toBe(true);
        const apiMode = capture.segmentedTabBars.find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:api:mode',
        );
        const apiRow = capture.items.find((item) =>
            item.testID === 'settings-actions:action:review.start:target:api',
        );
        expect(apiMode?.accessibilityLabel).toBe(apiRow?.title);
        const commandPaletteSwitch = capture.switches.find((switchProps) =>
            switchProps.testID === 'settings-actions:action:review.start:target:command_palette:enabled',
        );
        const commandPaletteRow = capture.items.find((item) =>
            item.testID === 'settings-actions:action:review.start:target:command_palette',
        );
        expect(commandPaletteSwitch?.accessibilityLabel).toBe(commandPaletteRow?.title);
    });

    it('renders dangerous Agent confirmation as the inherited default with explicit overrides', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="prompt_doc.update" />);

        const sessionAgentMode = capture.segmentedTabBars.find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:prompt_doc.update:target:agent:mode',
        );
        expect(sessionAgentMode).toBeTruthy();
        expect(sessionAgentMode?.activeTabId).toBe('default');
        expect((sessionAgentMode?.tabs as Array<{ id: string }>).map((tab) => tab.id)).toEqual([
            'off',
            'default',
            'ask_first',
            'allowed',
        ]);
    });

    it('shows resource safety and automation facts without creating an automation approval control', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        await renderScreen(<ActionSettingsDetailContent actionId="machines.storage.trash.move" />);

        const factIds = capture.items
            .map((item) => item.testID)
            .filter((id) => typeof id === 'string' && id.includes(':fact:'));
        expect(factIds).toEqual([
            'settings-actions:action:machines.storage.trash.move:fact:automations',
            'settings-actions:action:machines.storage.trash.move:fact:forbidden',
            'settings-actions:action:machines.storage.trash.move:fact:trash-first',
        ]);
        expect(capture.segmentedTabBars.some((bar) => String(bar.testIDPrefix).includes('automations'))).toBe(false);
        expect(capture.items.find((item) => item.testID === factIds[0])?.rightElement).toBeUndefined();
        expect(capture.segmentedTabBars.find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:machines.storage.trash.move:target:agent:mode',
        )?.tabs).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'allowed' })]));
    });

    it('persists ask-first approval mode through the canonical settings writer', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliMode = capture.segmentedTabBars.find((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode',
        );
        expect(cliMode).toBeTruthy();

        (cliMode?.onSelectTab as (tabId: string) => void)('ask_first');

        expect(capture.setRawSettings).toHaveBeenCalledWith({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: ['cli'],
                    toolExposureModes: {},
                },
            },
        });
    });

    it('renders tool exposure controls for eligible tool-backed integration surfaces', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        const mcpExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:mcp:tool-exposure';
        });
        const cliExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:cli:tool-exposure';
        });

        expect(sessionAgentExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(mcpExposure).toMatchObject({
            selectedId: 'default',
        });
        expect(cliExposure).toMatchObject({
            selectedId: 'default',
        });
        expect((sessionAgentExposure?.items as Array<{ testID?: string }>).map((item) => item.testID)).toEqual([
            'settings-actions:action:review.start:target:agent:tool-exposure:default',
            'settings-actions:action:review.start:target:agent:tool-exposure:discoverable_only',
            'settings-actions:action:review.start:target:agent:tool-exposure:direct',
        ]);
        expect(capture.dropdownMenus.some((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent_input_chips:tool-exposure';
        })).toBe(false);
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:agent:tool-exposure:resolved:discoverable_only',
        )).toBeTruthy();
        expect(await screen.findByTestId(
            'settings-actions:action:review.start:target:mcp:tool-exposure:resolved:direct',
        )).toBeTruthy();
    });

    it('persists direct tool exposure overrides and clears them when default is selected', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const sessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        expect(sessionAgentExposure).toBeTruthy();

        (sessionAgentExposure?.onSelect as (itemId: string) => void)('direct');

        expect(capture.setRawSettings).toHaveBeenLastCalledWith({
            v: 1,
            actions: {
                'review.start': {
                    enabledPlacements: [],
                    disabledSurfaces: [],
                    disabledPlacements: [],
                    approvalRequiredSurfaces: [],
                    toolExposureModes: {
                        agent: 'direct',
                    },
                },
            },
        });

        capture.dropdownMenus = [];
        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);
        const resetSessionAgentExposure = capture.dropdownMenus.find((menu) => {
            const itemTrigger = menu.itemTrigger as { itemProps?: { testID?: string } } | undefined;
            return itemTrigger?.itemProps?.testID === 'settings-actions:action:review.start:target:agent:tool-exposure';
        });
        expect(resetSessionAgentExposure).toBeTruthy();

        (resetSessionAgentExposure?.onSelect as (itemId: string) => void)('default');

        expect(capture.setRawSettings).toHaveBeenLastCalledWith({
            v: 1,
            actions: {},
        });
    });

    it('renders and persists session-agent spawn policy toggles for Create session', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);

        const directoryToggle = capture.switches.find((switchProps) =>
            switchProps.testID === 'settings-actions:session-spawn-policy:allowCustomDirectory',
        );
        expect(directoryToggle).toBeTruthy();
        expect(directoryToggle?.value).toBe(true);

        const onDirectoryToggleChange = directoryToggle?.onValueChange;
        expect(typeof onDirectoryToggleChange).toBe('function');
        (onDirectoryToggleChange as (next: boolean) => void)(false);

        expect(capture.setPolicy).toHaveBeenCalledWith(expect.objectContaining({
            v: 1,
            allowCustomDirectory: false,
            allowCrossMachine: false,
            allowEnvironmentVariables: false,
        }));
        const written = capture.setPolicy.mock.calls.at(-1)?.[0];
        expect(written).not.toHaveProperty('allowedRoleIds');
        expect(written).not.toHaveProperty('allowedAgentTargetKeys');
        expect(capture.setAllowLists).not.toHaveBeenCalled();
    });

    it('restores the environment-variables policy toggle and writes it with the rest of the policy', async () => {
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);

        const environmentToggle = capture.switches.find((switchProps) =>
            switchProps.testID === 'settings-actions:session-spawn-policy:allowEnvironmentVariables',
        );
        expect(environmentToggle?.value).toBe(false);
        (environmentToggle?.onValueChange as (next: boolean) => void)(true);

        expect(capture.setPolicy).toHaveBeenLastCalledWith(expect.objectContaining({
            v: 1,
            allowEnvironmentVariables: true,
            allowCrossMachine: false,
        }));
    });

    it('writes engine allow-lists only to their separate Account setting', async () => {
        capture.rawAllowLists = { v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: null };
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');
        const screen = await renderScreen(<ActionSettingsDetailContent actionId="session.spawn_new" />);
        await screen.pressByTestIdAsync('settings-actions:session-start-allow-lists:agents');
        const menu = capture.dropdownMenus.find((entry) => entry.testID === 'settings-actions:session-start-allow-lists:agents:menu');
        expect(menu).toBeTruthy();
        const select = menu?.onSelect;
        if (typeof select !== 'function') throw new Error('allow-list selection unavailable');
        select('none');
        expect(capture.setAllowLists).toHaveBeenCalledWith({ v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: [] });
        expect(capture.setPolicy).not.toHaveBeenCalled();
    });

    it('moves approval mode controls into the target text column on narrow mobile widths', async () => {
        capture.windowWidth = 390;
        const { ActionSettingsDetailContent } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailContent actionId="review.start" />);

        const cliTarget = capture.items.find((item) =>
            item.testID === 'settings-actions:action:review.start:target:cli',
        );
        expect(cliTarget).toBeTruthy();
        expect(cliTarget?.rightElement).toBeFalsy();
        expect(cliTarget?.subtitleAccessory).toBeTruthy();
        expect(capture.segmentedTabBars.some((bar) =>
            bar.testIDPrefix === 'settings-actions:action:review.start:target:cli:mode'
            && bar.activeTabId === 'default',
        )).toBe(true);
    });

    it('uses the action name as the route header title', async () => {
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).toBe('Start review');
    });

    it('resolves an encoded qualified contributed id with API and trusted-plugin controls', async () => {
        capture.routeActionId = 'happier.inspector%2Factions%2Fself-check';
        daemonProjection.byMachineId = {
            'machine-a': {
                phase: 'ready',
                inputs: {
                    pluginProjectionById: {
                        'happier.inspector': {
                            pluginId: 'happier.inspector',
                            actions: [{
                                id: 'self-check',
                                title: 'Run Inspector self-check',
                                description: 'Checks the Inspector plugin.',
                                icon: null,
                                surfaces: ['ui'],
                                placementBindings: ['toolbar'],
                            }],
                        },
                    },
                },
            },
        };
        administrationTargetSelection.controller.select('machine-a');
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        const screen = await renderScreen(<ActionSettingsDetailView />);

        expect(await screen.findByTestId(
            'settings-actions:action:happier.inspector/actions/self-check:summary',
        )).toBeTruthy();
        expect(capture.items.some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:api'
        ))).toBe(true);
        expect(capture.items.some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:plugin'
        ))).toBe(true);
        expect(capture.items.some((item) => (
            item.testID === 'settings-actions:action:happier.inspector/actions/self-check:target:contextual_ui'
        ))).toBe(true);
        for (const targetId of ['api', 'plugin'] as const) {
            const target = capture.items.find((item) => (
                item.testID === `settings-actions:action:happier.inspector/actions/self-check:target:${targetId}`
            ));
            const modeControl = capture.segmentedTabBars.find((bar) => (
                bar.testIDPrefix === `settings-actions:action:happier.inspector/actions/self-check:target:${targetId}:mode`
            ));
            expect(modeControl?.accessibilityLabel).toBe(target?.title);
            expect(modeControl?.targetSize).toBe('platform');
            expect(modeControl?.activeTabId).toBe('default');
            expect((modeControl?.tabs as Array<{ id: string }>).map((tab) => tab.id)).toEqual([
                'off',
                'default',
                'ask_first',
                'allowed',
            ]);
        }
    });

    it('treats direct links to non-configurable runtime actions as invalid', async () => {
        // `devices.simulator.input.orientation` is statically-unbacked (no producer in stock scrcpy),
        // so it stays UNSURFACED / non-configurable — a direct link must be rejected. (The browser
        // diagnostics interaction verbs, incl. `eval`, are now executor-backed and configurable, so
        // they are no longer the canonical non-configurable example.)
        const { getActionSpec } = await import('@happier-dev/protocol');
        capture.routeActionId = 'devices.simulator.input.orientation';
        const { ActionSettingsDetailView } = await import('./ActionSettingsDetailView');

        await renderScreen(<ActionSettingsDetailView />);

        expect(capture.stackOptions?.headerTitle).not.toBe(getActionSpec('devices.simulator.input.orientation').title);
        expect(capture.items.some((item) => item.testID === 'settings-actions:action:devices.simulator.input.orientation:summary')).toBe(false);
    });
});
