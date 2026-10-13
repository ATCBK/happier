import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { SKILL_MACHINE_ACTION_INPUT_SCHEMAS_V1 as inputs } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import type { createMachineSkillActions } from './machineSkillActions';

/** Admitted Action effects retain filesystem acknowledgements independently of their Account row receipt. */
export function createMachineSkillActionExecutor(input: Readonly<{
  machineId: string; service: ReturnType<typeof createMachineSkillActions>;
}>): NonNullable<ActionExecutorDeps['skillMachineActionExecute']> {
  return async request => {
    const parsed = inputs[request.actionId].parse(request.input);
    if (parsed.machineId !== input.machineId) return { ok: false, errorCode: 'machine_target_mismatch', error: 'machine_target_mismatch' };
    const signal = request.context.signal;
    try {
      if (request.actionId === 'skills.found.list') {
        const found = inputs[request.actionId].parse(request.input);
        return await input.service.found({ directory: found.directory, signal });
      }
      if (request.actionId === 'skills.machine.install') {
        const install = inputs[request.actionId].parse(request.input);
        const result = await input.service.install({ ...install, signal });
        const receipts = result.results.flatMap(item => item.digest && ['installed', 'refreshed', 'unchanged'].includes(item.status)
          ? [{ root: item.root, path: item.path, digest: item.digest }] : []);
        const failure = result.results.find(item => !['installed', 'refreshed', 'unchanged'].includes(item.status));
        const code = failure?.errorCode ?? failure?.status
          ?? (result.row.status === 'conflict' ? 'conflict' : result.row.status === 'unavailable' ? 'receipt_unavailable' : null);
        return code ? { ok: false, errorCode: code, error: code, details: { receipts } } : { receipts };
      }
      if (request.actionId === 'skills.machine.uninstall') {
        const uninstall = inputs[request.actionId].parse(request.input);
        const result = await input.service.uninstall({ ...uninstall, signal });
        const removed = result.results.filter(item => item.status === 'removed').map(item => item.path);
        const failure = result.results.find(item => item.status !== 'removed');
        const code = failure?.errorCode ?? failure?.status
          ?? (result.row.status === 'conflict' ? 'conflict' : result.row.status === 'unavailable' ? 'receipt_unavailable' : null);
        return code ? { ok: false, errorCode: code, error: code, details: { removed } } : { removed };
      }
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    } catch (error) {
      const code: unknown = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
      const errorCode = typeof code === 'string' ? code : 'skill_install_unavailable';
      return { ok: false, errorCode, error: errorCode };
    }
  };
}
