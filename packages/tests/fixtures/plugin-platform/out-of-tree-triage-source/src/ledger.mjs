/**
 * The fixture provider.
 *
 * An outside author's Triage source reads a provider that returns raw rows of
 * its own shape, some of which are independently malformed. Nothing here knows
 * about Happier: these are deliberately provider-native DTOs, so the mapping in
 * `map.mjs` is real work rather than a rename.
 *
 * Reads are deterministic and in-memory. The genuine system boundary a real
 * source would mock is HTTP; this fixture has none, so no mock exists either.
 *
 * It serves two spaces through one page and row owner:
 *
 *  - `acme/ledger`, the curated correctness space, whose raw rows include the
 *    independently malformed and merged ones the mapping has to survive; and
 *  - `acme/ledger-qa`, the declared 2,000-row space `qa/QA-PROTOCOL.md` QB-57's
 *    list and performance recipe needs a real source for.
 *
 * They are the same provider seen through the same page geometry — there is no
 * second store, cache, or generator path — and which one a configured instance
 * reads is decided by ordinary source configuration, never by an environment
 * variable or a global mode.
 */

export const LEDGER_SPACE_IDS = Object.freeze({
    curated: 'acme/ledger',
    qa: 'acme/ledger-qa',
});

/** Every space this provider serves, in the order discovery reports them. */
export const LEDGER_SPACE_ID_LIST = Object.freeze([
    LEDGER_SPACE_IDS.curated,
    LEDGER_SPACE_IDS.qa,
]);

/** Raw rows exactly as the fixture provider returns them, malformed ones included. */
const CURATED_ROWS = Object.freeze([
    Object.freeze({
        ref: 'CHG-17',
        type: 'change',
        headline: 'Consolidate the duplicated normalizer',
        detail: 'Removes the second owner and migrates its callers.',
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
        opened_at: 1_760_000_000_000,
        updated_at: 1_760_000_600_000,
        revision: 'b3f1c0a9d2e4',
        reviewers: ['viewer'],
        checks: { state: 'passing', label: 'All checks passing' },
        owner: 'r.okafor',
        url: 'https://ledger.invalid/acme/ledger/change/17',
        repository: Object.freeze({
            kind: 'custom',
            deployment: 'https://forge.example.test/Forge',
            repository: 'Team/Repo',
        }),
    }),
    // Malformed: the provider omitted the identity every mapping needs.
    Object.freeze({
        type: 'ticket',
        headline: 'Row with no provider identity',
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-204',
        type: 'ticket',
        headline: 'Search returns stale rows after a rename',
        space: LEDGER_SPACE_IDS.curated,
        status: 'triaged',
        opened_at: 1_759_000_000_000,
        updated_at: 1_759_500_000_000,
        assignees: ['viewer'],
        owner: 'p.lindqvist',
        url: 'https://ledger.invalid/acme/ledger/ticket/204',
    }),
    // Malformed: `headline` is the provider's own required display field and is
    // not a string, so this row has no projectable title.
    Object.freeze({
        ref: 'TCK-205',
        type: 'ticket',
        headline: { text: 'structured headline the contract does not carry' },
        space: LEDGER_SPACE_IDS.curated,
        status: 'open',
    }),
    Object.freeze({
        ref: 'TCK-206',
        type: 'ticket',
        headline: 'Duplicate of TCK-204',
        space: LEDGER_SPACE_IDS.curated,
        status: 'merged_into',
        merged_into: 'TCK-204',
        opened_at: 1_759_100_000_000,
    }),
    Object.freeze({
        ref: 'CHG-18',
        type: 'change',
        headline: 'Bound the ledger page walk',
        space: LEDGER_SPACE_IDS.curated,
        status: 'closed',
        opened_at: 1_758_000_000_000,
        updated_at: 1_758_400_000_000,
        revision: 'c4e2b1f7a0d9',
        url: 'https://ledger.invalid/acme/ledger/change/18',
    }),
]);

/** The provider row the fixture treats as retired for authoritative reads. */
export const LEDGER_RETIRED_REF = 'TCK-900';

/** The provider row whose authoritative read never settles cleanly. */
export const LEDGER_UNAVAILABLE_REF = 'TCK-901';

export const LEDGER_ROW_COUNT = CURATED_ROWS.length;

/** The declared size of the QA space (`qa/QA-PROTOCOL.md` QB-57). */
export const LEDGER_QA_ROW_COUNT = 2_000;

const QA_EPOCH_MS = 1_760_000_000_000;
const QA_OWNERS = Object.freeze(['r.okafor', 'p.lindqvist', 'm.haddad', 's.nakamura']);
const QA_STATUSES = Object.freeze(['open', 'triaged', 'closed', 'resolved']);

