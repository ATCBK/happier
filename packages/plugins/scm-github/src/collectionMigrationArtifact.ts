import { GITHUB_COLLECTION_MIGRATIONS } from './observations/githubCollectionMigrations.js';

/** The build binds the captured canonical manifest around these pure callbacks. */
export function collectionMigrations() {
  return GITHUB_COLLECTION_MIGRATIONS;
}
