import { describe, expect, it } from 'vitest';
import { createDeferred } from './deferred';

describe('createDeferred', () => {
    it('resolves and rejects the exposed promise pair', async () => {
        const deferred = createDeferred<number>();

        deferred.resolve(42);

        await expect(deferred.promise).resolves.toBe(42);

        const rejected = createDeferred<number>();
        const failure = new Error('fixture failure');
        rejected.reject(failure);
        await expect(rejected.promise).rejects.toBe(failure);
    });
});
