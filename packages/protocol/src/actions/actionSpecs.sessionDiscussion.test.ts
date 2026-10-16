import { describe, expect, it } from 'vitest';

import { ACTION_IDS, ActionIdSchema } from './actionIds.js';
import {
  PUBLIC_ACTION_IDS,
  PublicActionIdSchema,
  getActionSpec,
  isInternalActionId,
  isPluginProvenanceOnlyActionId,
  isPluginSurfaceExcludedActionId,
  listActionSpecs,
} from './actionSpecs.js';
import {
  isAgentInitiatedApprovalRequiredByDefault,
  isApprovalRequiredByActionsSettings,
} from './actionApprovalPolicy.js';
import {
  ActionsSettingsV1Schema,
  isActionEnabledByActionsSettings,
  setActionApprovalOverride,
} from './actionSettings.js';
import { SESSION_DISCUSSION_ACTION_IDS_V1 } from '../sessions/discussions/actionIds.js';
import {
  SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1,
  SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1,
} from '../sessions/discussions/actions.js';
import { SESSION_DISCUSSION_HTTP_PATHS_V1 } from '../sessions/discussions/api.js';
import { canRequestPresentUserApprovalForActionInputV1, resolveCredentialActionAdmissionV1 } from './decisionAuthority.js';

const READ_ACTION_IDS = [
  'session.discussion.list',
  'session.discussion.get',
  'session.discussion.read',
] as const;

const MANAGEMENT_ACTION_IDS = [
  'session.discussion.create',
  'session.discussion.rename',
  'session.discussion.archive',
  'session.discussion.restore',
  'session.discussion.read_state.set',
] as const;

