import { TriageGetResultV1Schema, TriageListInstancesResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';
import { getLinearEntry, listLinearInstances, listLinearScopeUnits, scanLinearSource, readLinearDetail } from './source.js';

import { account, instance, localRef, issue, page, host } from './fixtures.test-support.js';
import { writeLinearScopeSelection } from './contracts.js';

const workspaceInstance = (teams: unknown) => ({ ...instance, localInstanceKey: 'linear',
  configuration: { v: 1 as const, token: JSON.stringify({ v: 1, teams, involvement: 'everyone' }) } });

describe('Linear source through provider HTTP', () => {
  it('projects a due date and provider completion time through the scan snapshot', async () => {
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(query).toContain('completedAt');
      expect(query).toContain('dueDate');
      return { issues: page([{ ...issue, state: { id: 'done', name: 'Done', type: 'completed' }, completedAt: '2026-10-20T09:00:00Z' }]) };
    });
    const result = TriageScanResultV1Schema.parse(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context));
    expect(result).toMatchObject({ kind: 'complete', observations: [{ snapshot: {
      dueDate: issue.dueDate, completedAtMs: Date.parse('2026-10-20T09:00:00Z'),
    } }] });
  });
  it('loads complete editable values without putting bodies into scans', async () => {
    const body = 'Full Markdown\n\nPreserve whitespace.  \n';
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearIssue') return { issue: { ...issue, title: '界'.repeat(1000), description: body } };
      if (query.includes('labels(')) return { issue: { ...issue, labels: page([{ id: 'label-1', name: 'Fix' }]) } };
      throw new Error('Optional relation unavailable');
    });
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({ kind: 'present',
      snapshot: { projectionTruncated: true }, taskFields: { title: '界'.repeat(1000), body, assigneeIds: ['viewer-1'],
        labelIds: ['label-1'], projectId: 'project-1', priority: 2, dueDate: '2026-10-25', estimate: 3, parent: { entryId: 'parent-1' } } });
  });
  it('discovers one workspace through the exact listed account', async () => {
    const h = host(() => ({ viewer: { organization: { id: 'workspace-1', name: 'Engineering workspace' } } }));
    const result = TriageListInstancesResultV1Schema.parse(await listLinearInstances({ v: 1 }, h.context));
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('discovery failed');
    expect(result.candidates.map((candidate) => candidate.localInstanceKey)).toEqual(['linear']);
    expect(result.candidates[0]?.locator.displayLabel).toBe('Engineering workspace');
    expect(h.materializeListedAccount).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'linear-api', account }), expect.anything());
    expect(JSON.stringify(result)).not.toContain('test-personal-key');
  });

  it('pages the involvement union without dropping overlapping assigned/created/subscribed facts', async () => {
    const h = host(({ operationName, variables }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      expect(variables.filter).toEqual({ team: { id: { eq: 'team-1' } }, or: [
        { assignee: { id: { eq: 'viewer-1' } } }, { creator: { id: { eq: 'viewer-1' } } }, { subscribers: { some: { id: { eq: 'viewer-1' } } } },
      ] });
      return { issues: page([{ ...issue, subscribers: page([{ id: 'viewer-1' }]) }], true, 'issues-next') };
    });
    const result = TriageScanResultV1Schema.parse(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context));
    expect(result.kind).toBe('page');
    if (result.kind === 'failed') throw new Error('scan failed');
    expect(result.observations[0]).toMatchObject({ kind: 'present', localRef, snapshot: {
      designation: 'ENG-123', state: { presentation: 'active', nativeLabel: 'In Progress', stage: 'started' }, projectionTruncated: true,
    }, viewer: { involvement: ['author', 'assignee', 'subscribed'] } });
    if (result.observations[0]?.kind !== 'present') throw new Error('missing present issue');
    expect(result.observations[0].snapshot.facts).toContainEqual({ id: 'assignee', label: 'Assignee', importance: 'secondary', value: { kind: 'text', value: 'Mara' } });
    expect(JSON.stringify(result)).not.toContain('description');
  });

  it('scans all accessible teams or the exact selected set in one workspace lane', async () => {
    for (const teams of [{ kind: 'all' }, { kind: 'selected', unitIds: ['team-1', 'team-2'] }]) {
      const configured = workspaceInstance(teams);
      const h = host(({ operationName, variables }) => {
        if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
        expect(variables.filter).toEqual(teams.kind === 'all' ? {} : { team: { id: { in: ['team-1', 'team-2'] } } });
        return { issues: page([issue, { ...issue, id: 'issue-2', team: { id: 'team-2', key: 'OPS', name: 'Operations' } }]) };
      });
      expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'complete', observations: [
          { localRef: { collisionScope: 'linear', entryId: 'issue-1' }, snapshot: { scopeUnitId: 'team-1' } },
          { localRef: { collisionScope: 'linear', entryId: 'issue-2' }, snapshot: { scopeUnitId: 'team-2' } },
        ] });
    }
  });

  it('refuses provider rows outside selected teams in scans and exact reads', async () => {
    const configured = workspaceInstance({ kind: 'selected', unitIds: ['team-2'] });
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : operationName === 'LinearIssues' ? { issues: page([issue]) } : { issue });
    expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
      .toMatchObject({ kind: 'failed', failure: { code: 'linear/teamMismatch' } });
    expect(await getLinearEntry({ v: 1, instance: configured, localRef }, h.context))
      .toMatchObject({ kind: 'unresolved', failure: { code: 'linear/entryMismatch' } });
  });

  it('keeps historical team keys usable with old tokens and newly written selections', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issues: page([issue]) });
    for (const configured of [instance, { ...workspaceInstance({ kind: 'selected', unitIds: ['team-1'] }), localInstanceKey: instance.localInstanceKey }]) {
      expect(await scanLinearSource({ v: 1, instance: configured, page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'complete', observations: [{ localRef }] });
    }
    expect(await listLinearScopeUnits({ v: 1, mode: 'configured', draft: {
      v: 1, binding: instance.binding, localInstanceKey: instance.localInstanceKey, configuration: instance.configuration,
    } }, h.context)).toMatchObject({ kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['team-1'] }, units: [{ id: 'team-1' }] });
  });

  it('writes the shared selection through the Linear codec while retaining identity and involvement', async () => {
    const previous = { v: 1 as const, binding: instance.binding, localInstanceKey: instance.localInstanceKey,
      configuration: instance.configuration, keyStability: 'stable' as const, locator: { v: 1 as const, displayLabel: 'Engineering' } };
    const draft = writeLinearScopeSelection(previous, { kind: 'selected', unitIds: ['team-2'] },
      [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS', collisionScope: 'incorrect-team-identity' }]);
    expect(draft.localInstanceKey).toBe(previous.localInstanceKey);
    expect(draft.binding).toEqual(previous.binding);
    expect(JSON.parse(draft.configuration.token)).toEqual({ v: 1, involvement: 'mine', teams: { kind: 'selected', unitIds: ['team-2'] },
      teamUnits: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }] });
    const h = host(() => { throw new Error('Configured projection must not call Linear'); });
    expect(await listLinearScopeUnits({ v: 1, draft, mode: 'configured' }, h.context)).toEqual({ kind: 'page', status: 'complete',
      selection: { kind: 'selected', unitIds: ['team-2'] }, units: [{ id: 'team-2', label: 'Operations', secondaryText: 'OPS' }] });
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('refuses empty, duplicate and unknown selections before provider authorization', async () => {
    const h = host(() => ({}));
    for (const teams of [{ kind: 'selected', unitIds: [] }, { kind: 'selected', unitIds: ['team-1', 'team-1'] }, { kind: 'future' }]) {
      expect(await scanLinearSource({ v: 1, instance: workspaceInstance(teams), page: { kind: 'initial', limit: 20 } }, h.context))
        .toMatchObject({ kind: 'failed', failure: { code: 'linear/configurationInvalid' } });
    }
    expect(h.request).not.toHaveBeenCalled();
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('reports GraphQL HTTP-400 RATELIMITED with the provider complexity reset and never retries', async () => {
    const h = host(() => ({}));
    h.request.mockResolvedValue({ status: 400, finalUrl: 'https://api.linear.app/graphql', headers: {
      'X-RateLimit-Requests-Remaining': '2', 'X-RateLimit-Requests-Reset': '1792320000000',
      'X-RateLimit-Complexity-Remaining': '0', 'X-RateLimit-Complexity-Reset': '1792320300000',
    }, body: new TextEncoder().encode(JSON.stringify({ errors: [{ message: 'private provider prose', extensions: { code: 'RATELIMITED' } }] })) });
    const result = await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, h.context);
    expect(result).toEqual({ kind: 'failed', failure: { class: 'rateLimit', code: 'linear/rateLimited', retryNotBeforeMs: 1792320300000 } });
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-team reference before credentials or provider access', async () => {
    const h = host(() => ({}));
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef: { ...localRef, collisionScope: 'other-deployment' } }, h.context));
    expect(result.kind).toBe('unresolved');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('keeps credential refusal and cancellation explicit without an anonymous provider request', async () => {
    const h = host(() => ({}));
    h.materializeListedAccount.mockRejectedValue(new Error('private credential failure'));
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({
      kind: 'unresolved', failure: { class: 'authentication', code: 'linear/materializationFailed' },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await scanLinearSource({ v: 1, instance, page: { kind: 'initial', limit: 20 } }, { ...h.context, signal: controller.signal }))
      .toMatchObject({ kind: 'failed', failure: { class: 'transient', code: 'linear/cancelled' } });
    expect(h.request).not.toHaveBeenCalled();
  });

  it('keeps GraphQL not-found/permission errors unresolved rather than inventing absence', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : { issue: null });
    expect(await getLinearEntry({ v: 1, instance, localRef }, h.context)).toMatchObject({ kind: 'unresolved', localRef });
  });

  it('retains a readable issue with long Unicode content and an unfamiliar native state', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } }
      : { issue: { ...issue, title: '界'.repeat(1000), state: { ...issue.state, type: 'future-state' } } });
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef }, h.context));
    expect(result).toMatchObject({ kind: 'present', localRef, snapshot: { state: { presentation: 'unknown' }, projectionTruncated: true } });
  });

  it('reads native relations in their real direction, with an explicit next page', async () => {
    const h = host(({ operationName }) => operationName === 'LinearViewer' ? { viewer: { id: 'viewer-1' } } : {
      issue: { ...issue, inverseRelations: page([{ type: 'blocks', issue: { id: 'blocker-1', identifier: 'OPS-7', title: 'Upstream work' }, relatedIssue: { id: issue.id, identifier: issue.identifier, title: issue.title } }], true, 'relations-next') },
    });
    expect(await readLinearDetail({ v: 1, instance, localRef, section: 'blockedBy' }, h.context)).toMatchObject({
      kind: 'ready', entries: [{ id: 'blocker-1', title: 'OPS-7 · Upstream work' }], continuation: 'relations-next',
    });
  });

  it.each([1, 2])('projects native transitions and declares one-step completion only for an unambiguous done state (%s)', async (doneStates) => {
    const h = host(({ operationName, query }) => {
      if (operationName === 'LinearViewer') return { viewer: { id: 'viewer-1' } };
      if (operationName === 'LinearIssue') return { issue };
      if (query.includes('children(')) return { issue: { ...issue, children: page([{ id: 'child-1', identifier: 'ENG-124', title: 'Child' }]) } };
      if (query.includes('inverseRelations(')) return { issue: { ...issue, inverseRelations: page([{ type: 'blocks', issue: { id: 'blocker-1', identifier: 'OPS-7', title: 'Dependency' }, relatedIssue: issue }]) } };
      return { issue: { ...issue, team: { ...issue.team, states: page([{ id: 'state-1', name: 'In Progress', type: 'started' },
        ...Array.from({ length: doneStates }, (_, index) => ({ id: `done-${index}`, name: 'Done', type: 'completed' }))]) } } };
    });
    const result = TriageGetResultV1Schema.parse(await getLinearEntry({ v: 1, instance, localRef }, h.context));
    expect(result).toMatchObject({ kind: 'present', snapshot: {
      relations: { parent: { entryId: 'parent-1' }, children: { total: 1, complete: true, entries: [{ entryId: 'child-1' }] }, blockedBy: [{ entryId: 'blocker-1' }] },
    } });
    if (result.kind !== 'present') throw new Error('Expected a task');
    expect(result.snapshot.taskCapabilities?.transitions?.[0]).toMatchObject({ id: 'state-1', state: { presentation: 'active', stage: 'started' } });
    expect(result.snapshot.taskCapabilities?.completingTransitionId).toBe(doneStates === 1 ? 'done-0' : undefined);
  });
});
