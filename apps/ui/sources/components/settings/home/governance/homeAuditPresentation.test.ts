import { describe, expect, it, vi } from 'vitest';
import { HomeAdministrationEventV1Schema } from '@happier-dev/protocol/home/governance';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { presentHomeAuditEvent } from './homeAuditPresentation';

const profile = { name: 'Alex', firstName: null, lastName: null, username: 'alex', avatarUrl: null };
const base = {
    id: 'event-1', at: 1,
    actor: { kind: 'account', accountId: 'operator', profile },
    target: { kind: 'account', id: 'subject', profile },
};

describe('public-profile administration activity', () => {
    it.each([
        ['public_profile.restricted', 'profileRestricted'],
        ['public_profile.restored', 'profileRestored'],
    ] as const)('keeps %s distinct and presents its recorded reason', (action, verb) => {
        const event = HomeAdministrationEventV1Schema.parse({ ...base, action, summary: { reason: 'Reviewed impersonation report' } });
        expect(presentHomeAuditEvent(event)).toMatchObject({
            actorAccount: { id: 'operator', avatarUrl: null },
            verb: `homeGovernance.activity.${verb}`,
            area: 'homeGovernance.activity.areaPublicProfiles',
            changes: [{ label: 'homeGovernance.activity.fieldReason', from: 'homeGovernance.activity.valueEmpty', to: 'Reviewed impersonation report' }],
        });
    });

    it('presents the exact reclaimed handle, operator reason and owner notice from the committed event', () => {
        const event = HomeAdministrationEventV1Schema.parse({
            ...base, action: 'public_profile.handle_reclaimed',
            summary: { username: 'Reviewed.Handle', reason: 'Impersonation', notice: 'Choose a different username.' },
        });
        expect(presentHomeAuditEvent(event)).toMatchObject({
            verb: 'homeGovernance.activity.handleReclaimed',
            area: 'homeGovernance.activity.areaPublicProfiles',
            changes: [
                { label: 'homeGovernance.activity.fieldUsername', from: 'Reviewed.Handle', to: 'homeGovernance.activity.valueEmpty' },
                { label: 'homeGovernance.activity.fieldReason', from: 'homeGovernance.activity.valueEmpty', to: 'Impersonation' },
                { label: 'homeGovernance.activity.fieldNotice', from: 'homeGovernance.activity.valueEmpty', to: 'Choose a different username.' },
            ],
        });
    });
});
