import { describe, expect, it } from 'vitest';

import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol';
import { PluginSearchQueryV1Schema, PluginSearchResultV1Schema } from '@happier-dev/plugin-sdk';
import {
    EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
    isExternalActionResultWithinResponseEnvelopeLimitV1,
    measureExternalActionResultResponseEnvelopeUtf8BytesV1,
} from '@happier-dev/plugin-sdk/actions';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    buildMaximalSchemaValue,
    encodedJsonBytes,
    createTriageSourceV1Fixture,
    type MeasurableSchemaV1,
} from '@happier-dev/triage-protocol/testing/v1';

import {
    MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1,
    TriageReadConfiguredSourceInstancesInputV1Schema,
    TriageReadConfiguredSourceInstancesResultV1Schema,
    TriageSourceAdministrationActionInputV1Schema,
    TriageSourceAdministrationActionResultV1Schema,
    TriagePullRequestStatusResultV1Schema,
    TriageEntryRefV1Schema,
    TriageTaskWriteResultV1Schema,
    TriageSourcesContributionProtocolV1,
} from '@happier-dev/triage-protocol/v1';

import { PLUGIN_MANIFEST } from '../manifest.js';
import { TriageCreateTaskActionInputV1Schema, TriageEditTaskActionInputV1Schema, TriageTransitionTaskActionInputV1Schema, TriageTaskDraftV1Schema } from './tasksProtocol.js';
import {
    TriageMountedSourceInsertInputV1Schema,
    TriageMountedSourceRevealInputV1Schema,
    TriageMountedUiInputV1Schema,
    TriageMountedUiResultV1Schema,
} from './mountedUiProtocol.js';
import { TriageRunConfiguredActionInputV1Schema, TriageRunConfiguredActionResultV1Schema } from './configuredActionRunProtocol.js';
import {
    TriageAdministerActionInputV1Schema,
    TriageAdministerActionResultV1Schema,
    TriageReadActionsInputV1Schema,
    TriageReadActionsResultV1Schema,
} from './actionsCatalogProtocol.js';
import { MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 } from '../settings/actions.js';
import { MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 } from '../settings/savedViews.js';
import { MAX_TRIAGE_LIST_WINDOW_ROWS_V1 } from '../projection/listWindow.js';
import {
    TriageReadEntryDetailInputV1Schema,
    TriageReadEntryDetailResultV1Schema,
} from './entryDetailProtocol.js';
import {
    TriageReobserveEntryInputV1Schema,
    TriageReobserveEntryResultV1Schema,
} from './reobserveEntryProtocol.js';
import {
    TriageStartEntrySessionInputV1Schema,
    TriageStartEntrySessionResultV1Schema,
    TriageStartPullRequestReviewInputV1Schema,
    TriageStartPullRequestReviewResultV1Schema,
    TriageUnlinkEntryFromSessionActionInputV1Schema,
    TriageUnlinkEntryFromSessionActionResultV1Schema,
} from './entrySessionProtocol.js';
import {
    MAX_TRIAGE_LIST_SOURCE_BATCH_V1,
    triageListRowBudgetV1,
    TriageListEntriesInputV1Schema,
    TriageListEntriesResultV1Schema,
} from './listEntriesProtocol.js';
import {
    TriageAdministerSavedViewInputV1Schema,
    TriageAdministerSavedViewResultV1Schema,
    TriageReadSavedViewsInputV1Schema,
    TriageReadSavedViewsResultV1Schema,
} from './savedViewsProtocol.js';
import {
    TriageLinkEntryToSessionActionResultV1Schema,
    TriageLinkEntryToSessionInputV1Schema,
    TriageReadSourceSessionLinksInputV1Schema,
    TriageReadSourceSessionLinksResultV1Schema,
} from './sessionLinksProtocol.js';
import {
    TriageListPinnedEntriesInputV1Schema,
    TriageListPinnedEntriesResultV1Schema,
    TriageSetEntryPinnedInputV1Schema,
    TriageSetEntryPinnedResultV1Schema,
} from './userMarksProtocol.js';
import {
    TriageReadFixPullRequestsInputV1Schema,
    TriageReadFixPullRequestsResultV1Schema,
    TriageSetFixPullRequestInputV1Schema,
    TriageSetFixPullRequestResultV1Schema,
} from '@happier-dev/triage-protocol/v1';

