import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

const Id = lazyZodSchema(() => z.string().check(z.minLength(1)));
const Count = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative(), z.int()));
/** Native names stay transient; retained evidence contains catalog ids and numbers. */
export const UsageMcpBindingIdentitySchema = lazyZodSchema(() => z.strictObject({
    serverId: Id, bindingId: Id,
    /** Entry updatedAt values, distinct from the catalog row's mutation revision. */
    serverRevision: Count, bindingRevision: Count,
    /** Exact catalog row CAS observed when the host materialized this binding. */
    catalogRevision: Count,
}));
export type UsageMcpBindingIdentity = z.infer<typeof UsageMcpBindingIdentitySchema>;
export const UsageMcpBindingUsageSchema = lazyZodSchema(() => z.strictObject({
    v: z.literal(1), evidenceId: Id, sessionId: Id, turnId: Id, observedAtMs: Count,
    window: z.strictObject({ startMs: Count, endMs: Count }),
    coverage: z.enum(['complete', 'partial']),
    bindings: z.array((<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(UsageMcpBindingIdentitySchema, { toolCallCount: Count, schemaBytes: z.nullable(Count),
        /** Absent means the producer did not observe native definition loading. */
        definitionsLoading: z.optional(z.enum(['upfront', 'deferred', 'unknown'])),
        /** Measured definition tokens actually occupying this native context, not deferred catalog size. */
        schemaTokens: z.optional(z.nullable(Count)), contextWindowTokens: z.optional(z.nullable(Count)),
    }))),
}).check(z.superRefine((value, context) => {
    if (value.window.startMs > value.window.endMs || value.window.endMs !== value.observedAtMs) {
        context.addIssue({ code: 'custom', path: ['window'], message: 'Usage must identify its complete observed window' });
    }
    if (new Set(value.bindings.map(row => row.bindingId)).size !== value.bindings.length) {
        context.addIssue({ code: 'custom', path: ['bindings'], message: 'Binding usage identities must be unique' });
    }
    if (new Set(value.bindings.map(row => row.catalogRevision)).size > 1) {
        context.addIssue({ code: 'custom', path: ['bindings'], message: 'One invocation observes one catalog row revision' });
    }
})));
export type UsageMcpBindingUsage = z.infer<typeof UsageMcpBindingUsageSchema>;
