import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

/**
 * Render scope while authoring.
 *
 * The draft owner already preserves untouched subtree identity, but that only
 * pays off if the change stops at the row that changed. This measures the one
 * expensive thing a Workflow step mounts — its composer — and fails if typing
 * into one step executes another step's composer. It is deliberately a count,
 * not a memoization assertion: an implementation that reaches the same scope
 * another way passes.
 */

const composerRenders = vi.hoisted(() => ({ byBlockId: new Map<string, number>(), ownerType: null as unknown }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const native = await createReactNativeWebMock();
    const ReactRuntime = await import('react');
    // Observe the real AgentInput at its platform hook, before any memoized
    // text leaf. The installed development renderer exposes the current
    // owner through the same dispatcher React uses for element ownership.
    const internals = Reflect.get(ReactRuntime, '__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE') as {
        A: null | { getOwner(): null | { type: unknown; pendingProps: { composerRef?: { blockId?: string } } } };
    };
    return {
        ...native,
        useWindowDimensions: () => {
            const owner = internals.A?.getOwner();
            if (owner != null && owner.type === composerRenders.ownerType && owner.pendingProps.composerRef?.blockId) {
                const blockId = owner.pendingProps.composerRef.blockId;
                composerRenders.byBlockId.set(blockId, (composerRenders.byBlockId.get(blockId) ?? 0) + 1);
            }
            return native.useWindowDimensions();
        },
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
// Radix is the DOM boundary; the app's popover and modal owners stay real.
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsModuleMock } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsModuleMock();
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { WorkflowBlockListEditor } = await import('./WorkflowBlockListEditor');
const { AgentInput } = await import('@/components/sessions/agentInput');
const { createWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowEditorDraft');
const { validateWorkflowEditorDraft } = await import('@/sync/domains/workflows/workflowAuthoring');
const { createWorkflowAuthoringComposerCustody } = await import('@/components/sessions/authoring/authoringComposerCustody');
composerRenders.ownerType = Reflect.get(AgentInput, 'type');
let serverId: string;
let restoreAppliedHome: (() => void) | undefined;

beforeAll(async () => {
    composerRenders.byBlockId.clear();
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const previous = applied.getAppliedActiveServerSnapshot();
    const wasAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    restoreAppliedHome = () => applied.publishAppliedActiveServerSnapshot(previous, wasAvailable);
    serverId = await home.addHome({ name: 'Render scope Home', serverUrl: 'https://blocklist-scope.test', accountId: 'account-a' });
    const { storage } = await import('@/sync/domains/state/storage');
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, settingsScope: { serverId, accountId: 'account-a' } });
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
});
afterAll(async () => {
    restoreAppliedHome?.();
    await home.reset();
});

afterEach(async () => {
    await standardCleanup();
});

const AGENT_TARGET = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };

describe('workflow authoring render scope', () => {
    it('does not execute a sibling step composer when one step prompt changes', async () => {
        const composerCustody = createWorkflowAuthoringComposerCustody('draft-1');

        const initialDraft = createWorkflowEditorDraft({
            draftId: 'draft-1',
            name: 'Review',
            defaults: { agentTarget: AGENT_TARGET },
            blocks: Array.from({ length: 8 }, (_unused, index) => ({
                kind: 'step' as const,
                id: `step-${index}`,
                document: { text: `Prompt ${index}`, references: [], attachments: [] },
                input: [],
                result: { kind: 'text' as const },
            })),
        });

        function Harness() {
            const [draft, setDraft] = React.useState(initialDraft);
            const validation = React.useMemo(() => validateWorkflowEditorDraft(draft), [draft]);
            return React.createElement(WorkflowBlockListEditor, {
                draft,
                list: { kind: 'root' },
                blocks: draft.blocks,
                depth: 0,
                selectedBlockId: null,
                composerScope: {
                    kind: 'machine',
                    machineId: 'machine-1',
                    serverId,
                    directory: '/repo/project',
                    machineHomeDir: '/Users/me',
                },
                composerCustody,
                validation,
                onChange: setDraft,
                onSelect: () => {},
                onCustomize: () => {},
                testIDPrefix: 'workflow-editor',
            });
        }

        const screen = await renderScreen(React.createElement(Harness));
        const changedId = 'step-3';
        const siblingId = 'step-6';
        const before = new Map(composerRenders.byBlockId);
        const blockIds = initialDraft.blocks.map(block => block.id);
        expect([...before.keys()].sort()).toEqual([...blockIds].sort());
        for (const blockId of blockIds) expect(before.get(blockId)).toBeGreaterThan(0);

        await act(async () => {
            const composer = screen.findAllByType(AgentInput).find(node => node.props.composerRef?.blockId === changedId);
            expect(composer).toBeDefined();
            composer!.props.onChangeText('Prompt 3 edited');
        });

        const editedComposer = screen.findAllByType(AgentInput).find(node => node.props.composerRef?.blockId === changedId);
        expect(editedComposer?.props.value).toBe('Prompt 3 edited');
        // The real composer also reconciles its own text/caret state. Its
        // target-local work may take several executions; sibling scope must
        // still remain exact across every one of them.
        expect(composerRenders.byBlockId.get(changedId)).toBeGreaterThan(before.get(changedId)!);
        // The whole draft object necessarily changes on every keystroke, so a
        // sibling composer re-executing here is the fan-out UI-07 names.
        expect(composerRenders.byBlockId.get(siblingId)).toBe(before.get(siblingId));
        for (const [blockId, count] of before) {
            if (blockId !== changedId) expect(composerRenders.byBlockId.get(blockId)).toBe(count);
        }
    });
});
