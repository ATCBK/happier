import { expect, it, vi } from 'vitest';

import { createSocketIoBoundaryStub } from './socketIo';

it('delivers timed acknowledgements through the currently installed daemon responder', async () => {
    const { socket } = createSocketIoBoundaryStub();
    socket.emitWithAck = vi.fn(async () => ({ v: 1, ok: false, admittedSessionIds: [] }));

    await expect(socket.timeout(100).emitWithAck('rpc-call', { method: 'machine:probe', params: {} }))
        .resolves.toMatchObject({ ok: false });
});