/**
 * Serialized-size regression coverage for this aggregate's Action values.
 *
 * `packages/triage-protocol/src/v1/maximumEncodedResult.test.ts` proves the
 * *source-facing* operation values fit their schemas. Nothing proved that this
 * target's own Action values retain their measured size. Every plugin Action
 * input and result is parsed by `AgentRuntimeJsonValueV1Schema`
 * (`packages/protocol/src/runtime/agentSessionV1.ts`) at
 * `packages/protocol/src/plugins/actions/invocation.ts` **before** the manifest
 * `resultSchema` is checked. That schema establishes strict JSON safety only;
 * it does not own an aggregate byte limit for Action values.
 *
 * The values measured here are real schema-derived values, not copies of a
 * transport or persistence limit. A future aggregate boundary must be owned
 * and tested at that named boundary rather than inferred from this parser.
 *
 * Finite maxima come from the public source-protocol derivation. Provider-sized
 * task facts use explicit finite witnesses and the real host envelope check;
 * those witnesses do not establish a maximum for an unbounded result.
 */

/**
 * Values whose schema has a finite structural maximum.
 */
const structurallyBoundedSchemas = {
    mountedUiResult: TriageMountedUiResultV1Schema,
    readEntryDetailInput: TriageReadEntryDetailInputV1Schema,
    reobserveEntryInput: TriageReobserveEntryInputV1Schema,
    transitionTaskInput: TriageTransitionTaskActionInputV1Schema,
    setEntryPinnedInput: TriageSetEntryPinnedInputV1Schema,
    setEntryPinnedResult: TriageSetEntryPinnedResultV1Schema,
    listPinnedEntriesInput: TriageListPinnedEntriesInputV1Schema,
    listPinnedEntriesResult: TriageListPinnedEntriesResultV1Schema,
    readFixPullRequestsInput: TriageReadFixPullRequestsInputV1Schema,
    setFixPullRequestInput: TriageSetFixPullRequestInputV1Schema,
    setFixPullRequestResult: TriageSetFixPullRequestResultV1Schema,
    linkEntryToSessionInput: TriageLinkEntryToSessionInputV1Schema,
    linkEntryToSessionResult: TriageLinkEntryToSessionActionResultV1Schema,
    unlinkEntryFromSessionInput: TriageUnlinkEntryFromSessionActionInputV1Schema,
    unlinkEntryFromSessionResult: TriageUnlinkEntryFromSessionActionResultV1Schema,
    readSavedViewsInput: TriageReadSavedViewsInputV1Schema,
    readActionsInput: TriageReadActionsInputV1Schema,
    // The two caller-bound source Actions are declared by this manifest, so
    // this plugin's own gate proof covers them too. `@happier-dev/triage-protocol`
    // derives them independently as the owner of their shapes; two pins over one
    // derivation is a second measurement, not a second bounds ledger, and it is
    // what lets the assertion below be "every declared schema" with no
    // exclusions to keep true.
    administerSourceInstanceInput: TriageSourceAdministrationActionInputV1Schema,
    administerSourceInstanceResult: TriageSourceAdministrationActionResultV1Schema,
    readConfiguredInstancesInput: TriageReadConfiguredSourceInstancesInputV1Schema,
    readSourceSessionLinksInput: TriageReadSourceSessionLinksInputV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * The saved-view results, whose reachable maximum is smaller than their
 * structural one and is owned elsewhere.
 *
 * Both carry the stored `triage.savedViews` set, and `savedViews.ts` bounds
 * that whole serialized value at `MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1`
 * — a bound over the complete value, which no per-member schema can express.
 * The writer refuses a mutation past it and the reader refuses a stored value
 * past it, so the widest set either Action can return is that ceiling plus this
 * result's own small framing. Measuring them against the schema instead would
 * mean shrinking a product bound to satisfy a value the owner already makes
 * unreachable.
 */
const ownerBoundedSchemas = {
    readActionsResult: TriageReadActionsResultV1Schema,
    administerActionResult: TriageAdministerActionResultV1Schema,
    readSavedViewsResult: TriageReadSavedViewsResultV1Schema,
    administerSavedViewResult: TriageAdministerSavedViewResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * Values with a deliberately unbounded member. They remain strict JSON, but a
 * maximum encoded value cannot be derived without inventing a product quota.
 */
const structurallyUnboundedSchemas = {
    // Linked Sessions follow the real relationship set, not a local count quota.
    readEntryDetailResult: TriageReadEntryDetailResultV1Schema,
    taskDraftInput: TriageTaskDraftV1Schema,
    readSourceSessionLinksResult: TriageReadSourceSessionLinksResultV1Schema,
    // Live task relations/native transitions and write fields follow provider
    // data. The host envelope, rather than a per-task membership cap, owns size.
    listEntriesResult: TriageListEntriesResultV1Schema,
    reobserveEntryResult: TriageReobserveEntryResultV1Schema,
    createTaskInput: TriageCreateTaskActionInputV1Schema,
    editTaskInput: TriageEditTaskActionInputV1Schema,
    taskWriteResult: TriageTaskWriteResultV1Schema,
    // Universal Search owns unbounded query text and result items; no local quota.
    searchEntriesInput: PluginSearchQueryV1Schema,
    searchEntriesResult: PluginSearchResultV1Schema,
    // The fix-PR candidate projection follows real linked Sessions without a count quota.
    readFixPullRequestsResult: TriageReadFixPullRequestsResultV1Schema,
    runConfiguredActionInput: TriageRunConfiguredActionInputV1Schema,
    runConfiguredActionResult: TriageRunConfiguredActionResultV1Schema,
    // The mounted owner admits exact selections without a product count quota.
    mountedUiInput: TriageMountedUiInputV1Schema,
    // Mounted source operations retain exact, unbounded owner occurrence identities.
    mountedSourceRevealInput: TriageMountedSourceRevealInputV1Schema,
    mountedSourceInsertInput: TriageMountedSourceInsertInputV1Schema,
    // PR status walks source-owned rows without a product count ceiling.
    readPullRequestStatusResult: TriagePullRequestStatusResultV1Schema,
    startEntrySessionInput: TriageStartEntrySessionInputV1Schema,
    startEntrySessionResult: TriageStartEntrySessionResultV1Schema,
    // The review request deliberately carries an unbounded engine selection
    // and provider-owned pull-request JSON. Its result reports what became of
    // each engine in that same selection — every requested id appears exactly
    // once, across the started and failed halves — so it inherits precisely
    // that one unbounded dimension and no other. Bounding it would mean
    // inventing an engine-count quota no owner establishes.
    startPullRequestReviewInput: TriageStartPullRequestReviewInputV1Schema,
    startPullRequestReviewResult: TriageStartPullRequestReviewResultV1Schema,
    listEntriesInput: TriageListEntriesInputV1Schema,
    administerSavedViewInput: TriageAdministerSavedViewInputV1Schema,
    administerActionInput: TriageAdministerActionInputV1Schema,
    // The durable configured-source set has no product count ceiling. Its
    // reader fits whole records against the canonical Action envelope and uses
    // the published `truncated` status when the tail cannot cross it.
    readConfiguredInstancesResult: TriageReadConfiguredSourceInstancesResultV1Schema,
} as const satisfies Readonly<Record<string, MeasurableSchemaV1>>;

/**
 * A finite witness for task and configured-unit facts, used only to keep the existing independent
 * row/frontier envelope regression. These example relationships/transitions are
 * not product bounds or a maximum of the now provider-sized list result.
 */
const taskFactsEntryRef = createTriageSourceV1Fixture().detailInput.observation.entryRef;
function withTaskFactsWitness(fragment: PluginJsonSchema): PluginJsonSchema {
    return {
        ...fragment,
        ...(fragment.anyOf === undefined ? {} : { anyOf: fragment.anyOf.map(withTaskFactsWitness) }),
        ...(fragment.items === undefined ? {} : { items: withTaskFactsWitness(fragment.items) }),
        ...(fragment.properties === undefined ? {} : { properties: Object.fromEntries(
            Object.entries(fragment.properties).map(([key, child]) => [key,
                key === 'scope' ? { const: {
                    unit: { singularLabel: 'Project', pluralLabel: 'projects' },
                    projection: { kind: 'page', status: 'complete', selection: { kind: 'selected', unitIds: ['project-1'] },
                        units: [{ id: 'project-1', label: 'Platform' }] },
                } } : key === 'relations' ? { const: {
                    parent: taskFactsEntryRef, children: { total: 1, completed: 0, entries: [taskFactsEntryRef], complete: true },
                    blockedBy: [taskFactsEntryRef],
                } } : key === 'taskCapabilities' ? { const: {
                    editFields: ['title'], transitions: [{ id: 'start', label: 'Start', state: { presentation: 'active', stage: 'started' } }],
                } } : withTaskFactsWitness(child),
            ]),
        ) }),
    };
}
function listEntriesResultWitnessAt(rows: number, frontiers: number): PluginJsonSchema {
    const result = withTaskFactsWitness(TriageListEntriesResultV1Schema.jsonSchema);
    const windowProperties = { ...result.properties?.window?.properties };
    if (windowProperties.continuations === undefined || windowProperties.rows === undefined) {
        throw new Error('the list window no longer carries both a row array and a continuation set');
    }
    windowProperties.rows = { ...windowProperties.rows, maxItems: rows };
    if (frontiers === 0) {
        delete windowProperties.continuations;
    } else {
        windowProperties.continuations = { ...windowProperties.continuations, maxItems: frontiers };
    }
    return {
        ...result,
        properties: {
            ...result.properties,
            window: { ...result.properties?.window, properties: windowProperties },
        },
    };
}

const measuredSchemas = {
    ...structurallyBoundedSchemas,
    ...ownerBoundedSchemas,
    ...structurallyUnboundedSchemas,
    // The built-in source now declares these same public source-role schemas.
    // Their finite maxima and provider-sized witnesses are exercised by the
    // protocol owner's maximumEncodedResult suite, not a second local catalog.
    ...Object.fromEntries(Object.entries(TriageSourcesContributionProtocolV1.operations)
        .flatMap(([role, operation]) => [
            [`source/${role}/input`, operation.declaration.input.schema],
            [`source/${role}/result`, operation.declaration.resultSchema],
        ])),
};

function admits(value: unknown): boolean {
    return AgentRuntimeJsonValueV1Schema.safeParse(value).success;
}

/**
 * Gives intentionally unconstrained JSON members a finite value for witness
 * construction. This is not a maximum: an empty JSON Schema has none. `null`
 * is merely admitted by that owner while the prompt bound remains the only
 * member this regression is widening.
 */
function finiteOpaqueJsonWitness(fragment: PluginJsonSchema): PluginJsonSchema {
    if (Object.keys(fragment).length === 0) return { const: null };
    // Host source-custody identifiers have no finite maximum. Choose an
    // admitted witness only for this prompt regression, never a product bound.
    if (fragment.type === 'string' && fragment.maxLength === undefined
        && fragment['x-happier-max-utf8-bytes'] === undefined
        && fragment.enum === undefined && fragment.const === undefined) {
        return { ...fragment, const: 'fixture-occurrence' };
    }
    return {
        ...fragment,
        ...(fragment.anyOf === undefined
            ? {}
            : { anyOf: fragment.anyOf.map(finiteOpaqueJsonWitness) }),
        ...(fragment.properties === undefined
            ? {}
            : {
                properties: Object.fromEntries(Object.entries(fragment.properties)
                    .map(([key, child]) => [key, finiteOpaqueJsonWitness(child)])),
            }),
        ...(fragment.items === undefined
            ? {}
            : { items: finiteOpaqueJsonWitness(fragment.items) }),
    };
}

describe('aggregate Action value shapes', () => {
    /**
     * The measured set has to be the declared set, or an Action added later
     * simply would not be measured. There are no exclusions: an Action this
     * manifest declares crosses this gate whoever owns its shape.
     */
    it('measures every Action schema this plugin declares', () => {
        const measured = new Set(Object.values<MeasurableSchemaV1>(measuredSchemas)
            .map((schema) => JSON.stringify(schema.jsonSchema)));
        const unmeasured = PLUGIN_MANIFEST.contributes.actions.flatMap((action) => (
            [['input', action.inputSchema], ['result', action.resultSchema]] as const
        ).filter(([, schema]) => !measured.has(JSON.stringify(schema)))
            .map(([side]) => `${action.id}:${side}`));

        expect(unmeasured).toEqual([]);
    });

    it('fits a finite task-facts witness with every continuation and derives its first envelope rejection', () => {
        const reachable = listEntriesResultWitnessAt(MAX_TRIAGE_LIST_WINDOW_ROWS_V1, MAX_TRIAGE_LIST_SOURCE_BATCH_V1);
        const rows = reachable.properties?.window?.properties?.rows;
        const row = rows?.items?.properties;
        if (rows === undefined || row?.otherObservations === undefined || row.observedByCount === undefined) {
            throw new Error('the list result no longer carries its observation cardinality');
        }
        // Every row consumes at least one observation from this invocation's
        // total budget. A full window spends it all on the primary observations;
        // the schema-only per-row maximum cannot also be spent on every row.
        row.otherObservations.maxItems = 0;
        row.observedByCount.maximum = 1;
        const maximal = buildMaximalSchemaValue(
            reachable,
            'listEntriesResult',
        );
        const parsed = TriageListEntriesResultV1Schema.parse(maximal);
        expect(parsed.configuredSources[0]?.scope?.projection).toMatchObject({ kind: 'page',
            selection: { kind: 'selected', unitIds: ['project-1'] } });
        expect(parsed.window.rows).toHaveLength(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(parsed.window.rows.reduce((total, item) => total + 1 + item.otherObservations.length, 0))
            .toBe(triageListRowBudgetV1(MAX_TRIAGE_LIST_SOURCE_BATCH_V1));
        const maximalBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(maximal);
        expect(maximalBytes)
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(maximal)).toBe(true);
        const laneTokenCount = parsed.window.continuations.length;
        expect(laneTokenCount).toBe(MAX_TRIAGE_LIST_SOURCE_BATCH_V1);

        const widened = structuredClone(reachable);
        const token = widened.properties?.window?.properties?.continuations
            ?.items?.properties?.continuation?.properties?.token;
        if (token?.['x-happier-max-utf8-bytes'] !== MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1) {
            throw new Error('the list continuation token no longer carries the shared byte ceiling');
        }
        token['x-happier-max-utf8-bytes'] = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 + 1;
        const oneByteWiderPerLane = buildMaximalSchemaValue(widened, 'widenedListEntriesResult');
        // Measure JSON escaping rather than assuming one token byte costs one
        // envelope byte. Spend the remaining headroom equally across all lanes.
        const encodedBytesPerTokenByte = (
            measureExternalActionResultResponseEnvelopeUtf8BytesV1(oneByteWiderPerLane) - maximalBytes
        ) / laneTokenCount;
        expect(encodedBytesPerTokenByte).toBeGreaterThan(0);
        const headroom = EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES - maximalBytes;
        const firstRejectedTokenUtf8Bytes = MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1
            + Math.floor(headroom / (laneTokenCount * encodedBytesPerTokenByte)) + 1;
        expect(firstRejectedTokenUtf8Bytes).toBeGreaterThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
        token['x-happier-max-utf8-bytes'] = firstRejectedTokenUtf8Bytes;
        const oversized = buildMaximalSchemaValue(widened, 'oversizedListEntriesResult');
        const oversizedBytes = measureExternalActionResultResponseEnvelopeUtf8BytesV1(oversized);
        expect(oversizedBytes).toBe(maximalBytes
            + (firstRejectedTokenUtf8Bytes - MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1)
                * laneTokenCount * encodedBytesPerTokenByte);
        expect(oversizedBytes - laneTokenCount * encodedBytesPerTokenByte)
            .toBeLessThanOrEqual(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(oversizedBytes)
            .toBeGreaterThan(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(oversized)).toBe(false);
    }, 120_000);

    it('admits a valid resolved prompt beyond the removed aggregate ceiling', () => {
        const wider = finiteOpaqueJsonWitness(
            structuredClone(TriageStartEntrySessionInputV1Schema.jsonSchema),
        );
        const delivery = wider.properties?.delivery;
        const text = delivery?.properties?.text;
        if (!text) throw new Error('start input delivery no longer carries a prompt body');
        // Replace the finite witness, not the product's unbounded prompt schema.
        text.const = 'x'.repeat(1_024 * 1_024 + 1);

        const value = buildMaximalSchemaValue(wider, 'wideStartInput');

        expect(encodedJsonBytes(value)).toBeGreaterThan(1_024 * 1_024);
        expect(TriageStartEntrySessionInputV1Schema.safeParse(value).success).toBe(true);
    });

    /** `PLAN.md` §0a A9 retains one page size independently of source count. */
    it('keeps the explicit row cap independent of lane count', () => {
        expect(triageListRowBudgetV1(0)).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(triageListRowBudgetV1(1)).toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
        expect(triageListRowBudgetV1(MAX_TRIAGE_LIST_SOURCE_BATCH_V1))
            .toBe(MAX_TRIAGE_LIST_WINDOW_ROWS_V1);
    });

    /**
     * The saved-view results are the one place a structural maximum would ask
     * for a product bound to shrink for a value that cannot occur. What has to
     * hold instead is that the owner's whole-value ceiling — the thing that
     * actually decides how large the stored set can be — leaves this result
     * comfortably inside the gate.
     */
    it('keeps Account-KV-bounded catalog results inside the gate at their real ceilings', () => {
        // The stored set is all either result carries beyond a handful of small
        // constant members, so a value of the ceiling's size plus a kilobyte of
        // room for them is the widest either Action can return. It is a byte
        // stand-in on purpose: the gate measures bytes, and it is the real gate
        // rather than a copy of its constant that answers here.
        const shell = {
            v: 1,
            availability: 'parsed',
            views: '',
            selectedViewId: null,
            revision: 'revision-1',
        };
        for (const bytes of [
            MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1 + 1_024,
            MAX_TRIAGE_SAVED_VIEWS_SERIALIZED_UTF8_BYTES_V1 + 1_024,
        ]) {
            const widest = {
                ...shell,
                views: 'a'.repeat(Math.max(bytes - encodedJsonBytes(shell), 0)),
            };

            expect(encodedJsonBytes(widest)).toBe(bytes);
            expect(admits(widest)).toBe(true);
        }
    });

    it('admits every finite maximal aggregate Action value as strict JSON', () => {
        for (const [label, schema] of Object.entries<MeasurableSchemaV1>(structurallyBoundedSchemas)) {
            const maximal = schema.parse(buildMaximalSchemaValue(schema.jsonSchema, label));
            expect(admits(maximal), `${label} must be admitted by the host JSON gate`).toBe(true);
        }
        // The budget is raised because of what this case DOES, not to silence a
        // failure: it materializes a maximal value for every structurally
        // bounded schema and parses each one through strict host JSON admission.
        // That measures ~6s, just
        // past vitest's 5s default, so it failed on duration while asserting
        // cleanly. Anything red here is an assertion, never the clock.
    }, 60_000);

    it('leaves provider-sized relationships valid while the canonical host rejects an oversized result envelope', () => {
        const observed = createTriageSourceV1Fixture().getResult;
        if (observed.kind !== 'present') throw new Error('The public fixture must provide a present entry');
        // Exercise the same byte boundary with wide valid references, avoiding
        // the unrelated cost of parsing thousands of tiny fixture objects.
        const relation = TriageEntryRefV1Schema.parse(buildMaximalSchemaValue(
            TriageEntryRefV1Schema.jsonSchema, 'oversizedTaskRelation',
        ));
        const relationBytes = encodedJsonBytes(relation) + 1;
        const result = TriageTaskWriteResultV1Schema.parse({
            kind: 'applied', observation: { ...observed, snapshot: { ...observed.snapshot,
                relations: { blockedBy: Array.from({ length: Math.ceil(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / relationBytes) + 1 }, () => relation) },
            } },
        });
        expect(admits(result)).toBe(true);
        expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(false);
    });
});
