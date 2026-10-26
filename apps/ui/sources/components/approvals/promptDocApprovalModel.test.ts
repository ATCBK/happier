import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestSchema, StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { readPromptDocInLibrary, updatePromptDocInLibrary, type PromptLibraryArtifactStore,
  type PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { artifactSavedByFromActionContextV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { projectApprovalRequestForPublicRead } from '@happier-dev/protocol/actions/actionApprovalPresentation';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readPromptDocInstructionWriteFacts, readPromptDocUpdateApproval } from './promptDocApprovalModel';

// Only persistence is replaced: requests, decisions, replay, CAS and read projection stay real.
function fixture() {
  let artifact: PromptLibraryStoredArtifact = { id: 'doc', revision: { headerVersion: 1, bodyVersion: 1 },
    header: { v: 1, kind: 'prompt_doc.v2', title: 'Instructions' },
    body: JSON.stringify({ v: 1, markdown: 'Previous', createdAtMs: 1, updatedAtMs: 1 }) };
  const approvals = new Map<string, string>();
  const readApproval = (artifactId: string) => {
    const stored = approvals.get(artifactId);
    return stored ? StoredApprovalRequestSchema.parse(JSON.parse(stored)) : null;
  };
  const store: PromptLibraryArtifactStore = { read: async () => artifact, update: async input => {
    expect(input.expectedRevision).toEqual(artifact.revision);
    artifact = { ...artifact, header: input.header, body: input.body,
      revision: { headerVersion: artifact.revision.headerVersion + 1, bodyVersion: artifact.revision.bodyVersion + 1 },
      ...(input.savedBy ? { provenance: { savedBy: input.savedBy } } : { provenance: undefined }) };
    return { revision: artifact.revision };
  } };
  const executor = createActionExecutor(createActionExecutorBoundaryFixture({
    approvalsCreate: async ({ request }) => { const id = `approval-${approvals.size}`; approvals.set(id, JSON.stringify(ApprovalRequestSchema.parse(request))); return { artifactId: id }; },
    approvalsGet: async ({ artifactId }) => readApproval(artifactId),
    approvalsUpdate: async ({ artifactId, request }) => { approvals.set(artifactId, JSON.stringify(ApprovalRequestSchema.parse(request))); return { ok: true }; },
    isApprovalExecutionOriginCurrent: async () => true,
    promptDocUpdate: async ({ signal, ...request }, context) => updatePromptDocInLibrary({ store, request, signal,
      savedBy: artifactSavedByFromActionContextV1(context) }),
  }));
  const agent = { surface: 'agent', serverId: 'home', runtimeAccountId: 'owner', defaultSessionId: 'bot' } as const;
  const person = { surface: 'ui', serverId: 'home', authority: 'present_user', runtimeAccountId: 'reviewer' } as const;
  return {
    executor, store,
    approval: () => readApproval('approval-0')!,
    propose: () => executor.execute('prompt_doc.update', { artifactId: 'doc', title: 'Instructions', markdown: 'Accepted' },
      { ...agent, actionRequestId: `proposal-${approvals.size}` }),
    decide: (decision: 'approve' | 'reject', surface: 'ui' | 'voice' = 'ui') => executor.execute('approval.request.decide', { artifactId: 'approval-0', decision }, { ...person, surface }),
    facts: async (historical = false) => {
      const document = await readPromptDocInLibrary({ store, artifactId: 'doc' });
      if (!document.ok) throw new Error('Expected current document');
      return readPromptDocInstructionWriteFacts(document, [...approvals.keys()].map(id => {
        const request = readApproval(id)!;
        if (historical && request.v === 2 && request.decision) {
          const { decidedVia: _modality, ...decision } = request.decision;
          return StoredApprovalRequestSchema.parse({ ...request, decision });
        }
        return request;
      }));
    },
  };
}

describe('Instructions accepted provenance and Agent write result', () => {
  it.each(['approve', 'reject'] as const)('retains the Voice agent deciding for a person through %s settlement and stored reads', async decision => {
    const f = fixture();
    await f.propose();
    const requester = f.approval().createdBy;
    expect((await f.decide(decision, 'voice')).ok).toBe(true);
    expect(f.approval()).toMatchObject({ createdBy: requester, decision: {
      kind: decision, authority: 'present_user', decidingAccountId: 'reviewer', decidedVia: 'voice',
    } });
    const publicRead = projectApprovalRequestForPublicRead(f.approval());
    const outputSchema = getActionSpec('approval.request.get').outputSchema;
    if (!outputSchema) throw new Error('Expected the approval read output schema');
    const observed = outputSchema.parse({ artifactId: 'approval-0', request: publicRead,
      queryPlan: { kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore', boundedBy: 'approval artifact id', hydratedTranscripts: false } });
    expect(observed).toMatchObject({ request: { decision: { kind: decision, decidedVia: 'voice' } } });
    expect(JSON.stringify(publicRead)).not.toContain('reviewer');
    if (decision === 'approve') {
      expect(await f.facts()).toMatchObject({ provenance: {
        changedBy: { kind: 'agent', accountId: 'owner', sessionId: 'bot' },
        approvedBy: { kind: 'person', accountId: 'reviewer', decidedVia: 'voice' },
      }, agentWriteResult: { status: 'updated' } });
      expect((await f.facts(true)).provenance.approvedBy).toEqual({ kind: 'person', accountId: 'reviewer' });
    } else expect(await f.facts()).toMatchObject({ provenance: {}, agentWriteResult: { status: 'denied' } });
  });
  it('omits unknown identities despite document timestamps, and retains genuine pending/denied results without changing provenance', async () => {
    const f = fixture();
    expect(await f.facts()).toEqual({ provenance: {}, agentWriteResult: null });
    await f.propose();
    expect(await f.facts()).toMatchObject({ provenance: {}, agentWriteResult: { status: 'pending' } });
    expect((await f.decide('reject')).ok).toBe(true);
    expect(await f.facts()).toMatchObject({ provenance: {}, agentWriteResult: { status: 'denied' } });
    expect(readPromptDocUpdateApproval(f.approval())).toHaveProperty('outcome', { status: 'denied' });
    expect(await readPromptDocInLibrary({ store: f.store, artifactId: 'doc' })).toMatchObject({ markdown: 'Previous' });
  });

  it('names the actual Agent and approving person only on the accepted revision, never on a later independent edit', async () => {
    const f = fixture();
    await f.propose();
    expect((await f.decide('approve')).ok).toBe(true);
    expect(f.approval().decision).not.toHaveProperty('decidedVia');
    expect(await f.facts()).toMatchObject({ provenance: {
      changedBy: { kind: 'agent', accountId: 'owner', sessionId: 'bot' }, approvedBy: { kind: 'person', accountId: 'reviewer' },
    }, agentWriteResult: { status: 'updated' } });
    expect(readPromptDocUpdateApproval(f.approval())).toHaveProperty('outcome', { status: 'updated' });
    await updatePromptDocInLibrary({ store: f.store, savedBy: { kind: 'person', accountId: 'other' },
      request: { artifactId: 'doc', title: 'Instructions', markdown: 'Later independent edit' } });
    expect((await f.facts()).provenance).toEqual({ changedBy: { kind: 'person', accountId: 'other' } });
  });
});
