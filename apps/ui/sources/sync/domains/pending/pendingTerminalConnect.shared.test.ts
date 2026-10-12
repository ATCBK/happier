import { describe, expect, it } from 'vitest';

import { fromRecord, toRecord } from './pendingTerminalConnect.shared';

describe('pending Terminal stored descriptor', () => {
    it('projects retained descriptor fields while keeping new requests strict and identity-bound', () => {
        const now = Date.now();
        const descriptor = {
            v: 1 as const, homeServerIdentityId: 'srv_pending_home',
            canonicalServerUrl: 'https://pending-home.example.test', revision: 7,
            endpoints: [{ kind: 'https' as const, url: 'https://pending-home.example.test' }],
        };
        const retained = {
            publicKeyB64Url: 'key', serverUrl: descriptor.canonicalServerUrl,
            serverIdentityId: descriptor.homeServerIdentityId,
            pairing: { secretB64Url: 'secret', createdAtMs: now, expiresAtMs: now + 60_000 },
            homeConnectionDescriptor: { ...descriptor, retiredDescriptorField: true,
                endpoints: [{ ...descriptor.endpoints[0], retiredEndpointField: true }] },
            createdAtMs: now,
        };
        expect(fromRecord(retained)?.homeConnectionDescriptor).toEqual(descriptor);
        expect(toRecord(retained, now)).toBeNull();
        expect(fromRecord({ ...retained, serverIdentityId: 'srv_other_home' })).toBeNull();
    });
});
