/**
 * An external service or CI integration driving Happier through the published
 * SDK only.
 *
 * It imports nothing from the Happier host: no daemon module, no Protocol deep
 * import, no crypto. Installed external plugins instead use the public Plugin
 * SDK and retain the same trusted host capabilities as built-in plugins; they
 * are not narrowed to this PAT/API projection.
 */
import {
  connect,
  HappierActionError,
  isHappierActionApprovalRequestCreated,
  type PublicActionInputById,
} from '@happier-dev/sdk';

const endpoint = process.env.HAPPIER_API_ENDPOINT;
// Either an ordinary `hap_v1_…` bearer or an encryption-capable `hapc_v1_…`
// credential. The call sites below are byte-identical: selecting the compound
// credential seals the whole Action request and result before Home transit,
// while a bearer keeps the documented Home-visible transit. There is no
// per-call `encrypt` option and no encrypted method tree.
const token = process.env.HAPPIER_TOKEN;
const sessionId = process.env.HAPPIER_SESSION_ID;
const discussionId = process.env.HAPPIER_DISCUSSION_ID;
const machineId = process.env.HAPPIER_MACHINE_ID;
if (!endpoint || !token || !sessionId || !discussionId || !machineId) {
  throw new Error('Set HAPPIER_API_ENDPOINT, HAPPIER_TOKEN, HAPPIER_SESSION_ID, HAPPIER_DISCUSSION_ID and HAPPIER_MACHINE_ID.');
}

/**
 * The Agent target and permission mode are runtime selections this integration
 * receives from its own configuration; they are not SDK concepts.
 */
type RunSelection = Pick<
  PublicActionInputById['execution.run.start'],
  'backendTarget' | 'permissionMode'
>;

const happier = connect({ endpoint, token }).machine(machineId);

try {
  const session = happier.sessions.get(sessionId);

  // 1. Post to an existing human-readable discussion through the generated
  //    Action tree. Discussion creation remains an interactive present-user
  //    operation and is intentionally absent from the PAT SDK. Content is the
  //    authored document; the host owns the Discussion key, so an external
  //    caller never handles Discussion keys.
  const posted = await happier.actions.discussion.post({
    discussionId,
    localId: 'external-plugin-thread-1-followup',
    content: { v: 1, parts: [{ t: 'text', text: 'Starting a contextual run for this discussion.' }] },
  });
  if (isHappierActionApprovalRequestCreated(posted)) {
    throw new Error(`Discussion post needs approval: ${posted.artifactId}`);
  }

  // 2. Start an Execution Run through the canonical Action, then bind its id.
  //    There is no SDK-local run starter, builder or run state store.
  // Environment JSON is a genuinely untyped external boundary; the canonical
  // Action schema is what actually validates this selection.
  const selection = JSON.parse(process.env.HAPPIER_RUN_SELECTION ?? '{}') as RunSelection;
  const started = await happier.actions.execution.run.start({
    ...selection,
    sessionId,
    intent: 'delegate',
    runClass: 'long_lived',
    retentionPolicy: 'resumable',
    ioMode: 'streaming',
  });
  if (isHappierActionApprovalRequestCreated(started)) {
    throw new Error(`Run start needs approval: ${started.artifactId}`);
  }

  const run = session.runs.get(started.runId);
  try {
    await run.send('Inspect the failing parser case.');
    // Settles on this exact admitted turn. A lost correlation returns the
    // canonical `outcomeUnknown` result; it is never retried here.
    const settled = await run.sendAndWait('Summarize what you changed.', {
      localId: 'external-plugin-followup-1',
      timeoutSeconds: 300,
    });
    // The run's own sidechain, never the main Session transcript.
    const history = await run.history({ limit: 20 });
    console.log(JSON.stringify({ discussionId, runId: run.id, settled, historyOk: history.ok }));
  } finally {
    await run.stop();
    // Terminal status, not conversational idle. A typed observation timeout
    // leaves the run running.
    await run.wait({ timeoutSeconds: 60 });
  }
} catch (error) {
  if (error instanceof HappierActionError) {
    // Canonical Action codes survive the protected transport unchanged:
    // `approval_required`, `invalid_parameters`, and the domain's own codes.
    console.error(JSON.stringify({ actionErrorCode: error.code, requestId: error.requestId }));
  }
  throw error;
} finally {
  await happier.close();
}
