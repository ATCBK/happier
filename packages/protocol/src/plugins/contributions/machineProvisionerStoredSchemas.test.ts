import { expect, it } from 'vitest';

import { createProtocolComposableSchema, defineProtocolObject, defineProtocolString } from '../actions/protocolComposableSchema.js';
import { prepareMachineProvisionerStoredSchemas } from './machineProvisionerStoredSchemas.js';

it('retains native general JSON Schema projections outside the exact DSL grammar', async () => {
  const base = defineProtocolObject({ name: defineProtocolString({ minLength: 1 }) }, { policy: 'closed' });
  const native = createProtocolComposableSchema({ allOf: [base.jsonSchema] }, value => base.safeParse(value));
  const stored = await prepareMachineProvisionerStoredSchemas({ launch: native, resource: native });
  expect(stored.launchStored.parse({ name: 'guest', retired: true })).toEqual({ name: 'guest' });
  expect(stored.resourceStored.safeParse({ name: 7 }).success).toBe(false);
  expect(native.safeParse({ name: 'guest', retired: true }).success).toBe(false);
});
