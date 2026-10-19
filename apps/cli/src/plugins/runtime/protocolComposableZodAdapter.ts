import { z } from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from '@happier-dev/protocol/json/storedReadSchema';
import { createProtocolStoredReadSchema, isProtocolComposableSchema } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';

type HostProtocolSchema<TValue> = Readonly<{
    safeParse(value: unknown):
        | Readonly<{ success: true; data: TValue }>
        | Readonly<{ success: false }>;
}>;

/**
 * CLI-private bridge for host grammars that still compose with Zod.
 * Parsing and normalization remain owned by the public validator-neutral
 * Protocol value; this adapter adds no second schema semantics.
 */
function composeHostProtocolZod<TValue>(schema: HostProtocolSchema<TValue>): z.ZodMiniType<TValue> {
    return z.pipe(z.unknown(), z.transform((value, context): TValue => {
        const parsed = schema.safeParse(value);
        if (parsed.success) return parsed.data;
        context.issues.push({
            code: "custom",
            message: 'Value does not match the canonical Protocol schema.', input: context.value });
        return z.NEVER as TValue;
    }));
}

export function asHostProtocolZod<TValue>(schema: HostProtocolSchema<TValue>): z.ZodMiniType<TValue> {
    return defineStoredReadProjection(composeHostProtocolZod(schema), () => {
        const stored = isProtocolComposableSchema<unknown, TValue>(schema)
            ? createProtocolStoredReadSchema(schema)
            : schema instanceof z.core.$ZodType
                ? createStoredReadSchema(schema)
                : schema;
        return composeHostProtocolZod(stored);
    });
}
