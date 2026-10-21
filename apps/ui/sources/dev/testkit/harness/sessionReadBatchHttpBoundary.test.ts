import { expect, it } from 'vitest';
import { SessionReadBatchResponseV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';

import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createSessionMetadataHttpBoundary } from './sessionMetadataHttpBoundary';
import { createSessionReadBatchFetchBoundary } from './sessionReadBatchHttpBoundary';

it('serves one canonical Session snapshot and its declared turn projection through the batch wire', async () => {
    const session = createSessionFixture({ id: 'voice-carrier', sessionTurns: {
        v: 1, sessionId: 'voice-carrier', updatedAt: 7, turns: [],
    } });
    const metadata = createSessionMetadataHttpBoundary(() => ({ [session.id]: session }));
    const request = createSessionReadBatchFetchBoundary(async (url, init) => metadata.handle(url, init));
    const response = await request('https://voice.test/v2/sessions/read-batch', {
        method: 'POST', body: JSON.stringify({ sessionIds: [session.id], includeSnapshot: true, includeMessages: false }),
    });
    if (!response) throw new Error('Missing batch response');
    const body = SessionReadBatchResponseV1Schema.parse(await response.json());
    expect(body.results).toMatchObject([{
        sessionId: session.id, detail: { status: 200, body: { session: { id: session.id } } },
        turns: { status: 200, body: session.sessionTurns },
    }]);
});
