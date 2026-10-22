import { PROMPT_LIBRARY_ROWS_ROUTE_V1, PromptLibraryCatalogKeyV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';

/** Persisted, empty Voice prompt catalog at the Home HTTP boundary. */
export function answerVoiceRealtimePreparationHttpRequest(
    input: URL | RequestInfo,
    settings: unknown,
): Response | null {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/features') return Response.json({ features: {}, capabilities: {} });
    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: settings } });
    if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
    if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows:
        PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1,
            content: key === 'voice' ? { t: 'plain', v: { key, value: { v: 1, scope: { kind: 'voice' }, entries: [] } } } : null,
        })),
    });
    return null;
}
