import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;
const summary = { kind: 'builtin', id: 'session_summary' } as const;

type OptionsRead = Parameters<typeof createWidgetActionInputResolverV1>[0]['resolveOptions'];
const offered: OptionsRead = async () => [{ value: { serverId: 'home', sessionId: 'B' } }];

/** The widget's own input owner decides; host ports only supply facts that a valid pick satisfies. */
const createExecutor = (resolveOptions: OptionsRead) => createActionExecutor({
  widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
  widgetInputs: createWidgetActionInputResolverV1({
    readDescriptor: async () => readBuiltinWidgetDescriptorV1(summary),
    readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
    validateValue: async () => ({ status: 'valid' }), resolveOptions,
  }),
});
// Without an approval store a request that needs a person's approval stops at `approvals_not_supported`,
// which is how this test observes that admission reached the approval step.
const add = (value: unknown, executor = createExecutor(offered)) => executor.execute('widgets.item.add', { surface, instance: { v: 1, id: 'summary', definition: summary,
  bindings: { session: { kind: 'value', value } } } }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });

describe('widgets.item.add admission before approval', () => {
  it('refuses inputs that can never run instead of asking a person to approve them', async () => {
    expect(await add(['B'])).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'invalid' } });
  });

  it('asks for approval when the same inputs are valid', async () => {
    expect(await add({ serverId: 'home', sessionId: 'B' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  // An agent's Session caller signs its reads with the root authorization of this very add, which Home
  // does not admit for a Session read: the read answers "not authenticated" without saying anything
  // about the pick. Only the approved execution, where the person's own Account reads, can decide.
  it('leaves a pick to the approved execution when this caller\'s authority cannot read it', async () => {
    const cannotRead = createExecutor(async () => ({ status: 'unavailable', reasonCode: 'not_authenticated' }));
    expect(await add({ serverId: 'home', sessionId: 'B' }, cannotRead)).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });

  it('still refuses a pick whose read answered that it is unavailable for another reason', async () => {
    const mismatched = createExecutor(async () => ({ status: 'unavailable', reasonCode: 'server_scope_mismatch' }));
    expect(await add({ serverId: 'home', sessionId: 'B' }, mismatched)).toMatchObject({
      ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'unavailable' } });
  });
});
