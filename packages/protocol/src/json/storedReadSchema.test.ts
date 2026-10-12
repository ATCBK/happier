import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as m from 'zod/mini';
import { createStoredReadSchema, defineStoredReadProjection } from './storedReadSchema.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { createPluginJsonSchemaZodValueAdapter } from '../plugins/actions/jsonSchemaValidation.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

describe('stored JSON schema derivation', () => {
    it('retains a registered lazy hidden-parser projection under optional array composition without eager construction', () => {
        let constructions = 0;
        const shape = z.object({ value: z.string().min(1) }).strict();
        const canonical = defineStoredReadProjection(lazyZodSchema(() => {
            constructions++;
            return z.string().transform(value => shape.parse(JSON.parse(value)));
        }), () => z.string().transform(value => createStoredReadSchema(shape).parse(JSON.parse(value))));
        const parent = z.object({ items: z.array(canonical.optional()) }).strict();
        const stored = createStoredReadSchema(parent);
        expect(stored.parse({ items: [] })).toEqual({ items: [] });
        expect(constructions).toBe(0);
        expect(stored.parse({ items: ['{"value":"kept","retired":true}'] }))
            .toEqual({ items: [{ value: 'kept' }] });
        expect(() => parent.parse({ items: ['{"value":"kept","retired":true}'] })).toThrow();
        expect(() => stored.parse({ items: ['{"value":"","retired":true}'] })).toThrow();
        expect(constructions).toBe(1);
    });

    it('preserves declared propertyless JSON bags while projecting surrounding stored object fields', () => {
        const schema = createPluginJsonSchemaZodValueAdapter({ type: 'object', properties: {
            explicit: { type: 'object', additionalProperties: true }, implicit: { type: 'object' },
            explicitEmpty: { type: 'object', properties: {}, additionalProperties: true },
            implicitEmpty: { type: 'object', properties: {} },
            closedEmpty: { type: 'object', properties: {}, additionalProperties: false },
        }, required: ['explicit', 'implicit', 'explicitEmpty', 'implicitEmpty', 'closedEmpty'], additionalProperties: false });
        const values = { explicit: { arbitrary: { kept: true } }, implicit: { other: ['kept'] },
            explicitEmpty: { arbitrary: { kept: true } }, implicitEmpty: { other: ['kept'] }, closedEmpty: {} };
        expect(createStoredReadSchema(schema).parse({ ...values, retired: true, closedEmpty: { retired: true } })).toEqual(values);
        expect(schema.safeParse({ ...values, retired: true }).success).toBe(false);
        expect(schema.safeParse({ ...values, closedEmpty: { retired: true } }).success).toBe(false);
    });
    it('does not interpret Object prototype members as declared stored fields', () => {
        const schema = createPluginJsonSchemaZodValueAdapter({ type: 'object', properties: { name: { type: 'string' } },
            required: ['name'], additionalProperties: false });
        const annotated = { name: 'kept', constructor: {}, toString: {} };
        expect(createStoredReadSchema(schema).parse(annotated)).toEqual({ name: 'kept' });
        expect(schema.safeParse(annotated).success).toBe(false);
    });
    it('retains prototype-spelled keys when a declared JSON map owns their values', () => {
        const schema = createPluginJsonSchemaZodValueAdapter({ type: 'object', additionalProperties: {
            type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false,
        } });
        const canonical = JSON.parse('{"__proto__":{"label":"kept"},"constructor":{"label":"other"}}');
        expect(schema.parse(canonical)).toEqual(canonical);
        const annotated = JSON.parse('{"__proto__":{"label":"kept","retired":true},"constructor":{"label":"other","retired":true}}');
        const read = createStoredReadSchema(schema).parse(annotated);
        expect(read).toEqual(canonical);
        expect(Object.hasOwn(read, '__proto__')).toBe(true);
        expect(schema.safeParse(annotated).success).toBe(false);
    });
    it('preserves native default factories and independent mutable default values', () => {
        let generated = 0;
        const stored = createStoredReadSchema(z.object({
            id: z.string().default(() => String(++generated)),
            values: z.array(z.string()).default([]),
        }).strict());
        expect(stored.parse({ id: 'present', values: ['kept'] })).toEqual({ id: 'present', values: ['kept'] });
        expect(generated).toBe(0);
        const first = stored.parse({});
        const second = stored.parse({});
        expect(first.id).toBe('1');
        expect(second.id).toBe('2');
        first.values.push('changed');
        expect(second.values).toEqual([]);
        expect(stored.safeParse({ id: 123 }).success).toBe(false);
    });
    it('admits only present defaulted fields when projecting a stored object', () => {
        let firstConstructions = 0;
        let secondConstructions = 0;
        const first = lazyZodSchema(() => {
            firstConstructions++;
            return z.object({ value: z.string().min(1) }).strict();
        });
        const second = lazyZodSchema(() => {
            secondConstructions++;
            return z.object({ value: z.string().min(1) }).strict();
        });
        const canonical = z.object({
            first: first.default({ value: 'first' }),
            second: second.default({ value: 'second' }),
        }).strict();
        const stored = createStoredReadSchema(canonical);
        expect(stored.parse({})).toEqual({ first: { value: 'first' }, second: { value: 'second' } });
        expect([firstConstructions, secondConstructions]).toEqual([0, 0]);
        expect(stored.parse({ first: { value: 'kept', extra: true } })).toEqual({
            first: { value: 'kept' }, second: { value: 'second' },
        });
        expect([firstConstructions, secondConstructions]).toEqual([1, 0]);
        expect(stored.safeParse({ first: { value: '' } }).success).toBe(false);
        expect(canonical.safeParse({ first: { value: 'kept', extra: true } }).success).toBe(false);
    });
    it('keeps composed Classic read projections cold until present data needs admission', () => {
        let canonicalConstructions = 0;
        const canonical = lazyZodSchema(() => {
            canonicalConstructions++;
            return z.object({ value: z.string().trim().min(1) }).strict();
        });
        const stored = createStoredReadSchema(canonical);
        const optional = stored.optional();
        const repeated = stored.array();
        const parent = z.object({ item: optional.default({ value: 'fallback' }) }).strict();
        expect(parent.parse({})).toEqual({ item: { value: 'fallback' } });
        expect(canonicalConstructions).toBe(0);

        expect(repeated.parse([{ value: ' kept ', extra: true }])).toEqual([{ value: 'kept' }]);
        expect(parent.safeParse({ item: { value: '' } }).success).toBe(false);
        expect(canonical.safeParse({ value: 'kept', extra: true }).success).toBe(false);
        expect(canonicalConstructions).toBe(1);
        expect(createStoredReadSchema(canonical)).toBe(stored);

        const concreteRead = z.object({ value: z.string().trim().min(1) }).strip();
        const projected = z.object({ first: stored, optional, repeated });
        const expected = z.object({ first: concreteRead, optional: concreteRead.optional(), repeated: concreteRead.array() });
        for (const target of ['draft-7', 'draft-2020-12'] as const) {
            for (const io of ['input', 'output'] as const) {
                expect(z.toJSONSchema(projected, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
            }
        }
    });
    it('drops passthrough object extras but preserves declared map data', () => {
        const input = z.object({ fields: z.record(z.string(), z.unknown()) }).passthrough();
        expect(createStoredReadSchema(input).parse({ fields: { arbitrary: { retained: true } }, extra: true }))
            .toEqual({ fields: { arbitrary: { retained: true } } });
    });
    it('drops nested object extras without weakening required fields, refinements or inputs', () => {
        const input = z.object({
            ref: asProtocolZod(PluginContributionIdentityV1Schema),
            entries: z.record(z.string(), z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('value'), value: z.unknown() }).strict(),
                z.object({ kind: z.literal('context'), slot: z.string().min(1) }).strict(),
            ])),
        }).strict().refine(value => Object.keys(value.entries).length > 0);
        const stored = createStoredReadSchema(input);
        const canonical = { ref: { pluginId: 'happier.checks', localId: 'summary' }, entries: {
            first: { kind: 'context', slot: 'session' }, second: { kind: 'value', value: { arbitrary: 1 } },
        } };
        const raw = { ...canonical, savedBy: 'stray', ref: { ...canonical.ref, extra: true }, entries: {
            ...canonical.entries, first: { ...canonical.entries.first, extra: true },
        } };
        expect(stored.parse(raw)).toEqual(canonical);
        expect(raw).toHaveProperty('savedBy', 'stray');
        expect(input.safeParse(raw).success).toBe(false);
        expect(stored.safeParse({ ...raw, ref: { pluginId: 'happier.checks', extra: true } }).success).toBe(false);
        expect(stored.safeParse({ ...raw, entries: {} }).success).toBe(false);
    });
});

