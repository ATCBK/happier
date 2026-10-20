import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewCommentPublicationPlanV1 } from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { claimReviewCommentPublication } from "@/testkit/reviewCommentPublicationTestkit";
import { createReviewCommentOperations } from "./operations";
import { createSqlReviewCommentStore } from "./store";
import { publishGithubPullRequestReview } from '../../../../../../packages/plugins/scm-github/src/triage/mutations/pullRequest';
import { createStubGithubTransport, createTestGithubApiClient, readRecordedJsonBody } from '../../../../../../packages/plugins/scm-github/src/triage/testkit/githubTriage.test-support';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_PULL_REQUEST_RESPONSE } from '../../../../../../packages/plugins/scm-github/src/triage/__fixtures__/githubResponses';

describe("GitHub publication recovery through the real provider adapter and SQL claim owner", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-github-publication-recovery-", initAuth: false, sqliteConnectionLimit: 2 });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it("reconciles a GitHub review after settlement transport timeout without a second provider POST", async () => {
        const account = await db.account.create({ data: {
            id: "account-publication-settlement-timeout", publicKey: "pk-publication-settlement-timeout", encryptionMode: "plain",
        }, select: { id: true } });
        const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
            now: () => 1234, createId: (prefix) => `${prefix}-unused`,
        });
        const headRevision = "a".repeat(40);
        const baseRevision = "b".repeat(40);
        const localRef = { kindId: "pull-request", collisionScope: "github:4210", entryId: "1284" } as const;
        const plan: ReviewCommentPublicationPlanV1 = {
            target: { providerId: "github", configuredAccountId: "account-under-test", subtarget: null,
                entryRef: { sourceId: "happier.scm.forge.github/github-forge", ...localRef } },
            baseRevision, headRevision, entries: [], verdict: { kind: "requestChanges", body: "Review after settlement timeout." },
        };
        const reviews: Array<{ id: number; commit_id: string; state: string; body: string }> = [];
        const transport = createStubGithubTransport({ respond: request => {
            const path = new URL(request.url).pathname;
            const pull = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`;
            if (request.method === "GET" && path === pull) return { status: 200, body: {
                ...GITHUB_PULL_REQUEST_RESPONSE, state: "open", merged: false,
                head: { ...(GITHUB_PULL_REQUEST_RESPONSE.head as object), sha: headRevision },
                base: { ...(GITHUB_PULL_REQUEST_RESPONSE.base as object), sha: baseRevision },
            } };
            if (request.method === "GET" && path === `${pull}/reviews`) return { status: 200, body: reviews };
            if (request.method === "POST" && path === `${pull}/reviews`) {
                const body = readRecordedJsonBody(request) as { body: string; commit_id: string; event: string };
                reviews.push({ id: 5579420454, body: body.body, commit_id: body.commit_id, state: "CHANGES_REQUESTED" });
                return { status: 201, body: reviews.at(-1) };
            }
            return undefined;
        } });
        const client = await createTestGithubApiClient(transport);
        let loseFirstSettlement = true;
        const dispositions: string[] = [];
        const publish = () => publishGithubPullRequestReview({
            localRef, route: { owner: GITHUB_FIXTURE_OWNER, name: GITHUB_FIXTURE_REPOSITORY }, publicationPlan: plan,
            claimPublicationDispatch: async () => {
                const claim = await claimReviewCommentPublication(operations, {
                    accountId: account.id, actor: { kind: "user", userId: account.id }, input: plan,
                });
                dispositions.push(claim.disposition);
                return claim;
            },
            settlePublicationDispatch: async (claim, result) => {
                // The host transport can fail before the canonical settlement is attempted,
                // as an approval currentness read did in QA33. Keep the real SQL owner below it.
                if (loseFirstSettlement) {
                    loseFirstSettlement = false;
                    throw Object.assign(new Error("Machine RPC setup timed out"), { code: "MACHINE_RPC_TIMEOUT" });
                }
                await claimReviewCommentPublication(operations, { accountId: account.id,
                    actor: { kind: "user", userId: account.id }, input: {
                        ...plan, settlement: { dispatchToken: claim.dispatchToken, result },
                    } });
            },
        }, { client, now: () => 1234, signal: transport.context.signal });
        expect(await publish()).toMatchObject({ kind: "settled",
            failure: { code: "github_publication_settlement_unrecorded" },
            publication: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
        const recovered = await publish();
        expect(recovered).not.toHaveProperty("failure");
        expect(recovered).toMatchObject({ kind: "settled",
            publication: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
        expect(dispositions).toEqual(["dispatch", "reconcile"]);
        expect(reviews).toHaveLength(1);
        expect(transport.requests.filter(request => request.method === "POST")).toHaveLength(1);
        expect(await claimReviewCommentPublication(operations, { accountId: account.id,
            actor: { kind: "user", userId: account.id }, input: plan,
        })).toMatchObject({ disposition: "reconcile", instructions: { entries: [], verdict: "confirmed" },
            priorResult: { verdict: { outcome: { kind: "published", externalRef: "5579420454" } } },
        });
    });
});
