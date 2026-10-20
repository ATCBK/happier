import {
    PluginUiDestinationReferenceV1Schema,
    type PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginUiInstanceKeyV1Schema,
    type PluginUiInstanceKeyV1,
} from '@happier-dev/protocol/plugins/ui/semanticCommands';
import { z } from 'zod/mini';

/**
 * The durable selection identity for an AppPane slot.
 *
 * It deliberately carries only the host's built-in id or the Protocol-owned
 * qualified plugin destination plus an optional opaque instance key. Launch
 * input, projection generation, artifact identity and stamped runtime target
 * are current mount facts; persisting any of them would let stale authority
 * cross restoration.
 */
export type SelectedPaneDestinationV1 =
    | Readonly<{ kind: 'builtin'; id: string }>
    | Readonly<{
        kind: 'plugin';
        destination: PluginUiDestinationReferenceV1;
        instanceKey?: PluginUiInstanceKeyV1;
    }>;

const PaneBuiltinDestinationIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

/**
 * Zod persistence adapter over the Protocol-owned composable schema. It
 * delegates parsing and normalization to Protocol; AppPane owns only the
 * containing local-storage shape.
 */
export const PersistedPluginUiDestinationReferenceV1Schema = z.pipe(z.unknown(), z.transform((value, context) => {
    const parsed = PluginUiDestinationReferenceV1Schema.safeParse(value);
    if (parsed.success) return parsed.data;
    context.issues.push({ code: 'custom', message: 'Invalid plugin UI destination reference', input: context.value });
    return z.NEVER;
}));

export const SelectedPaneDestinationV1Schema = z.discriminatedUnion('kind', [
    z.strictObject({
        kind: z.literal('builtin'),
        id: PaneBuiltinDestinationIdSchema,
    }),
    z.strictObject({
        kind: z.literal('plugin'),
        destination: PersistedPluginUiDestinationReferenceV1Schema,
        instanceKey: z.optional(PluginUiInstanceKeyV1Schema),
    }),
]);

export function createBuiltinPaneDestination(id: string): SelectedPaneDestinationV1 {
    return Object.freeze({ kind: 'builtin', id });
}

export function areSelectedPaneDestinationsEqual(
    left: SelectedPaneDestinationV1 | null,
    right: SelectedPaneDestinationV1 | null,
): boolean {
    if (left === right) return true;
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'builtin' && right.kind === 'builtin') {
        return left.id === right.id;
    }
    if (left.kind === 'plugin' && right.kind === 'plugin') {
        return left.destination.pluginId === right.destination.pluginId
            && left.destination.localId === right.destination.localId
            && left.instanceKey === right.instanceKey;
    }
    return false;
}
