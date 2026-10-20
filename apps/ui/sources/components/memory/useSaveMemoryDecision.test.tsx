import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryDocBodyV1Schema } from '@happier-dev/protocol/prompts/library/memoryDocV1';
import { createMemoryDecisionHomeFixture } from '@/dev/testkit/harness/memoryDecisionHomeFixture';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { act, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

installDisconnectedServerSocketBoundary();
const { useSaveMemoryDecision } = await import('./useSaveMemoryDecision');
afterEach(standardCleanup);


describe('decision sheet data through the real Action and Home boundary', () => {
  it('keeps the target census partial when an attached document cannot be admitted', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.resolveUnknownSourceAsReadOnly();
    f.readSource().attachments?.push({ purpose: 'context', entry: { id: 'project.memory', enabled: true, placement: 'system_append',
      ref: { kind: 'doc', artifactId: 'unavailable-memory', serverId: f.serverId } } });
    const hook = await renderHook(() => useSaveMemoryDecision({ seed: { text: 'Private decision.', reason: 'Explicit save.', sourceMessageRef: {
      kind: 'discussion', discussion: { serverId: f.serverId, discussionId: 'source' }, messageId: 'committed-source' } }, onSaved: vi.fn() }));
    try {
      await act(async () => { await hook.getCurrent().refreshTargets(); });
      expect(hook.getCurrent().targets.map(row => row.target)).toEqual([{ scope: 'account' }]);
      expect(hook.getCurrent().targetCoverage).toBe('partial');
    } finally { await hook.unmount(); await f.home.dispose(); }
  });

  it('retains the admitted Only me choice when the Project catalog is unavailable', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.makeProjectCatalogUnavailable();
    const hook = await renderHook(() => useSaveMemoryDecision({ seed: { text: 'Private decision.', reason: 'Explicit save.', sourceMessageRef: {
      kind: 'discussion', discussion: { serverId: f.serverId, discussionId: 'source' }, messageId: 'committed-source' } }, onSaved: vi.fn() }));
    try {
      await act(async () => { await hook.getCurrent().refreshTargets(); });
      expect(hook.getCurrent().targets.map(row => row.target)).toEqual([{ scope: 'account' }]);
      expect(hook.getCurrent()).toMatchObject({ targetStatus: 'ready', targetCoverage: 'partial' });
    } finally { await hook.unmount(); await f.home.dispose(); }
  });

  it('withdraws the eligible catalog when its Account credentials retire', async () => {
    const f = await createMemoryDecisionHomeFixture();
    const hook = await renderHook(() => useSaveMemoryDecision({ seed: { text: 'Private draft.', reason: 'Private reason.',
      sourceMessageRef: { kind: 'discussion', discussion: { serverId: f.serverId, discussionId: 'source' }, messageId: 'committed-source' } }, onSaved: vi.fn() }));
    try {
      await act(async () => { await hook.getCurrent().refreshTargets(); });
      expect(hook.getCurrent().targets).toHaveLength(2);
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      await act(async () => { await TokenStorage.removeCredentialsForServerUrl('https://decision-targets.test', { serverId: f.serverId }); });
      await flushHookEffects();
      await act(async () => { hook.getCurrent().clearTarget(); });
      expect(hook.getCurrent().targets).toEqual([]);
      expect(hook.getCurrent().canSave).toBe(false);
      expect(hook.getCurrent().notice).toBe('refused');
    } finally { await hook.unmount(); await f.home.dispose(); }
  });

  it.each(['discussion', 'session'] as const)('offers writable targets and retains a saved %s decision after attachment failure without resaving', async kind => {
    const f = await createMemoryDecisionHomeFixture();
    const sourceMessageRef: CoordinationMessageRefV1 = kind === 'session'
      ? { kind, session: { serverId: f.serverId, sessionId: 'source-session' }, messageId: 'committed-source' }
      : { kind, discussion: { serverId: f.serverId, discussionId: 'source-discussion' }, messageId: 'committed-source' };
    const onSaved = vi.fn();
    const hook = await renderHook(() => useSaveMemoryDecision({ seed: { sourceMessageRef, text: 'QA preserve this decision.', reason: 'Explicit destination.' }, onSaved }));
    try {
      // This is the current data owner; the chooser is composed by UI-M.
      await act(async () => { await hook.getCurrent().refreshTargets(); });
      expect(hook.getCurrent().targets.map(row => row.target)).toEqual([
        { scope: 'account' }, { scope: 'project', projectRef: { serverId: f.serverId, projectKey: 'payments' } },
      ]);
      expect(hook.getCurrent().targetCoverage).toBe('partial');
      await act(async () => { hook.getCurrent().selectTarget(hook.getCurrent().targets[1]!.target); });
      await act(async () => { await hook.getCurrent().save(); });
      const model = hook.getCurrent();
      expect(model.notice).toBe('saved_unattached');
      expect(model.creationReceipt).toMatchObject({ ref: { serverId: f.serverId, kind: 'doc' }, factId: expect.any(String),
        attachment: 'conflict', attachmentFailure: { errorCode: 'source_backend_unavailable' } });
      expect(model.canSave).toBe(false);
      expect(onSaved).not.toHaveBeenCalled();
      const receipt = model.creationReceipt;
      if (!receipt?.factId) throw new Error('Missing exact saved fact receipt');
      const rows = f.home.boundary.list().filter(row => row.id === receipt.ref.artifactId);
      expect(rows).toHaveLength(1);
      const body = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(receipt.ref.artifactId)!));
      expect(body.index[0]).toMatchObject({ id: receipt.factId, decision: { sourceMessageRef, reason: 'Explicit destination.' } });
      expect(f.readSource().attachments).toEqual([]);
      await act(async () => { hook.getCurrent().clearTarget(); });
      expect(hook.getCurrent().selectedTarget).toEqual({ scope: 'project', projectRef: { serverId: f.serverId, projectKey: 'payments' } });
      expect(hook.getCurrent().creationReceipt).toBe(receipt);
      expect(hook.getCurrent().notice).toBe('saved_unattached');
      await act(async () => { await hook.getCurrent().save(); });
      expect(f.home.boundary.list().filter(row => row.id === receipt.ref.artifactId)).toHaveLength(1);
      // Recovery uses the already existing context attachment Action and the exact saved reference.
      f.recover();
      const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
      const recovered = await createDefaultActionExecutor().execute('projects.sources.update', { serverId: f.serverId, sourceId: 'qa-writable',
        expectedRevision: f.readSource().revision, patch: { attachment: { kind: 'attach', attachment: { purpose: 'context',
          entry: { id: 'project.memory', ref: receipt.ref, enabled: true, placement: 'system_append' } } } } },
      { serverId: f.serverId, surface: 'ui', authority: 'present_user' });
      expect(recovered).toMatchObject({ ok: true, result: { ok: true } });
      expect(f.readSource().attachments?.[0]).toMatchObject({ entry: { ref: receipt.ref } });
      expect(f.home.requests.some(request => request.path.includes('/machines/'))).toBe(false);
    } finally { await hook.unmount(); await f.home.dispose(); }
  });

  it('clears a Discussion choice and its duplicate review back to the Account default', async () => {
    const f = await createMemoryDecisionHomeFixture();
    f.recover();
    const seed = { text: 'QA preserve this decision.', reason: 'Explicit destination.', sourceMessageRef: {
      kind: 'discussion' as const, discussion: { serverId: f.serverId, discussionId: 'source' }, messageId: 'committed-source' } };
    const projectTarget = { scope: 'project' as const, projectRef: { serverId: f.serverId, projectKey: 'payments' } };
    const first = await renderHook(() => useSaveMemoryDecision({ seed, onSaved: vi.fn() }));
    try {
      await act(async () => { await first.getCurrent().refreshTargets(); });
      await act(async () => { first.getCurrent().selectTarget(projectTarget); });
      await act(async () => { await first.getCurrent().save(); });
      const receipt = first.getCurrent().creationReceipt;
      if (!receipt) throw new Error('Expected attached decision receipt');
      expect(receipt.attachment).toBe('attached');
      const original = f.home.boundary.readPlainBody(receipt.ref.artifactId);
      await first.unmount();
      const onSaved = vi.fn();
      const reopened = await renderHook(() => useSaveMemoryDecision({ seed, onSaved }));
      try {
        await act(async () => { await reopened.getCurrent().refreshTargets(); });
        expect(reopened.getCurrent().targets.find(row => row.target.scope === 'project')?.ref).toEqual(receipt.ref);
        await act(async () => { reopened.getCurrent().selectTarget(projectTarget); });
        await act(async () => { await reopened.getCurrent().save(); });
        expect(reopened.getCurrent().review).toMatchObject({ ref: receipt.ref, revision: { headerVersion: 1, bodyVersion: 1 } });
        expect(onSaved).not.toHaveBeenCalled();
        await act(async () => { reopened.getCurrent().clearTarget(); });
        expect(reopened.getCurrent()).toMatchObject({ text: seed.text, reason: seed.reason, review: null, candidateId: null, selectedTarget: null });
        await act(async () => { await reopened.getCurrent().save(); });
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(f.home.boundary.readPlainBody(receipt.ref.artifactId)).toBe(original);
        expect(f.home.boundary.list()).toHaveLength(2);
      } finally { await reopened.unmount(); }
    } finally { await first.unmount(); await f.home.dispose(); }
  });

  it('clears an explicit Session choice and review back to the qualified Project default', async () => {
    const f = await createMemoryDecisionHomeFixture({ sessionProject: true });
    f.recover();
    const { memoryDocumentActions, readMemoryCreationReceipt } = await import('@/sync/ops/promptLibrary/memoryDocuments');
    const projectA = { scope: 'project' as const, projectRef: { serverId: f.serverId, projectKey: 'core-payments' } };
    const projectB = { scope: 'project' as const, projectRef: { serverId: f.serverId, projectKey: 'payments' } };
    const text = 'QA preserve this decision.';
    const initialA = readMemoryCreationReceipt(await memoryDocumentActions.rememberInScope(projectA, { text: 'Keep deployment logs.' }, f.serverId));
    const initialB = readMemoryCreationReceipt(await memoryDocumentActions.rememberInScope(projectB, { text }, f.serverId));
    if (!initialA || !initialB) throw new Error('Expected both Project memory documents');
    const beforeB = f.home.boundary.readPlainBody(initialB.ref.artifactId);
    const { storage } = await import('@/sync/domains/state/storage');
    await act(async () => { storage.getState().applySessions([f.session]); });
    const sourceMessageRef: CoordinationMessageRefV1 = { kind: 'session',
      session: { serverId: f.serverId, sessionId: f.session.id }, messageId: 'committed-source' };
    const seed = { text, reason: 'Explicit decision.', sourceMessageRef };
    const onSaved = vi.fn();
    const hook = await renderHook(() => useSaveMemoryDecision({ seed, onSaved }));
    try {
      await act(async () => { await hook.getCurrent().refreshTargets(); });
      await act(async () => { hook.getCurrent().selectTarget(projectB); });
      await act(async () => { await hook.getCurrent().save(); });
      expect(hook.getCurrent().review?.ref).toEqual(initialB.ref);
      await act(async () => { hook.getCurrent().clearTarget(); });
      expect(hook.getCurrent()).toMatchObject({ selectedTarget: null, review: null, candidateId: null,
        notice: null, text: seed.text, reason: seed.reason });
      await act(async () => { await hook.getCurrent().save(); });
      expect(onSaved).toHaveBeenCalledTimes(1);
      const bodyA = MemoryDocBodyV1Schema.parse(JSON.parse(f.home.boundary.readPlainBody(initialA.ref.artifactId)!));
      expect(bodyA.index).toHaveLength(2);
      expect(bodyA.index).toContainEqual(expect.objectContaining({ text, decision: expect.objectContaining({ sourceMessageRef }) }));
      expect(f.home.boundary.readPlainBody(initialB.ref.artifactId)).toBe(beforeB);
      expect(f.home.boundary.list()).toHaveLength(2);
    } finally { await hook.unmount(); await f.home.dispose(); }
  });
});
