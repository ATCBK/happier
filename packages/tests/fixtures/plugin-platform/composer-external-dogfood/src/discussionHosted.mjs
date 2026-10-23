import { createPluginUiRenderContext, applyPluginUiThemeCssVariables } from '@happier-dev/plugin-sdk/ui/client';
import {
  applyDiscussionParticipantReference,
  armDiscussionComposerRetirementProbe,
  createDeclaredIssueReferenceDraft,
  createDiscussionParticipantQuestion,
  probeDiscussionComposerRead,
} from './discussionComposer.mjs';

/** A DOM adapter for the same external-author scenario; the host owns all Composer state.
 * @param {HTMLElement} root
 */
export async function mountHostedDiscussionSurface(root) {
  const status = root.querySelector('[data-role="status"]');
  const output = root.querySelector('[data-role="snapshot"]');
  const participant = root.querySelector('input');
  if (!status || !output || !participant) throw new Error('discussion_fixture_shell_missing');
  /** @param {string} id */
  const button = (id) => {
    const found = Array.from(root.querySelectorAll('button')).find((entry) => entry.dataset.testid === id);
    if (!found) throw new Error('discussion_fixture_control_missing');
    return found;
  };
  const apply = button('discussion-helper-apply');
  const issue = button('discussion-helper-apply-issue');
  const focus = button('discussion-helper-focus');
  const lockButton = button('discussion-helper-lock');
  const forgedHome = button('discussion-helper-forged-home');
  const retire = button('discussion-helper-retire');
  const context = await createPluginUiRenderContext();
  applyPluginUiThemeCssVariables(context.surface.theme, document.documentElement);
  root.lang = context.surface.locale;
  root.dir = context.surface.direction;
  const { hostApi, signal } = context;
  const ref = await hostApi.activeComposer({ signal });
  if (ref?.kind !== 'discussion') {
    status.textContent = 'Open this control from an available Discussion composer.';
    return;
  }
  let snapshot = /** @type {import('@happier-dev/plugin-sdk/ui').ComposerSnapshotV1 | null} */ (null);
  let lock = /** @type {import('@happier-dev/plugin-sdk').Disposable | null} */ (null);
  /** @param {import('@happier-dev/plugin-sdk/ui').ComposerSnapshotV1} next */
  const show = (next) => {
    snapshot = next;
    output.textContent = `Draft revision ${next.revision}: ${next.text || '(empty)'}`;
    apply.disabled = !next.state.editable || !next.capabilities.references || participant.value.trim().length === 0;
    issue.disabled = !next.state.editable || !next.capabilities.references;
  };
  /** @param {() => Promise<void>} operation */
  const run = async (operation) => {
    try { await operation(); }
    catch (error) {
      const code = error !== null && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string' ? error.code : 'unknown';
      status.textContent = `Composer unavailable: ${code}`;
    }
  };
  signal.addEventListener('abort', () => {
    for (const control of root.querySelectorAll('button')) control.disabled = true;
    participant.disabled = true;
    status.textContent = 'This surface has retired.';
  }, { once: true });
  await hostApi.watchComposer(ref, show, { signal });
  const read = await hostApi.readComposer(ref, { signal });
  if (read.status !== 'ready') {
    status.textContent = `Composer: ${read.status}`;
    return;
  }
  show(read.snapshot);
  for (const control of [focus, lockButton, forgedHome, retire]) control.disabled = false;
  status.textContent = 'The host Composer is ready.';
  participant.addEventListener('input', () => { if (snapshot) show(snapshot); });
  apply.addEventListener('click', () => void run(async () => {
    const question = createDiscussionParticipantQuestion(participant.value.trim());
    const result = await applyDiscussionParticipantReference(hostApi, ref, { ...question.draft, reference: question.reference });
    status.textContent = result.status === 'applied'
      ? 'Participant mention applied. Close this control and use Send.' : `Composer: ${result.status}`;
  }));
  issue.addEventListener('click', () => void run(async () => {
    const result = await applyDiscussionParticipantReference(hostApi, ref, createDeclaredIssueReferenceDraft());
    status.textContent = `Issue reference: ${result.status}`;
  }));
  focus.addEventListener('click', () => void run(async () => {
    status.textContent = `Composer: ${(await hostApi.focusComposer(ref, { signal })).status}`;
  }));
  lockButton.addEventListener('click', () => void run(async () => {
    if (lock) {
      await lock.dispose();
      lock = null;
      lockButton.textContent = 'Lock input';
      status.textContent = 'Input unlocked';
    } else {
      lock = await hostApi.acquireComposerInputLock(ref, { mode: 'editAndSubmit', reason: 'External Discussion fixture' }, { signal });
      lockButton.textContent = 'Unlock input';
      status.textContent = 'Input locked';
    }
  }));
  forgedHome.addEventListener('click', () => void run(async () => {
    const result = await probeDiscussionComposerRead(hostApi, ref, true);
    console.info('external-composer-forged-home', JSON.stringify(result));
    status.textContent = JSON.stringify(result);
  }));
  retire.addEventListener('click', () => {
    if (!snapshot) return;
    armDiscussionComposerRetirementProbe(hostApi, ref, signal, snapshot);
    retire.disabled = true;
    status.textContent = 'Retirement probe armed. Close this control or withdraw this plugin.';
  });
}