it('constructs a captured custom reader on demand without weakening admission', () => {
    const canonical = z.object({ value: z.string().trim().min(1) }).strict()
        .refine(value => value.value !== 'forbidden');
    let readProjectionReady = false;
    defineStoredReadProjection(canonical, () => {
        readProjectionReady = true;
        return canonical.strip();
    });

    const stored = createStoredReadSchema(canonical);
    expect(readProjectionReady).toBe(false);
    expect(createStoredReadSchema(canonical)).toBe(stored);

    // A later registration cannot replace the read contract already selected.
    defineStoredReadProjection(canonical, () => z.object({ value: z.literal('late') }).strict());
    const raw = { value: ' kept ', extra: true };
    expect(canonical.safeParse(raw).success).toBe(false);
    expect(stored.parse(raw)).toEqual({ value: 'kept' });
    expect(readProjectionReady).toBe(true);
    expect(createStoredReadSchema(canonical)).toBe(stored);
    expect(() => stored.parse({ value: 'forbidden' })).toThrow(z.ZodError);
    const refused = stored.safeParse({ value: 'forbidden' });
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.issues).toMatchObject([{ code: 'custom', path: [] }]);
});

it('projects deferred Classic, Mini and Core readers with their concrete reference identity', () => {
    const classic = z.object({ value: z.string().min(1) }).strict();
    const classicRead = classic.strip().describe('Classic read');
    const mini = m.strictObject({ value: m.string().check(m.minLength(1)) });
    const miniRead = m.object({ value: m.string().check(m.minLength(1)) })
        .register(z.globalRegistry, { id: 'StoredReadMiniProjection', title: 'Mini read' });
    const classicWithMiniRead = z.object({ value: z.string().min(1) }).strict();
    defineStoredReadProjection(classicWithMiniRead, () => miniRead);
    const crossClassRead = createStoredReadSchema(classicWithMiniRead);
    expect(Reflect.get(crossClassRead, 'optional')).toBeUndefined();
    expect(z.core.parse(crossClassRead, { value: 'kept', extra: true })).toEqual({ value: 'kept' });
    const core = new z.core.$ZodObject({
        type: 'object',
        shape: { value: new z.core.$ZodString({ type: 'string', checks: [] }) },
        catchall: new z.core.$ZodNever({ type: 'never' }),
    });
    const coreRead = new z.core.$ZodObject({
        type: 'object',
        shape: { value: new z.core.$ZodString({ type: 'string', checks: [] }) },
    });
    z.globalRegistry.add(coreRead, { title: 'Core read' });

    for (const [canonical, concreteRead] of [[classic, classicRead], [mini, miniRead], [core, coreRead]] as const) {
        defineStoredReadProjection(canonical, () => concreteRead);
        const stored = createStoredReadSchema(canonical);
        expect(createStoredReadSchema(canonical)).toBe(stored);
        const actual = z.object({ first: stored, second: stored, repeated: z.array(stored) });
        const expected = z.object({ first: concreteRead, second: concreteRead, repeated: z.array(concreteRead) });
        for (const target of ['draft-7', 'draft-2020-12'] as const) {
            for (const io of ['input', 'output'] as const) {
                expect(z.toJSONSchema(actual, { target, io })).toEqual(z.toJSONSchema(expected, { target, io }));
            }
        }
        const raw = { value: 'kept', extra: true };
        expect(z.core.parse(stored, raw)).toEqual(z.core.parse(concreteRead, raw));
        const refused = z.core.safeParse(stored, { value: 42 });
        const expectedRefusal = z.core.safeParse(concreteRead, { value: 42 });
        expect(refused.success).toBe(false);
        if (!refused.success && !expectedRefusal.success) {
            expect(refused.error.constructor).toBe(expectedRefusal.error.constructor);
            expect(refused.error.issues).toEqual(expectedRefusal.error.issues);
        }
        if (canonical !== classic) expect(Reflect.get(stored, 'optional')).toBeUndefined();
    }

    const atomic = z.string().min(1).describe('Atomic value');
    const structural = z.object({ nested: z.object({ value: atomic.default('fallback') }).strict() }).strict();
    const structuralRead = z.object({ nested: z.object({ value: atomic.default('fallback') }).strip() }).strip();
    for (const [canonical, concreteRead] of [[atomic, atomic], [structural, structuralRead]] as const) {
        const stored = createStoredReadSchema(canonical);
        expect(createStoredReadSchema(canonical)).toBe(stored);
        for (const target of ['draft-7', 'draft-2020-12'] as const) {
            for (const io of ['input', 'output'] as const) {
                expect(z.toJSONSchema(stored, { target, io })).toEqual(z.toJSONSchema(concreteRead, { target, io }));
            }
        }
    }
    expect(createStoredReadSchema(atomic).parse('kept')).toBe('kept');
    expect(createStoredReadSchema(structural).parse({ nested: { extra: true }, extra: true }))
        .toEqual({ nested: { value: 'fallback' } });

    type RecursiveRead = { value: string; next?: RecursiveRead };
    const recursive: z.ZodType<RecursiveRead> = z.lazy(() => z.object({
        value: z.string(), next: recursive.optional(),
    }).strict());
    const recursiveRead: z.ZodType<RecursiveRead> = z.lazy(() => z.object({
        value: z.string(), next: recursiveRead.optional(),
    }).strip());
    for (const target of ['draft-7', 'draft-2020-12'] as const) {
        for (const io of ['input', 'output'] as const) {
            expect(z.toJSONSchema(createStoredReadSchema(recursive), { target, io }))
                .toEqual(z.toJSONSchema(recursiveRead, { target, io }));
        }
    }
    expect(createStoredReadSchema(recursive).parse({ value: 'a', next: { value: 'b', extra: true } }))
        .toEqual({ value: 'a', next: { value: 'b' } });
});
