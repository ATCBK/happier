import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// The browser's file drop is the platform boundary: the test drops one skill folder through it. Reading the
// folder, previewing and adding stay the real owners.
const drop = vi.hoisted(() => ({ onFilesDropped: null as null | ((event: { dataTransfer: unknown }) => Promise<void>) }));
vi.mock('@/hooks/ui/useWebFileDropZone', () => ({
  useWebFileDropZone: (params: { onFilesDropped: (event: { dataTransfer: unknown }) => Promise<void> }) => {
    drop.onFilesDropped = params.onFilesDropped;
    return {};
  },
}));
vi.mock('@/utils/files/webDroppedEntries', () => ({
  readWebDroppedEntries: async () => [
    { file: new File(['---\nname: grill-me\ndescription: Interview the plan.\n---\nAsk.'], 'SKILL.md'), relativePath: 'grill-me/SKILL.md' },
  ],
}));

afterEach(() => {
  standardCleanup();
  drop.onFilesDropped = null;
});

const PREVIEW = {
  path: 'grill-me',
  name: 'grill-me',
  description: 'Interview the plan.',
  files: [],
  trust: 'text_only',
  cost: { descriptionTokens: 20, bodyTokens: 300 },
  provenance: { kind: 'upload', importedAt: 1 },
} as const;

/** The Action transport is the boundary: the preview finds one skill, the add itself is refused. */
const execute: MountedAuthoringActionExecute = async (_actionId, input) => {
  const dryRun = (input as { dryRun?: boolean }).dryRun === true;
  const answer: ActionExecuteResult = dryRun
    ? { ok: true, result: { items: [PREVIEW] } }
    : { ok: false, error: 'install failed', errorCode: 'skill_install_failed' };
  return answer;
};

/** The Upload mode inside the real Add dialog body, as the Skills page opens it. */
async function renderUpload(answer: MountedAuthoringActionExecute, onSelectAdded: (id: string) => void = () => {}) {
  const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
  const { SkillUploadInput } = await import('./SkillUploadInput');
  const onClose = vi.fn();
  const config = {
    title: 'Add a skill',
    testID: 'skills.add',
    initialModeKey: 'upload',
    modes: [
      {
        key: 'upload',
        label: 'Upload',
        icon: 'upload' as const,
        kind: 'input' as const,
        ownsTools: true,
        renderBody: (ctx: never) => (
          <SkillUploadInput ctx={ctx} execute={answer} onAdded={() => {}} onSelectAdded={onSelectAdded} onDone={() => {}} testID="upload" />
        ),
      },
    ],
    catalog: { query: '', onQueryChange: () => {}, searchPlaceholder: '', items: [], itemKey: () => '', anatomy: {}, loading: false, empty: null },
    renderDetail: () => null,
    detailFooter: () => ({ primary: { label: '', onPress: async () => null } }),
  };
  const screen = await renderScreen(<CapabilityAddModalBody config={config as never} onClose={onClose} />);
  await act(async () => {
    await drop.onFilesDropped?.({ dataTransfer: {} });
  });
  const pressPrimary = async () => {
    const button = screen.findAll((node) => node.props?.testID === 'skills.add:primary' && typeof node.props?.onPress === 'function')[0];
    if (!button) throw new Error('primary is not pressable');
    await act(async () => {
      await button.props.onPress();
    });
  };
  return { screen, pressPrimary, onClose };
}

describe('SkillUploadInput', () => {
  it('opens one uploaded skill straight in its details and adds it with the Where picked there (G8)', async () => {
    const installs: Record<string, unknown>[] = [];
    const answer: MountedAuthoringActionExecute = async (_actionId, input) => {
      if ((input as { dryRun?: boolean }).dryRun) return { ok: true, result: { items: [PREVIEW] } };
      installs.push(input as Record<string, unknown>);
      return { ok: true, result: { skillIds: ['uploaded'], includedInSessionId: null } };
    };
    const selected: string[] = [];
    const { screen, pressPrimary, onClose } = await renderUpload(answer, (id) => selected.push(id));
    expect(screen.findByTestId('upload.detail.title')).not.toBeNull();
    const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
    const narrowed = { kind: 'write', write: { place: { t: 'machine', machineId: 'machine-1' }, state: 'on' } } as const;
    await act(async () => {
      await screen.findByType(WhereItsOnControl).props.onChange(narrowed);
    });
    await pressPrimary();
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({ source: { kind: 'upload' }, where: narrowed });
    expect(installs[0]).not.toHaveProperty('selectPaths');
    expect(onClose).toHaveBeenCalled();
    expect(selected).toEqual(['uploaded']);
  });

  it('keeps an acknowledged upload open and retries its rules without another install', async () => {
    const writes: string[] = [];
    const answer: MountedAuthoringActionExecute = async (actionId, input) => {
      if (actionId === 'skills.install' && (input as { dryRun?: boolean }).dryRun)
        return { ok: true, result: { items: [PREVIEW] } };
      writes.push(actionId);
      return actionId === 'skills.install'
        ? { ok: false, error: 'rules unavailable', errorCode: 'skill_rules_write_failed', details: { skillIds: ['uploaded'], incomplete: [{ skillId: 'uploaded', step: 'rules' }] } }
        : { ok: true, result: { ok: true, revision: 2, items: [{ skillId: 'uploaded', previous: [], rules: [] }] } };
    };
    const selected: string[] = [];
    const { screen, pressPrimary, onClose } = await renderUpload(answer, (id) => selected.push(id));
    await pressPrimary();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.detail.title')).not.toBeNull();
    expect(screen.findByTestId('skills.add:primary-error')).not.toBeNull();
    await pressPrimary();
    expect(selected).toEqual(['uploaded']);
    expect(writes).toEqual(['skills.install', 'skills.rules.set']);
  });

  it('keeps the details and their Add after a failed Add, with the failure beside it', async () => {
    const { screen, pressPrimary, onClose } = await renderUpload(execute);
    await pressPrimary();
    // The same skill is still there to retry, and nothing else says the Add failed.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.detail.title')).toBeTruthy();
    expect(screen.findByTestId('skills.add:primary-error')).toBeTruthy();
    expect(screen.findByTestId('upload.error')).toBeNull();
  });
});
