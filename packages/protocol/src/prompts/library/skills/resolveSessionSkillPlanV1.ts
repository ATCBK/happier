import type { PluginAgentSkillsCapabilityV2 } from '../../../plugins/contributions/v2.js';
import type { CapabilityItemStateV1 } from '../../../reach/resolveSessionCapabilitiesV1.js';
import type { CapabilitySelectionReasonV1 } from '../../../reach/sessionCapabilitySelectionV1.js';
import type { SkillLibraryItemV1 } from './skillLibraryItemV1.js';

export type NativeSkillScanV1 = Readonly<{
  status: 'ok'; names: readonly Readonly<{ name: string; path: string; root: string }>[];
}> | Readonly<{
  status: 'failed'; roots: readonly string[]; names: readonly Readonly<{ name: string; path: string; root: string }>[];
}>;
export type SessionSkillPlanV1 = {
  plan: 'session_dir' | 'index' | 'none';
  items: { skillId: string; name: string; digest: string;
    state: 'delivered' | 'masked_by_native' | 'off' | 'excluded' | 'name_conflict' | 'unavailable';
    reason: CapabilitySelectionReasonV1 | 'native_same_name' | 'duplicate_name' | 'content_unreadable' | 'materialize_failed' | 'native_scan_failed';
    maskedBy?: { path: string } }[];
  nativeDisables: { name: string; path: string; state: 'applied' | 'unsupported' }[];
  diagnostics: { kind: 'native_scan_failed'; root: string }[];
};
export function resolveSkillPlanKindV1(_input: {
  agentSkills: PluginAgentSkillsCapabilityV2 | null; agentHasActionChannel: boolean;
}): SessionSkillPlanV1['plan'] { return 'none'; }

export function resolveSessionSkillPlanV1(_input: {
  items: readonly SkillLibraryItemV1[]; selected: readonly CapabilityItemStateV1[];
  excludeNativeSkillNames: readonly string[]; agentSkills: PluginAgentSkillsCapabilityV2 | null;
  agentHasActionChannel: boolean; nativeSkills: NativeSkillScanV1;
}): SessionSkillPlanV1 {
  return { plan: 'none', items: [], nativeDisables: [], diagnostics: [] };
}
