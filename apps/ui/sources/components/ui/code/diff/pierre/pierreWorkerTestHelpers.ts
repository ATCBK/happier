// Browser Worker transport boundary for tests using the real Pierre pool manager.
export class BrowserWorker extends EventTarget {
    static instances: BrowserWorker[] = [];
    static successfulConstructionsBeforeFailure: number | undefined;
    static holdInitialization = false;
    static pendingInitializations: Array<() => void> = [];
    terminated = false;

    static reset(): void {
        BrowserWorker.instances = [];
        BrowserWorker.successfulConstructionsBeforeFailure = undefined;
        BrowserWorker.holdInitialization = false;
        BrowserWorker.pendingInitializations = [];
    }

    constructor() {
        super();
        if (BrowserWorker.successfulConstructionsBeforeFailure === 0) throw new Error('worker disabled');
        if (BrowserWorker.successfulConstructionsBeforeFailure !== undefined) BrowserWorker.successfulConstructionsBeforeFailure--;
        BrowserWorker.instances.push(this);
    }

    postMessage(message: unknown): void {
        if (typeof message !== 'object' || message === null || !('id' in message) || !('type' in message)) {
            throw new Error('Expected a Pierre worker request');
        }
        const { id, type } = message;
        if (type !== 'initialize' && type !== 'set-render-options') {
            throw new Error(`Unexpected Pierre worker request: ${String(type)}`);
        }
        const respond = () => {
            if (this.terminated) return;
            this.dispatchEvent(new MessageEvent('message', {
                data: { type: 'success', requestType: type, id, sentAt: Date.now() },
            }));
        };
        if (type === 'initialize' && BrowserWorker.holdInitialization) BrowserWorker.pendingInitializations.push(respond);
        else queueMicrotask(respond);
    }

    terminate(): void {
        this.terminated = true;
    }
}
