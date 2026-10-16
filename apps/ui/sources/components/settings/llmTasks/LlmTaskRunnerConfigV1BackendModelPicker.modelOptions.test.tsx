import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } from '@/sync/store/settings/acpCatalogSnapshot';
import { resetAcpCatalogEngineForTests } from '@/sync/engine/settings/acpCatalogEngine';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { LlmTaskRunnerConfigV1Schema } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real' });

beforeEach(() => {
  const scope = { serverId: getActiveServerSnapshot().serverId, accountId: 'task-picker-account' };
  getStorage().setState({ settingsScope: scope, settings: {
      ...settingsDefaults,
      backendEnabledByTargetKey: {
        'agent:happier.agent.claude/claude': false,
        'backend:claude': false,
      },
  } });
  applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record: AcpCatalogRecordV1Schema.parse({
    v: 1, definitions: [{ id: 'claude', name: 'configured-claude', title: 'Configured Claude', launch: { kind: 'command' as const, command: 'acp', args: [] }, createdAt: 1, updatedAt: 1 }],
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

describe('task runner model options', () => {
  it('selects a configured definition named like a bundled Agent without losing the instance', async () => {
    const onChange = vi.fn();
    const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker value={null} onChange={onChange} />);
    const [backendMenu] = screen.findAllByType(DropdownMenu);
    const key = 'agent:happier.agent.custom-acp/custom-acp:definition:claude';
    expect(backendMenu?.props.items).toContainEqual(expect.objectContaining({ id: key }));
    act(() => backendMenu?.props.onSelect(key));
    expect(onChange).toHaveBeenCalledWith({ v: 1, modelSelection: { agentTargetKey: key,
      providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' });
  });
  it('retains an unavailable Agent selection without offering another Agent model as its substitute', async () => {
    const screen = await renderScreen(
      <LlmTaskRunnerConfigV1BackendModelPicker
        value={LlmTaskRunnerConfigV1Schema.parse({
          v: 1, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
          modelId: 'default', permissionMode: 'no_tools',
        })}
        onChange={() => {}}
      />,
    );
    const [backendMenu, modelMenu] = screen.findAllByType(DropdownMenu);
    expect(backendMenu?.props.selectedId).toBe('');
    expect(modelMenu?.props.items.some((item: { id: string }) => item.id === 'default')).toBe(false);
  });
  it('tells a model menu with no backend to choose one first, and never shows an example id as the backend row', async () => {
    const screen = await renderScreen(<LlmTaskRunnerConfigV1BackendModelPicker value={null} onChange={() => {}} />);
    const [backendMenu, modelMenu] = screen.findAllByType(DropdownMenu);
    expect(modelMenu?.props.items).toEqual([]);
    expect(modelMenu?.props.emptyLabel).toBe('settingsSession.replayResume.summaryRunner.chooseBackendFirst');
    expect(backendMenu?.props.itemTrigger.subtitle).toBeUndefined();
  });
});
