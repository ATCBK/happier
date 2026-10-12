import type { PluginAccountCollectionMigration } from '@happier-dev/plugin-sdk/collections';

export const GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID = 'automation-event-checkpoints-v1';

export const GITHUB_COLLECTION_MIGRATIONS = {
  [GITHUB_AUTOMATION_EVENT_CHECKPOINT_COLLECTION_ID]: [{
    id: 'automation-event-checkpoints-v1-to-v2',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    migrate: (value) => value,
  }],
} satisfies Readonly<Record<string, readonly PluginAccountCollectionMigration[]>>;