describe('Session discussion Action catalog rows', () => {
  it('publishes the nine discussion intents through the canonical Action id registry', () => {
    for (const actionId of SESSION_DISCUSSION_ACTION_IDS_V1) {
      expect(ActionIdSchema.safeParse(actionId).success, actionId).toBe(true);
      expect(ACTION_IDS).toContain(actionId);
    }
    expect(
      listActionSpecs()
        .filter((spec) => spec.id.startsWith('session.discussion.'))
        .map((spec) => spec.id)
        .sort(),
    ).toEqual([...SESSION_DISCUSSION_ACTION_IDS_V1].sort());
    // Human collaboration is Session-owned; no top-level discussion vocabulary exists.
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('discussion.'))).toBe(false);
    expect(ACTION_IDS.some((actionId) => actionId.startsWith('conversation.'))).toBe(false);
  });

  it('binds each row to the discussion schemas rather than a second input vocabulary', () => {
    for (const actionId of SESSION_DISCUSSION_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.inputSchema, actionId).toBe(SESSION_DISCUSSION_ACTION_INPUT_SCHEMAS_V1[actionId]);
      expect(spec.outputSchema, actionId).toBe(SESSION_DISCUSSION_ACTION_OUTPUT_SCHEMAS_V1[actionId]);
      expect(spec.requiredAuthority, actionId).toBe(
        MANAGEMENT_ACTION_IDS.some(id => id === actionId) ? 'present_user' : 'account_automation',
      );
      // Discussions live on the Session's own Home and resolve through that owner.
      expect(spec.executionPlacement, actionId).toBe('session');
      expect(spec.contextualDefaults, actionId).toEqual({ sessionId: 'current_session' });
      expect(isInternalActionId(actionId), actionId).toBe(false);
      expect(isPluginProvenanceOnlyActionId(actionId), actionId).toBe(false);
      expect(isPluginSurfaceExcludedActionId(actionId), actionId).toBe(false);
    }
  });

  it('exposes management to Agent and MCP through present-user approval', () => {
    for (const actionId of READ_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.agent, actionId).toBe(true);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(spec.surfaces.ui, actionId).toBe(true);
      expect(spec.surfaces.cli, actionId).toBe(true);
      expect(spec.sideEffectClass, actionId).toBe('read');
    }

    // An Agent may deliberately author a discussion message on behalf of its
    // authenticated execution Account.
    const post = getActionSpec('session.discussion.post');
    expect(post.surfaces.agent).toBe(true);
    expect(post.surfaces.mcp).toBe(true);
    expect(post.sideEffectClass).toBe('danger');

    for (const actionId of MANAGEMENT_ACTION_IDS) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.agent, actionId).toBe(true);
      expect(spec.surfaces.mcp, actionId).toBe(true);
      expect(spec.surfaces.ui, actionId).toBe(true);
      expect(spec.surfaces.cli, actionId).toBe(true);
      expect(spec.requiredAuthority, actionId).toBe('present_user');
      expect(canRequestPresentUserApprovalForActionInputV1(spec), actionId).toBe(true);
      for (const surface of ['agent', 'mcp'] as const) {
        expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null, surface }), actionId)
          .toEqual({ ok: true });
        expect(isApprovalRequiredByActionsSettings(actionId, ActionsSettingsV1Schema.parse({ v: 1 }),
          { surface, authority: 'account_automation' }), actionId).toBe(true);
      }
      expect(resolveCredentialActionAdmissionV1({ spec, authority: 'account_automation', grant: null,
        surface: 'api', hasExternalCredential: true }), actionId)
        .toEqual({ ok: false, errorCode: 'present_user_required' });
      expect(spec.surfaces.plugin, actionId).toBe(true);
      expect(PUBLIC_ACTION_IDS, actionId).not.toContain(actionId);
      expect(PublicActionIdSchema.safeParse(actionId).success, actionId).toBe(false);
    }
  });

  it('makes an Agent-initiated post dangerous by default and user-overridable through the shared policy', () => {
    expect(isAgentInitiatedApprovalRequiredByDefault('session.discussion.post')).toBe(true);
    for (const actionId of READ_ACTION_IDS) {
      expect(isAgentInitiatedApprovalRequiredByDefault(actionId), actionId).toBe(false);
    }

    const inherit = ActionsSettingsV1Schema.parse({ v: 1, actions: {} });
    expect(isApprovalRequiredByActionsSettings('session.discussion.post', inherit, { surface: 'agent' })).toBe(true);

    // The explicit user waiver is resolved by the shared Actions settings owner,
    // never by a discussion-only bypass.
    const waived = setActionApprovalOverride({
      settings: inherit,
      actionId: 'session.discussion.post',
      surface: 'agent',
      approvalRequired: false,
    });
    expect(isApprovalRequiredByActionsSettings('session.discussion.post', waived, { surface: 'agent' })).toBe(false);

    const restored = setActionApprovalOverride({
      settings: waived,
      actionId: 'session.discussion.post',
      surface: 'agent',
      approvalRequired: null,
    });
    expect(isApprovalRequiredByActionsSettings('session.discussion.post', restored, { surface: 'agent' })).toBe(true);

    // Waiving confirmation never re-enables a disabled Action or a disabled surface.
    const disabled = setActionApprovalOverride({
      settings: ActionsSettingsV1Schema.parse({
        v: 1,
        actions: { 'session.discussion.post': { enabled: false } },
      }),
      actionId: 'session.discussion.post',
      surface: 'agent',
      approvalRequired: false,
    });
    expect(isActionEnabledByActionsSettings('session.discussion.post', disabled, { surface: 'agent' })).toBe(false);
  });

  it('declares the exact nested Session storage transport for every mutating intent', () => {
    expect(getActionSpec('session.discussion.create').serverTransport)
      .toEqual({ method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.collection });
    expect(getActionSpec('session.discussion.post').serverTransport)
      .toEqual({ method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.messages });
    expect(getActionSpec('session.discussion.rename').serverTransport)
      .toEqual({ method: 'PATCH', path: SESSION_DISCUSSION_HTTP_PATHS_V1.discussion });
    expect(getActionSpec('session.discussion.archive').serverTransport)
      .toEqual({ method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.archive });
    expect(getActionSpec('session.discussion.restore').serverTransport)
      .toEqual({ method: 'POST', path: SESSION_DISCUSSION_HTTP_PATHS_V1.restore });
    expect(getActionSpec('session.discussion.read_state.set').serverTransport)
      .toEqual({ method: 'PUT', path: SESSION_DISCUSSION_HTTP_PATHS_V1.read });
  });
});
