/**
 * Evidence fixture only; no External Sessions capability is registered.
 * The characterized native schema contains bodies, but the current SDK cannot
 * guarantee a live WAL read that never creates or changes vendor sidecars.
 */
export const DEVIN_EXTERNAL_SESSIONS_DECISION = Object.freeze({
  release: 'unsupported' as const,
  reason: 'non_mutating_wal_read_unavailable' as const,
  message: "Devin conversation search supports only the characterized native session database format. This store's schema is unsupported or unreadable; no conversations were searched. ATIF export is not required or invoked.",
  nativeDialect: Object.freeze({
    producerVersion: '3000.6.7',
    schemaVersion: 16,
    sourceCommit: '45351ff95ce79684c23377920b92026ecbe9759b',
    provenanceUrl: 'https://github.com/xhluca/session-migrate/blob/45351ff95ce79684c23377920b92026ecbe9759b/tests/native_corpus/v1/sources/devin/3000.6.7/portable-rich/provenance.json',
  }),
  readBoundaryEvidence: Object.freeze({
    checkedAt: '2026-10-20',
    nodeVersion: '24.21.0',
    sqliteVersion: '3.53.4',
    sdkOwner: 'packages/plugin-sdk/src/fs/sqlite.ts#openSqliteDatabaseSync',
    fixtureBasis: 'real_sqlite_writer_with_wal_only_commit' as const,
    readOnlyAndQueryOnly: 'reads_wal_but_changes_shm_read_mark' as const,
    uriReadOnly: 'reads_wal_but_changes_shm_read_mark' as const,
    uriReadOnlyShm: 'live_read_preserves_bytes_but_missing_sidecars_open_creates_wal' as const,
    writerContinues: true,
    sqliteWalContractUrl: 'https://sqlite.org/walformat.html',
    sqliteImmutableContractUrl: 'https://sqlite.org/uri.html#uriimmutable',
  }),
  recipe: 'none' as const,
  observationRegistration: false,
  externalSessionsRegistration: false,
  autoLinkEligible: false,
  exposedCapability: 'none' as const,
});
