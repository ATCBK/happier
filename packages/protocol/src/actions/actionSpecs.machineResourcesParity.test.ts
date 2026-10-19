import { describe, expect, it } from 'vitest';

import { collectUiActionParity } from '../../../../scripts/testing/lib/uiActionParity.ts';
import { listActionSpecs } from './actionSpecs.js';

describe('machine resources UI intent completeness (AGW-1)', () => {
  it('reports an unmapped intent through the real resource adapter argument position', () => {
    const report = collectUiActionParity([{
      filePath: 'apps/ui/sources/sync/domains/machines/storage/machineRpc.ts',
      content: `
        function execute(input: MachineStorageReadInput, actionId: MachineStorageActionId) {
          return actionExecute(actionId, input);
        }
        execute(input, 'machines.storage.unmappedIntent');
      `,
    }, {
      filePath: 'apps/ui/sources/sync/domains/machines/processes/machineProcessesActions.ts',
      content: `export function executeMachineProcessesActionV1<Id extends MachineProcessesActionId>(actionId: Id, input: unknown) {
        return invoke(actionId, input);
      }`,
    }, {
      filePath: 'apps/ui/sources/components/machines/processes/Example.tsx',
      content: `import { executeMachineProcessesActionV1 as perform } from '@/sync/domains/machines/processes/machineProcessesActions';
        perform('machines.processes.unmappedIntent', {});`,
    }], listActionSpecs(), []);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'unregistered_action', operation: 'machines.storage.unmappedIntent' }),
      expect.objectContaining({ code: 'unregistered_action', operation: 'machines.processes.unmappedIntent' }),
    ]);
  });

});
