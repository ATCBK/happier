import { mountHostedDiscussionSurface } from '../../../../src/discussionHosted.mjs';

const root = document.getElementById('root');
if (root) {
  void mountHostedDiscussionSurface(root).catch((error: unknown) => {
    const code = error !== null && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' ? error.code : 'unknown';
    const status = root.querySelector('[data-role="status"]');
    if (status) status.textContent = `Composer unavailable: ${code}`;
  });
}