/**
 * Builds one QA row from its index.
 *
 * The whole space is a pure function of the index, so a page read and an exact
 * authoritative read of the same entry cannot disagree, and neither one has to
 * materialize a 2,000-row inventory to answer. The workload is mixed on
 * purpose: both kinds, four provider states, two check outcomes, viewer
 * involvement on two different cadences, and a detail-only owner fact.
 */
function readQaLedgerRow(index) {
    if (!Number.isInteger(index) || index < 0 || index >= LEDGER_QA_ROW_COUNT) return null;
    const type = index % 2 === 0 ? 'change' : 'ticket';
    const openedAt = QA_EPOCH_MS - index * 60_000;
    const row = {
        ref: `LGQ-${index}`,
        type,
        headline: `${type === 'change' ? 'Change' : 'Ticket'} ${index} in the Acme Ledger QA space`,
        space: LEDGER_SPACE_IDS.qa,
        status: QA_STATUSES[index % QA_STATUSES.length],
        opened_at: openedAt,
        updated_at: openedAt + 30_000,
        owner: QA_OWNERS[index % QA_OWNERS.length],
        url: `https://ledger.invalid/acme/ledger-qa/${type}/${index}`,
    };
    if (type === 'change') {
        row.revision = `qa${index.toString(16).padStart(12, '0')}`;
        row.checks = index % 3 === 0
            ? { state: 'passing', label: 'All checks passing' }
            : { state: 'failing', label: 'One check failing' };
    }
    if (index % 7 === 0) row.reviewers = ['viewer'];
    if (index % 5 === 0) row.assignees = ['viewer'];
    return Object.freeze(row);
}

/** Resolves a QA reference back to its index, or `-1` when it names no row. */
function readQaLedgerRowIndex(ref) {
    const parsed = /^LGQ-(\d+)$/u.exec(typeof ref === 'string' ? ref : '');
    if (parsed === null) return -1;
    const index = Number(parsed[1]);
    // `LGQ-007` is a different string from `LGQ-7`; only the canonical spelling
    // this provider emits resolves, so two refs never mean one entry.
    return `${index}` === parsed[1] && index < LEDGER_QA_ROW_COUNT ? index : -1;
}

/**
 * The one row source per space. Both spaces answer the same two questions —
 * "the row at this offset" and "the offset of this reference" — which is what
 * lets the page walk and the authoritative read share a single owner.
 */
const LEDGER_SPACES = Object.freeze({
    [LEDGER_SPACE_IDS.curated]: Object.freeze({
        rowCount: CURATED_ROWS.length,
        readRow: (index) => CURATED_ROWS[index] ?? null,
        indexOfRef: (ref) => CURATED_ROWS.findIndex((row) => row.ref === ref),
    }),
    [LEDGER_SPACE_IDS.qa]: Object.freeze({
        rowCount: LEDGER_QA_ROW_COUNT,
        readRow: readQaLedgerRow,
        indexOfRef: readQaLedgerRowIndex,
    }),
});

/** Whether this provider serves the named space at all. */
export function isLedgerSpace(space) {
    return typeof space === 'string' && Object.hasOwn(LEDGER_SPACES, space);
}

/**
 * Reads one bounded provider page.
 *
 * `offset` and `pageSize` are the provider's own geometry. The caller never
 * sees a next URL: the source owns continuation custody.
 */
export function readLedgerPage(space, offset, pageSize) {
    if (!isLedgerSpace(space)) return Object.freeze({ rows: Object.freeze([]), nextOffset: null });
    const provider = LEDGER_SPACES[space];
    const end = Math.min(offset + pageSize, provider.rowCount);
    const rows = [];
    for (let index = offset; index < end; index += 1) {
        const row = provider.readRow(index);
        if (row !== null) rows.push(row);
    }
    return Object.freeze({
        rows: Object.freeze(rows),
        nextOffset: end < provider.rowCount ? end : null,
    });
}

/** Reads one exact provider row, or `null` when the space has none. */
export function readLedgerRow(space, ref) {
    if (!isLedgerSpace(space)) return null;
    const provider = LEDGER_SPACES[space];
    const index = provider.indexOfRef(ref);
    return index < 0 ? null : provider.readRow(index);
}

/**
 * The provider fields this source deliberately loads only for its detail
 * surface. The list projection carries the labelled fact without a value; only
 * a detail read resolves it.
 */
export function readLedgerDetailOnlyFacts(space, ref) {
    const row = readLedgerRow(space, ref);
    return row === null || typeof row.owner !== 'string'
        ? null
        : Object.freeze({ owner: row.owner });
}
