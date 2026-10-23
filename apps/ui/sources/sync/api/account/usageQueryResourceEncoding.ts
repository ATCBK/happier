import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

/** Native JSON/UTF-8 encoding keeps one changed Resource off a per-scalar JS path. */
export function encodeUsageQueryResource(value: UsageQueryBatchResult) {
    return { bytes: new TextEncoder().encode(JSON.stringify(value)) };
}
