import type { PluginConnectedAccountAuthenticationModeV2 } from '@happier-dev/protocol';

/** The import alias acquires through the provider-declared manual mode. */
export function resolveConnectNativeImportIntent(
  modes: readonly PluginConnectedAccountAuthenticationModeV2[],
  selectedSource: string | null | undefined,
): Readonly<{ modeId: string; fields: Readonly<{ source: string }> }> {
  const mode = modes.find(candidate => candidate.id === 'native-import');
  if (!mode || mode.kind !== 'manual') throw new Error('This service does not declare native credential import.');
  const field = mode.fields.find(candidate => candidate.id === 'source');
  const choices = field?.schema.enum;
  if (mode.fields.length !== 1 || !field || field.secret || field.schema.type !== 'string'
    || !Array.isArray(choices) || choices.length === 0 || !choices.every(choice => typeof choice === 'string' && choice.length > 0)) {
    throw new Error('This service does not declare supported native sources.');
  }
  const source = selectedSource ?? (choices.length === 1 ? choices[0] : null);
  if (typeof source !== 'string' || !choices.includes(source)) {
    throw new Error(`Choose a declared native source with --source (${choices.join(', ')}).`);
  }
  return { modeId: mode.id, fields: { source } };
}
