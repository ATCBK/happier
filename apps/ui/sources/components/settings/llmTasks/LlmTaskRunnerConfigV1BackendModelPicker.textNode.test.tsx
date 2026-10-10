import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

beforeEach(() => {
    const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'task-picker-editor-account' };
    getStorage().setState({ settingsScope: scope, settings: settingsDefaults });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({
        v: 1, definitions: [{ id: 'custom-backend', name: 'custom-backend', title: 'Custom Backend',
            command: 'custom-backend', createdAt: 1, updatedAt: 1 }],
    }) }, true);
});
afterEach(async () => {
    await standardCleanup();
    resetAcpCatalogEngineForTests();
    resetAcpCatalogSnapshotsForTests();
    getStorage().setState(getStorage().getInitialState(), true);
});

const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { LlmTaskRunnerConfigV1BackendModelPicker } = await import('./LlmTaskRunnerConfigV1BackendModelPicker');

describe('LlmTaskRunnerConfigV1BackendModelPicker', () => {
    it('edits a custom model inline, cancels without saving, and saves an empty id as default', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker
            value={{ v: 1, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' }, modelId: 'old-model', permissionMode: 'no_tools' }}
            onChange={onChange} modelTestID="runner-model"
        />);
        const modelMenu = () => screen.findAllByType(DropdownMenu)[1]!;
        act(() => modelMenu().props.onSelect('__custom__'));
        expect(screen.findByTestId('runner-model.custom')).toBeTruthy();
        act(() => screen.changeTextByTestId('runner-model.custom', 'discard-me'));
        act(() => screen.pressByTestId('runner-model.custom.cancel'));
        expect(onChange).not.toHaveBeenCalled();
        act(() => modelMenu().props.onSelect('__custom__'));
        expect(screen.findByTestId('runner-model.custom')!.props.value).toBe('old-model');
        act(() => screen.changeTextByTestId('runner-model.custom', ' '));
        act(() => screen.pressByTestId('runner-model.custom.save'));
        expect(onChange).toHaveBeenCalledWith({ v: 1, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' }, modelId: 'default', permissionMode: 'no_tools' });
    });

    it('writes the legacy task-runner backend contract from a selected current catalog entry', async () => {
        const onChange = vi.fn();
        const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker value={null} onChange={onChange} />);
        const backendMenu = screen.findAllByType(DropdownMenu)[0]!;
        act(() => backendMenu.props.onSelect('agent:happier.agent.custom-acp/custom-acp:definition:custom-backend'));
        expect(onChange).toHaveBeenCalledWith({ v: 1, backendTarget: { kind: 'configuredAcpBackend', backendId: 'custom-backend' }, modelId: 'default', permissionMode: 'no_tools' });
    });

    it('does not emit raw period text nodes under non-Text parents on web', async () => {
        const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker
            value={{ v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, modelId: 'default', permissionMode: 'no_tools' }}
            onChange={() => {}}
        />);
        const badNodes: Array<{ parent: string | null; value: string }> = [];
        const walk = (node: unknown, parent: string | null): void => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parent !== 'Text' && node.trim().length > 0) badNodes.push({ parent, value: node });
                return;
            }
            if (Array.isArray(node)) {
                for (const child of node) walk(child, parent);
                return;
            }
            if (typeof node !== 'object') return;
            const row = node as Readonly<{ type?: unknown; children?: readonly unknown[] }>;
            for (const child of row.children ?? []) walk(child, typeof row.type === 'string' ? row.type : null);
        };
        walk(screen.tree.toJSON(), null);
        expect(badNodes).toEqual([]);
    });

    it('uses resolved backend catalog entries for built-in backend menu rows', async () => {
        const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker value={null} onChange={() => {}} />);
        const backendMenu = screen.findAllByType(DropdownMenu)[0]!;
        expect(backendMenu.props.items).toContainEqual(expect.objectContaining({ id: 'agent:happier.agent.claude/claude' }));
        expect(backendMenu.props.items).toContainEqual(expect.objectContaining({ id: 'agent:happier.agent.custom-acp/custom-acp:definition:custom-backend', title: 'Custom Backend' }));
    });
});
