import { createBackgroundServiceProcessFrameDecoder, encodeBackgroundServiceProcessFrame,
    parseBackgroundServiceProcessMessage, type BackgroundServiceProcessMessage } from './backgroundServiceProcessProtocol';
import type { BackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';
import type { TerminationEvent } from '@/subprocess/supervision/types';

/** OS pipe/process boundary; framing, execution, services and lifecycle remain real. */
export function channelBoundary(ready = true) {
    const messages: BackgroundServiceProcessMessage[] = [];
    const listeners: ((chunk: Buffer) => void)[] = [];
    const decoder = createBackgroundServiceProcessFrameDecoder();
    let finish!: (event: TerminationEvent) => void;
    const termination = new Promise<TerminationEvent>(resolve => { finish = resolve; });
    let terminated = false;
    const emit = (message: BackgroundServiceProcessMessage) => {
        const frame = encodeBackgroundServiceProcessFrame(message);
        for (const listener of listeners) {
            listener(frame.subarray(0, 3));
            listener(frame.subarray(3));
        }
    };
    const channel: BackgroundServiceProcessChannel = {
        pid: 43123,
        send(frame) {
            for (const value of decoder.push(frame)) {
                const message = parseBackgroundServiceProcessMessage(value);
                messages.push(message);
                if (message.kind === 'initialize' && ready) emit({ kind: 'ready', pid: 43123 });
            }
        },
        onData(listener) { listeners.push(listener); },
        waitForTermination: () => termination,
        async close() { finish({ type: 'exited', code: 0 }); },
        async terminate() { terminated = true; finish({ type: 'signaled', signal: 'SIGTERM' }); },
    };
    return { channel, messages, emit, finish, get terminated() { return terminated; } };
}
