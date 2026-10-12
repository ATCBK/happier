import { CORPUS_COLLECTION_MIGRATIONS } from './corpus/collections/migrations.js';

/** The build binds the captured canonical manifest around these pure callbacks. */
export function collectionMigrations() {
    return CORPUS_COLLECTION_MIGRATIONS;
}
