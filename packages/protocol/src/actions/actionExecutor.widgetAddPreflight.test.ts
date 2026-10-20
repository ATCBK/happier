import { describe, expect, it } from 'vitest';

import { createActionExecutor } from './actionExecutor.js';
import { readBuiltinWidgetDescriptorV1 } from '../widgets/builtinWidgetDescriptorV1.js';
import { createWidgetActionInputResolverV1 } from '../widgets/widgetActionInputResolverV1.js';

const surface = { serverId: 'home', accountId: 'account', owner: { kind: 'home' } } as const;
const summary = { kind: 'builtin', id: 'session_summary' } as const;

/** The widget's own input owner decides; host ports only supply facts that a valid pick satisfies. */
const executor = createActionExecutor({
  widgetAccountScope: () => ({ serverId: surface.serverId, accountId: surface.accountId }),
  widgetInputs: createWidgetActionInputResolverV1({
    readDescriptor: async () => readBuiltinWidgetDescriptorV1(summary),
    readContext: async () => ({}), readViewerValues: async () => ({ values: {} }),
    validateValue: async () => ({ status: 'valid' }), resolveOptions: async () => [{ value: { serverId: 'home', sessionId: 'B' } }],
  }),
});
// Without an approval store a request that needs a person's approval stops at `approvals_not_supported`,
// which is how this test observes that admission reached the approval step.
const add = (value: unknown) => executor.execute('widgets.item.add', { surface, instance: { v: 1, id: 'summary', definition: summary,
  bindings: { session: { kind: 'value', value } } } }, { surface: 'agent', authority: 'account_automation', serverId: 'home' });

describe('widgets.item.add admission before approval', () => {
  it('refuses inputs that can never run instead of asking a person to approve them', async () => {
    expect(await add(['B'])).toMatchObject({ ok: false, errorCode: 'widget_inputs_invalid', details: { status: 'invalid' } });
  });

  it('asks for approval when the same inputs are valid', async () => {
    expect(await add({ serverId: 'home', sessionId: 'B' })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
  });
});
