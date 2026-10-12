import { expect, it } from 'vitest';

import { AccountProfileSchema } from '../account/profile.js';
import { QualifiedConnectedAccountRefSchema } from '../connect/qualifiedConnectedAccountPersistence.js';
import { isWidgetConnectedAccountSelectionEligibleV1 } from './widgetViewerPurposeV1.js';

it('reads a retained personal pin without admitting unknown fields in a newly selected account', () => {
  const selection = { service: { pluginId: 'com.acme.metrics', localId: 'cloud' }, accountId: 'mine' };
  const profile = AccountProfileSchema.parse({ id: 'viewer', connectedAccountsV4: [{ ref: selection,
    status: 'connected', authenticationModeId: 'token', configurationReady: true,
    configurationRevision: null, revisionSemantics: 'revisioned',
    credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [] }] });
  const input = { field: { path: 'connection', title: 'Connection', widget: 'select' as const,
    connectedAccountOptions: true }, surface: { serverId: 'home', accountId: 'viewer', owner: { kind: 'home' as const } },
    selection, viewerValues: {}, profile, now: 1 };
  const eligible = (value: unknown) => isWidgetConnectedAccountSelectionEligibleV1({ ...input,
    binding: { kind: 'value', value } });
  expect(eligible(selection)).toBe(true);
  const retained = { ...selection, retired: true, service: { ...selection.service, retired: true } };
  expect(eligible(retained)).toBe(true);
  expect(QualifiedConnectedAccountRefSchema.safeParse(retained).success).toBe(false);
  expect(eligible({ ...retained, accountId: 'foreign' })).toBe(false);
  expect(eligible({ ...retained, service: { ...retained.service, localId: 7 } })).toBe(false);
});
