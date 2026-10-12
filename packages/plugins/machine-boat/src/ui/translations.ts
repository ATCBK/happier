import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk/manifest';
import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';
import type { UiTranslationBundle } from '@happier-dev/plugin-sdk/ui';

const en = {
  kind: 'sandbox',
  description: 'EU-only Boat sandboxes. Running time is billed per second; stopping pauses compute billing. Plans start at $20/month and include the same amount of usage.',
  ready: 'Account connected',
  unavailable: 'Account unavailable',
  compute: 'Running compute',
} as const;

export function boatPresentationLabel(id: keyof typeof en): PluginLocalizedStringV2 {
  return { key: `machineBoat.presentation.${id}`, fallback: en[id] };
}

export function boatCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  return { ...result, status: result.status ?? boatPresentationLabel(result.available ? 'ready' : 'unavailable') };
}

export const BOAT_UI_TRANSLATION_BUNDLES: readonly UiTranslationBundle[] = [{
  locale: 'en',
  messages: Object.fromEntries(Object.entries(en).map(([id, value]) => [`machineBoat.presentation.${id}`, value])),
}];
