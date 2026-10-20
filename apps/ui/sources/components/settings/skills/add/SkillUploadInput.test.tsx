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

describe('SkillUploadInput', () => {
  it('keeps an acknowledged upload open and retries its rules without another install', async () => {
    const onAdded = vi.fn();
    const writes: string[] = [];
    const answer: MountedAuthoringActionExecute = async (actionId, input) => {
      if (actionId === 'skills.install' && (input as { dryRun?: boolean }).dryRun)
        return { ok: true, result: { items: [PREVIEW] } };
      writes.push(actionId);
      return actionId === 'skills.install'
        ? { ok: false, error: 'rules unavailable', errorCode: 'skill_rules_write_failed', details: { skillIds: ['uploaded'], incomplete: [{ skillId: 'uploaded', step: 'rules' }] } }
        : { ok: true, result: { ok: true, revision: 2, items: [{ skillId: 'uploaded', previous: [], rules: [] }] } };
    };
    const { SkillUploadInput } = await import('./SkillUploadInput');
    const screen = await renderScreen(<SkillUploadInput execute={answer} onAdded={onAdded} onDone={() => {}} testID="upload" />);
    await act(async () => { await drop.onFilesDropped?.({ dataTransfer: {} }); });
    await screen.pressByTestIdAsync('upload.add');
    expect(onAdded).not.toHaveBeenCalled();
    expect(screen.findByTestId('upload.preview')).not.toBeNull();
    expect(screen.findByTestId('upload.add-error')).not.toBeNull();
    await screen.pressByTestIdAsync('upload.add');
    expect(onAdded).toHaveBeenCalledExactlyOnceWith('uploaded');
    expect(writes).toEqual(['skills.install', 'skills.rules.set']);
  });

  it('keeps the preview and its Add after a failed Add, with the failure beside it', async () => {
    const { SkillUploadInput } = await import('./SkillUploadInput');
    const screen = await renderScreen(<SkillUploadInput execute={execute} onAdded={() => {}} onDone={() => {}} testID="upload" />);
    await act(async () => {
      await drop.onFilesDropped?.({ dataTransfer: {} });
    });
    expect(screen.findByTestId('upload.add')).toBeTruthy();
    await screen.pressByTestIdAsync('upload.add');
    // The same selection is still there to retry, and nothing else says the Add failed.
    expect(screen.findByTestId('upload.add')).toBeTruthy();
    expect(screen.findByTestId('upload.preview')).toBeTruthy();
    expect(screen.findByTestId('upload.add-error')).toBeTruthy();
    expect(screen.findByTestId('upload.error')).toBeNull();
  });
});
