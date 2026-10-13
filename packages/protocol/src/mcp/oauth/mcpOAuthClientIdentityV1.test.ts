import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { MCP_OAUTH_CALLBACK_URL_V1, MCP_OAUTH_CLIENT_METADATA_URL_V1 } from './mcpOAuthClientIdentityV1.js';

describe('MCP OAuth client identity', () => {
    it('publishes the native public client metadata at its declared client identity', async () => {
        const asset = new URL('../../../../../apps/ui/public/oauth/mcp/client-metadata.json', import.meta.url);
        const metadata: unknown = JSON.parse(await readFile(asset, 'utf8'));

        expect(metadata).toMatchObject({
            client_id: MCP_OAUTH_CLIENT_METADATA_URL_V1,
            redirect_uris: [MCP_OAUTH_CALLBACK_URL_V1],
            application_type: 'native',
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
        });
        expect(metadata).toHaveProperty('client_name', expect.stringMatching(/\S/));
        expect(metadata).not.toHaveProperty('client_secret');
    });
});
