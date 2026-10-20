import { afterEach, describe, expect, it, vi } from 'vitest';
import { instantiateWidgetLayoutFragmentGroupV1, type WidgetLayoutFragmentDraftV1, type WidgetLayoutFragmentGroupV1 } from '@happier-dev/protocol/widgets';

import * as uuidBoundary from '@/platform/randomUUID';
import { createSaveWidgetGroupAttemptV1, runAddWidgetLayoutFragmentCommandV1, runCopyWidgetGroupCommandV1 } from './widgetLayoutFragmentCommands';

const account = { serverId: 'home-a', accountId: 'account-a' };
const surface = { ...account, owner: { kind: 'home' } } as const;
const descriptor = { name: 'Release checks', inputs: { fields: [] }, inputSchema: { type: 'object' } } satisfies Omit<WidgetLayoutFragmentDraftV1, 'group'>;
const fragment = { width: 'full', frameStyle: 'card', dividers: 'hairline', children: [{ kind: 'widget',
    instance: { v: 1, definition: { kind: 'builtin', id: 'summary' }, bindings: {} } }] } satisfies WidgetLayoutFragmentGroupV1;
const group = instantiateWidgetLayoutFragmentGroupV1(fragment, { groupId: 'source-group', childIds: ['source-widget'] });

afterEach(() => vi.restoreAllMocks());

describe('fragment command preparation outcomes', () => {
    it.each(['save', 'add', 'copy'] as const)('returns a terminal refusal when %s UUID allocation fails', async (command) => {
        // UUID allocation is a platform boundary; capture, instantiation and the command remain real.
        vi.spyOn(uuidBoundary, 'randomUUID').mockImplementationOnce(() => { throw Object.assign(new Error('UUID unavailable'), { code: 'uuid_unavailable' }); });
        const run = async () => command === 'save' ? createSaveWidgetGroupAttemptV1(account).run(group, descriptor)
            : command === 'add' ? runAddWidgetLayoutFragmentCommandV1(fragment, surface)
                : runCopyWidgetGroupCommandV1(group, surface);
        await expect(run()).resolves.toEqual({ kind: 'refused', errorCode: 'uuid_unavailable' });
    });

    it.each(['save', 'copy'] as const)('returns a terminal refusal when %s captures an invalid source group', async (command) => {
        const invalidGroup = { ...group, children: [] };
        const run = async () => command === 'save' ? createSaveWidgetGroupAttemptV1(account).run(invalidGroup, descriptor)
            : runCopyWidgetGroupCommandV1(invalidGroup, surface);
        await expect(run()).resolves.toEqual({ kind: 'refused', errorCode: 'widget_command_failed' });
    });

    it('returns a terminal refusal when a saved fragment cannot be instantiated', async () => {
        // A repeated platform identity reaches the real instantiation invariant.
        vi.spyOn(uuidBoundary, 'randomUUID').mockReturnValue('same-id');
        await expect((async () => runAddWidgetLayoutFragmentCommandV1(fragment, surface))()).resolves.toEqual({ kind: 'refused', errorCode: 'widget_command_failed' });
    });
});
