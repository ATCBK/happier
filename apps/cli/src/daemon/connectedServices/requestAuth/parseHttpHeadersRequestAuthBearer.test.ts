import type { ConnectedAccountMaterialization } from '@happier-dev/plugin-sdk/connected-accounts';
import { describe, expect, it } from 'vitest';

import { parseHttpHeadersRequestAuthBearer } from './parseHttpHeadersRequestAuthBearer';

const request = {
    kind: 'httpHeaders',
    origin: 'https://chatgpt.com',
    headerNames: ['authorization', 'chatgpt-account-id'],
} as const;

describe('parseHttpHeadersRequestAuthBearer', () => {
    it('projects credential headers without forwarding declared usage metadata', () => {
        const material = {
            kind: 'httpHeaders',
            usageAccountScope: 'workspace',
            headers: { authorization: 'Bearer fixture-access', 'chatgpt-account-id': 'fixture-account' },
        } satisfies ConnectedAccountMaterialization;

        expect(parseHttpHeadersRequestAuthBearer(request, material)).toEqual({
            accessToken: 'fixture-access',
            requiredHeaders: { 'chatgpt-account-id': 'fixture-account' },
        });
    });

    it.each([
        { usageAccountScope: 'unsupported' },
        { unrecognizedMetadata: 'workspace' },
    ])('refuses malformed or undeclared metadata %#', (metadata) => {
        expect(() => parseHttpHeadersRequestAuthBearer(request, {
            kind: 'httpHeaders',
            headers: { authorization: 'Bearer fixture-access' },
            ...metadata,
        })).toThrow(expect.objectContaining({ code: 'request_auth_credential_unavailable',
            diagnostic: { causeCode: 'request_auth_materialization_invalid' } }));
    });
});
