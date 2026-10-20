import type { ModelPackCatalogEntry } from '@happier-dev/protocol/voice/modelPacks/catalog';

/** Catalog model identifiers share one readable projection across speech pickers. */
export function formatModelPackDisplayName(entry: Pick<ModelPackCatalogEntry, 'packId' | 'model'>): string {
  const source = entry.model.trim().length > 0 ? entry.model : entry.packId;
  const cleaned = source
    .replace(/^sherpa-onnx-/i, '')
    .replace(/[._]/g, '-')
    .split('-')
    .filter((segment) => segment.length > 0)
    .map((segment) => (/^[a-z]/.test(segment) ? segment.charAt(0).toUpperCase() + segment.slice(1) : segment))
    .join(' ');
  return cleaned.length > 0 ? cleaned : source;
}
