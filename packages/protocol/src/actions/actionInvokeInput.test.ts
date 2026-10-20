import { describe, expect, it } from 'vitest';
import { ActionInvokeInputSchema } from './actionInvokeInput.js';
import { UiContributedActionExecuteRequestV1Schema } from '../plugins/actions/clientInvocationV1.js';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '../plugins/actions/daemonInvocationV1.js';

const messageActionReference = { v: 1, sessionId: 'session', messageId: 'message', observedRevision: 'revision' } as const;
const action = { pluginId: 'acme.client', localId: 'draft' };

describe('contributed Message Action reference custody', () => {
  it('preserves the opaque reference outside author input through Action and reverse-client admission', () => {
    const invoked = ActionInvokeInputSchema.parse({ action, input: {}, messageActionReference });
    expect(invoked).toEqual({ action, input: {}, messageActionReference });
    const reversed = UiContributedActionExecuteRequestV1Schema.parse({ v: 1, ...invoked,
      surface: 'cli', expectedContributorOccurrenceId: 'acme.client:1' });
    expect(reversed.messageActionReference).toEqual(messageActionReference);
    expect(ActionInvokeInputSchema.safeParse({ ...invoked,
      messageActionReference: { ...messageActionReference, observedRevision: ' ' } }).success).toBe(false);
    expect(ActionInvokeInputSchema.safeParse({ ...invoked,
      messageActionReference: { ...messageActionReference, visibleText: 'caller-authored text' } }).success).toBe(false);
  });

  it('admits an automated bound client reference without forging present-user message intent', () => {
    const request = { machineId: 'machine', qualifiedActionId: 'acme.client/draft',
      executionSurface: 'cli', expectedContributorOccurrenceId: 'acme.client:1',
      messageActionReference, resolveClientMessageContext: true,
      invocation: { kind: 'clientPluginAction', clientActionBinding: {
        pluginId: 'acme.client', contributionLocalId: 'draft', occurrenceId: 'acme.client:1' } } };
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request)).toEqual(request);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request,
      messageActionReference: undefined }).success).toBe(false);
    expect(DaemonPluginStructuredMessageActionExecuteRequestSchema.safeParse({ ...request,
      sessionId: 'another-session' }).success).toBe(false);
  });
});
