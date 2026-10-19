import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { ActionDiscoveryDefinitionV1Schema } from './actionDefinitionV1.js';
import { compileProtocolJsonSchema } from '../plugins/actions/jsonSchemaCompiler.js';
import { SessionStatusActionResultV1Schema } from '../sessions/control/contract.js';
import { projectSessionSummaryV1 } from '../sessions/control/listResult.js';

describe('Session target declaration discovery', () => {
  it('publishes Session targets through real strict discovery and input-schema consumers', () => {
    for (const [id, cardinality, extraInput] of [
      ['session.message.send', 'many', { message: 'Review the change', wait: true }],
      ['session.status.get', 'many', {}],
      ['session.open', 'one', {}],
    ] as const) {
      const spec = getActionSpec(id);
      const input = { sessionId: { selector: 'workers', of: 'manager-id' }, ...extraInput };
      expect(spec.inputSchema.safeParse(input).success, id).toBe(true);
      const discovered = ActionDiscoveryDefinitionV1Schema.parse(actionSpecToActionDefinitionV1(spec));
      expect(discovered).toMatchObject({ sessionTarget: { field: 'sessionId', cardinality } });
      const validate = compileProtocolJsonSchema(discovered.inputSchema, 'draft-07');
      expect(validate(input), id).toBe(true);
      expect(validate({ ...input, sessionId: { selector: 'workers', of: { selector: 'self' } } }), id).toBe(false);
      expect(validate({ ...input, sessionId: { selector: 'workers', unknownRouting: true } }), id).toBe(false);
      expect(spec.inputSchema.safeParse({ ...extraInput, sessionId: 'existing-id' }).success, id).toBe(true);
    }
  });

  it('publishes closed fanout results with each existing send outcome still validated', () => {
    const result = { kind: 'fanout', results: [
      { target: { serverId: 'home', sessionId: 'worker-a' }, result: { ok: true, result: { status: 'accepted', localId: 'input-a' } } },
      { target: { serverId: 'home', sessionId: 'worker-b' }, result: { ok: false, errorCode: 'denied', error: 'denied' } },
    ] };
    for (const surface of [undefined, 'api', 'plugin'] as const) {
      const spec = getActionSpec('session.message.send');
      const definition = actionSpecToActionDefinitionV1(spec, { surface });
      expect(definition.outputSchema).toBeDefined();
      const validate = compileProtocolJsonSchema(definition.outputSchema!, 'draft-07');
      expect(validate(result)).toBe(true);
      expect(validate({ ...result, results: [{ ...result.results[0],
        result: { ok: true, result: { status: 'invented', localId: 'input-a' } },
      }] })).toBe(false);
      expect(validate({ ...result, expandedTargets: true })).toBe(false);
    }
  });

  it('preserves the canonical status result inside strict group discovery output', () => {
    const status = SessionStatusActionResultV1Schema.parse({ session: projectSessionSummaryV1({
      row: { id: 'worker-a', createdAt: 1, updatedAt: 2, active: false, activeAt: 1 },
      metadata: null, encryption: null,
    }) });
    const target = { serverId: 'home', sessionId: 'worker-a' };
    const result = { kind: 'fanout', results: [{ target, result: { ok: true, result: status } }] };
    for (const surface of [undefined, 'api', 'plugin'] as const) {
      const definition = actionSpecToActionDefinitionV1(getActionSpec('session.status.get'), { surface });
      const validate = compileProtocolJsonSchema(definition.outputSchema!, 'draft-07');
      expect(validate(status)).toBe(true);
      expect(validate(result)).toBe(true);
      expect(validate({ ...result, results: [{ target, result: { ok: true, result: {
        session: { id: 'worker-a', createdAt: 'invalid' },
      } } }] })).toBe(false);
      expect(validate({ ...result, expandedTargets: true })).toBe(false);
    }
  });
});
