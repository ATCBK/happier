import { describe, expect, it } from 'vitest';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/protocol/plugins/actions/protocol-composable-schema';
import { asHostProtocolZod } from './protocolComposableZodAdapter';

describe('host Protocol stored composition', () => {
    it('normalizes nested neutral stored fields while preserving canonical input rejection', () => {
        const definition = defineProtocolObject({ detail: defineProtocolObject({ name: defineProtocolString() }, { policy: 'closed' }) }, { policy: 'closed' });
        const admission = z.strictObject({ value: asHostProtocolZod(definition) });
        const stored = { value: { detail: { name: 'retained', retired: true }, retired: true }, retired: true };
        expect(admission.safeParse(stored).success).toBe(false);
        expect(createStoredReadSchema(admission).parse(stored)).toEqual({ value: { detail: { name: 'retained' } } });
        expect(createStoredReadSchema(admission).safeParse({ value: { detail: { name: 4 } } }).success).toBe(false);
    });
});
