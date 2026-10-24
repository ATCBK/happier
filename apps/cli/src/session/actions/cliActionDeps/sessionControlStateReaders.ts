import {
  LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  LEGACY_ACP_SESSION_MODES_STATE_KEY,
  SESSION_MODELS_STATE_KEY,
  SESSION_MODES_STATE_KEY,
  readMetadataAliasValue,
} from '@happier-dev/agents/session/controls/metadataKeys';

export function readSessionModesState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readMetadataAliasValue(
    metadata,
    SESSION_MODES_STATE_KEY,
    LEGACY_ACP_SESSION_MODES_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModes?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
  }> | null;
}

export function readSessionModelsState(metadata: Record<string, unknown> | null): Readonly<{
  provider?: string;
  availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
}> | null {
  if (!metadata) return null;
  return readMetadataAliasValue(
    metadata,
    SESSION_MODELS_STATE_KEY,
    LEGACY_ACP_SESSION_MODELS_STATE_KEY,
  ) as Readonly<{
    provider?: string;
    availableModels?: readonly Readonly<{ id?: string; name?: string; description?: string }>[];
  }> | null;
}
