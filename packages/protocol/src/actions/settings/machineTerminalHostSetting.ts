import { z } from 'zod';
import { ACCOUNT_SETTING_DEFINITIONS } from '../../account/settings/accountSettings.js';
import { buildMachineTerminalSettingsPatch, resolveTerminalHost } from './accountSettingBindings.js';

export const MachineTerminalHostSettingKeySchema = z.string().trim().min(1)
  .refine((value) => value !== '__proto__', { message: 'Prototype setter keys are not valid machine ids' });
export const MachineTerminalHostSettingChangeSchema = z.object({
  host: z.enum(['none', 'tmux', 'zellij', 'herdr']).nullable().optional(),
  tmux: z.object({
    sessionName: z.string().optional(),
    isolated: z.boolean().optional(),
    tmpDir: z.string().nullable().optional(),
  }).strict().refine(value => Object.keys(value).length > 0).optional(),
}).strict().refine(value => Object.keys(value).length > 0);

export function readMachineTerminalHostSetting(settings: Parameters<typeof resolveTerminalHost>[0]['settings'], machineId: string) {
  const override = Object.hasOwn(settings.sessionTmuxByMachineId, machineId) ? settings.sessionTmuxByMachineId[machineId] : undefined;
  const explicitHost = Object.hasOwn(settings.sessionTerminalHostByMachineId, machineId) ? settings.sessionTerminalHostByMachineId[machineId] : undefined;
  return {
    host: override || explicitHost ? resolveTerminalHost({ settings, machineId }) : null,
    tmux: override ? { sessionName: override.sessionName, isolated: override.isolated, tmpDir: override.tmpDir } : null,
  };
}

export function buildMachineTerminalHostSettingMutation(settings: Parameters<typeof buildMachineTerminalSettingsPatch>[0]['settings'], machineId: string, value: unknown) {
  const key = MachineTerminalHostSettingKeySchema.safeParse(machineId);
  const change = MachineTerminalHostSettingChangeSchema.safeParse(value);
  if (!key.success || !change.success) return null;
  const patch = buildMachineTerminalSettingsPatch({ settings, machineId: key.data, change: change.data });
  const tmux = ACCOUNT_SETTING_DEFINITIONS.sessionTmuxByMachineId.parseMutationValue(patch.sessionTmuxByMachineId);
  const hosts = ACCOUNT_SETTING_DEFINITIONS.sessionTerminalHostByMachineId.parseMutationValue(patch.sessionTerminalHostByMachineId);
  if (!tmux.success || !hosts.success) return null;
  return { sessionTmuxByMachineId: tmux.data, sessionTerminalHostByMachineId: hosts.data };
}
