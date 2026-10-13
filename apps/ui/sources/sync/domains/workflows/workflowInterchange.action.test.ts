import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorkflowEditorDraft } from './workflowEditorDraft';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
beforeAll(loadSyncSingletonForTests);
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { importWorkflowDocumentViaAction } = await import('./workflowInterchange');
let serverId: string;
let previous = storage.getState();
let applied = getAppliedActiveServerSnapshot();
let available = isAppliedActiveServerRuntimeAvailable();
beforeEach(async () => {
  previous = storage.getState(); applied = getAppliedActiveServerSnapshot(); available = isAppliedActiveServerRuntimeAvailable();
  await home.reset();
  serverId = await home.addHome({ name: 'Import Home', serverUrl: 'https://workflow-import.test', accountId: 'import-owner' });
  publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
  storage.setState({ profileScope: { serverId, accountId: 'import-owner' } });
});
afterEach(async () => { await home.reset(); storage.setState(previous); publishAppliedActiveServerSnapshot(applied, available); });

describe('Workflow document Action draft projection', () => {
  it('opens an imported document as a fresh unsaved draft and preserves current work on a typed failure', async () => {
    const currentDraft = createWorkflowEditorDraft({ draftId: 'current', name: 'Open work', blocks: [] });
    const definition = { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'wait',
      document: { text: 'Continue', references: [], attachments: [] } }] };
    const imported = await importWorkflowDocumentViaAction({ source: JSON.stringify({ kind: 'happier.workflow', version: 1, definition }),
      currentDraft, draftId: 'imported' });
    expect(imported).toMatchObject({ ok: true, definition, draft: { draftId: 'imported', name: '' } });
    expect(imported.draft).not.toBe(currentDraft);
    const rejected = await importWorkflowDocumentViaAction({ source: '{', currentDraft, draftId: 'rejected' });
    expect(rejected).toMatchObject({ ok: false, code: 'invalid_json' });
    expect(rejected.draft).toBe(currentDraft);
    expect(home.artifacts(serverId).list()).toEqual([]);
  });
});
