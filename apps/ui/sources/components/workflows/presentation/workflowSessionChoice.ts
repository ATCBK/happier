import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { t } from '@/text';

/**
 * What a Session chooser can say about its candidates while it is open, from the option owner's
 * `sessionOptionsStatus` (`useWorkflowExistingSessionOptions`). A failed read is never an empty
 * Account: it says so and offers the retry; only a settled read without candidates is empty.
 */
export type WorkflowSessionChoice = 'offered' | 'loading' | 'failed' | 'empty';

export function resolveWorkflowSessionChoice(
  status: 'loading' | 'ready' | 'error' | undefined,
  offered: boolean,
): WorkflowSessionChoice {
  if (status === 'error') return 'failed';
  if (offered) return 'offered';
  return status === 'loading' ? 'loading' : 'empty';
}

/**
 * The "A session…" option of a select (Conversation, Runs in): its own reason in each state. A failed
 * read keeps the option choosable, and choosing it is the retry (the select stays open).
 */
export function workflowSessionOptionState(
  choice: WorkflowSessionChoice,
  emptyReason: string,
): Pick<DropdownMenuItem, 'disabled' | 'subtitle'> {
  switch (choice) {
    case 'offered':
      return {};
    case 'loading':
      return {
        disabled: true,
        subtitle: t('workflows.conversation.sessionsLoading'),
      };
    case 'failed':
      return { subtitle: t('workflows.conversation.sessionsFailedRetry') };
    case 'empty':
      return { disabled: true, subtitle: emptyReason };
  }
}

export const WORKFLOW_SESSION_RETRY_ITEM_ID = 'workflow-session-choice:retry';

/**
 * A menu that lists the Sessions themselves (built-ins, examples): loading and empty are its quiet
 * empty line; a failed read leads with one Try again row above whatever it already knows.
 */
export function workflowSessionMenuState(
  choice: WorkflowSessionChoice,
  emptyLabel: string,
): Readonly<{
  emptyLabel?: string;
  leadingItems: readonly DropdownMenuItem[];
}> {
  switch (choice) {
    case 'offered':
      return { leadingItems: [] };
    case 'loading':
      return {
        emptyLabel: t('workflows.conversation.sessionsLoading'),
        leadingItems: [],
      };
    case 'empty':
      return { emptyLabel, leadingItems: [] };
    case 'failed':
      return {
        emptyLabel,
        leadingItems: [
          {
            id: WORKFLOW_SESSION_RETRY_ITEM_ID,
            title: t('workflows.conversation.retryLoadingSessions'),
            subtitle: t('workflows.conversation.sessionsFailed'),
          },
        ],
      };
  }
}
