/**
 * External-author behavior: use only the negotiated public Composer API.
 * Participant identity is supplied by the invoking UI; the host validates
 * the reference, draft transaction and eventual Discussion publication.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {Extract<import('@happier-dev/plugin-sdk/ui').ComposerRefV1, {kind:'discussion'}>} composer
 * @param {{text:string, reference:import('@happier-dev/plugin-sdk/ui').ComposerMentionRefV1}} draft
 */
export async function applyDiscussionParticipantReference(hostApi, composer, draft) {
  const read = await hostApi.readComposer(composer);
  if (read.status !== 'ready') return { status: 'composerUnavailable' };
  return hostApi.applyComposer(composer, {
    expectedRevision: read.snapshot.revision,
    operations: [
      { kind: 'text.set', text: draft.text },
      { kind: 'reference.insert', reference: draft.reference },
    ],
  });
}

/**
 * One external-author scenario shared by the real mounted input and server journey.
 * @param {string} sessionId
 * @returns {{draft: {text:string}, reference: import('@happier-dev/plugin-sdk/ui').ComposerMentionRefV1, content: import('@happier-dev/plugin-sdk/actions').PluginActionInputById['discussion.post']['content']}}
 */
export function createDiscussionParticipantQuestion(sessionId) {
  return {
    draft: {
      text: '@Reviewer Check this',
    },
    reference: {
      kind: 'happier.session', ref: `session:${encodeURIComponent(sessionId)}`,
      label: 'Reviewer', token: '@Reviewer', start: 0, end: '@Reviewer'.length,
    },
    content: { v: 1, parts: [
      { t: 'mention', participant: { kind: 'session', sessionId } },
      { t: 'text', text: ' Check this' },
    ] },
  };
}

/**
 * Submit the mounted composer's serialized value through the public Action API.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {Extract<import('@happier-dev/plugin-sdk/ui').ComposerRefV1, {kind:'discussion'}>} composer
 * @param {import('@happier-dev/plugin-sdk/actions').PluginActionInputById['discussion.post']} input
 */
export async function postDiscussionComposerContent(hostApi, composer, input) {
  return hostApi.executeAction('discussion.post', { ...input, discussionId: composer.discussionId });
}

/**
 * Safe diagnostics retain only status/code, never the draft or the host context.
 * The extra Home field deliberately crosses the real strict public parser.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {import('@happier-dev/plugin-sdk/ui').ComposerRefV1} composer
 * @param {boolean} [forgeHome]
 */
export async function probeDiscussionComposerRead(hostApi, composer, forgeHome = false) {
  try {
    const ref = forgeHome ? { ...composer, serverId: 'forged-home' } : composer;
    const result = await hostApi.readComposer(ref);
    return result.status === 'unavailable'
      ? { status: result.status, code: result.reason }
      : { status: result.status };
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' ? error.code : 'unknown';
    return { status: 'rejected', code };
  }
}

/**
 * A valid late write repeats the captured draft unchanged if a host wrongly
 * admits it. Its result projection never includes the captured text.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {import('@happier-dev/plugin-sdk/ui').ComposerRefV1} composer
 * @param {Pick<import('@happier-dev/plugin-sdk/ui').ComposerSnapshotV1, 'revision' | 'text'>} snapshot
 */
export async function probeDiscussionComposerWrite(hostApi, composer, snapshot) {
  try {
    const result = await hostApi.applyComposer(composer, {
      expectedRevision: snapshot.revision,
      operations: [{ kind: 'text.set', text: snapshot.text }],
    });
    return { status: result.status };
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' ? error.code : 'unknown';
    return { status: 'rejected', code };
  }
}

/**
 * Retain this exact public API until its host-owned lifetime ends. No timer or
 * replacement scope is used, and the console result contains no content.
 * @param {import('@happier-dev/plugin-sdk/ui').PluginUiHostApi} hostApi
 * @param {import('@happier-dev/plugin-sdk/ui').ComposerRefV1} composer
 * @param {AbortSignal} signal
 * @param {Pick<import('@happier-dev/plugin-sdk/ui').ComposerSnapshotV1, 'revision' | 'text'>} snapshot
 */
export function armDiscussionComposerRetirementProbe(hostApi, composer, signal, snapshot) {
  const captured = { revision: snapshot.revision, text: snapshot.text };
  const probe = () => {
    void Promise.all([
      probeDiscussionComposerRead(hostApi, composer),
      probeDiscussionComposerWrite(hostApi, composer, captured),
    ]).then(([read, write]) => {
      console.info('external-composer-retired-read', JSON.stringify(read));
      console.info('external-composer-retired-write', JSON.stringify(write));
    });
  };
  if (signal.aborted) probe();
  else signal.addEventListener('abort', probe, { once: true });
}

/** @returns {{text:string, reference:import('@happier-dev/plugin-sdk/ui').ComposerMentionRefV1}} */
export function createDeclaredIssueReferenceDraft() {
  const token = '[Issue 42](happier-ref:composerReference:issue-42)';
  return { text: token, reference: {
    kind: 'happier.composerReference', ref: 'composerReference:issue-42',
    label: 'Issue 42', token, start: 0, end: token.length,
    composerReference: { pluginId: 'acme.composer.issue-dogfood', localId: 'issues' },
    composerReferenceTrigger: '@',
  } };
}
