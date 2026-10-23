import { SESSION_RESUME_HELP_LABEL } from './session/shared/sessionCommandLabels';

export const RESUME_USAGE = 'Usage: happier resume <sessionId>';

export function printResumeHelp(): void {
  console.log(SESSION_RESUME_HELP_LABEL);
  console.log('');
  console.log('Attaches to a running session, or resumes a stopped session when supported.');
}
