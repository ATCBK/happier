import { USAGE } from './serviceHelp';
import { resolveHappyHomeDirFromEnvironment } from '@happier-dev/cli-common/agents';

import { resolveCliSelectedAccountServicePresentation } from '@/auth/accountService/cliAccountServicePresentation';
import { createCliAccountServiceSessionOwner } from '@/auth/accountService/cliAccountServiceSession';
import {
  runCliAccountServiceSetupEntry,
  type CliAccountServiceSetupEntryOutcome,
} from '@/auth/accountService/cliAccountServiceSetupEntry';
import { isInteractiveTerminal, promptInput } from '@/terminal/prompts/promptInput';

export type AuthServiceCommandDeps = Readonly<{
  createSession?: typeof createCliAccountServiceSessionOwner;
  resolvePresentation?: typeof resolveCliSelectedAccountServicePresentation;
  runSetupEntry?: typeof runCliAccountServiceSetupEntry;
  isInteractiveTerminal?: typeof isInteractiveTerminal;
  promptInput?: typeof promptInput;
}>;


/** One plain sentence for each way a sign-in can end without a committed credential. */
function describeUnfinishedSignIn(outcome: Exclude<CliAccountServiceSetupEntryOutcome, { kind: 'signed_in' }>): string {
  switch (outcome.kind) {
    case 'account_service_unavailable':
      return 'That address did not answer as a sign-in service. Check the address and try again.';
    case 'identity_mismatch':
      return 'That sign-in service answered with a different identity than the one saved here. Check the address before signing in again.';
    case 'destination_mismatch':
      return 'The sign-in returned a credential for a different destination. Check the address before signing in again.';
    case 'key_required':
      return 'That account needs its account key to sign in on this computer.';
    case 'update_required':
      return 'This Happier version cannot sign in with that service. Update Happier and try again.';
    case 'timed_out':
      return 'Sign-in timed out before it completed.';
    case 'cancelled':
      return 'Sign-in was cancelled.';
    default:
      return 'Sign-in did not complete.';
  }
}

/**
 * The read/change/sign-out surface for the Account Service this CLI signs in
 * through. Every decision stays with its existing owner: the session owner holds
 * the selection and its restricted credential, the presentation owner verifies
 * the selected service's current identity and role, and the setup entry owner
 * performs discovery, selection and sign-in. This command only names the
 * subcommands and reports what those owners answered.
 */
export async function handleAuthServiceCommand(
  args: readonly string[],
  signal?: AbortSignal,
  deps: AuthServiceCommandDeps = {},
): Promise<void> {
  const createSession = deps.createSession ?? createCliAccountServiceSessionOwner;
  const resolvePresentation = deps.resolvePresentation ?? resolveCliSelectedAccountServicePresentation;
  const runSetupEntry = deps.runSetupEntry ?? runCliAccountServiceSetupEntry;
  const subcommand = args[0];

  if (subcommand === 'status') {
    if (args.length > 1) throw Object.assign(new Error(USAGE), { code: 'invalid_params' });
    const session = createSession({ happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env) });
    const selection = await session.readSelection();
    if (!selection) {
      console.log('No sign-in service is selected. Run `happier auth service use <endpoint>` to choose one.');
      return;
    }
    const presentation = await resolvePresentation({ ...(signal ? { signal } : {}) });
    if (!presentation) {
      // The pointer is stored, but the service did not verify as the same
      // Account-Service-capable identity it was selected as.
      console.log(`Selected sign-in service: ${selection.endpoint}`);
      console.log(`This service did not confirm its identity or sign-in role. Re-run \`happier auth service use ${selection.endpoint}\`.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Selected sign-in service: ${presentation.displayName}`);
    console.log(`  Endpoint: ${presentation.endpoint}`);
    console.log(`  Server identity: ${presentation.serverIdentityId}`);
    return;
  }

  if (subcommand === 'use') {
    const endpoint = args[1]?.trim();
    if (!endpoint || args.length > 2) throw Object.assign(new Error(USAGE), { code: 'invalid_params' });
    const interactive = (deps.isInteractiveTerminal ?? isInteractiveTerminal)();
    // Sign-in only: a still-valid stored credential is reused without asking,
    // and the Home directory journey (entering or focusing a Home) belongs to
    // `happier setup`, not to this command.
    const outcome = await runSetupEntry({
      endpoint,
      context: { kind: 'none' },
      stopAfter: 'sign_in',
      ...(interactive ? { promptInputFn: deps.promptInput ?? promptInput } : {}),
      ...(signal ? { signal } : {}),
    });
    if (outcome.kind === 'signed_in') {
      console.log(`Signed in to ${outcome.endpoint}.`);
      return;
    }
    if (!interactive && outcome.kind === 'cancelled') {
      console.log(`Signing in needs an interactive terminal. Run \`happier auth service use ${endpoint}\` in a terminal.`);
    } else {
      console.log(describeUnfinishedSignIn(outcome));
    }
    process.exitCode = 1;
    return;
  }

  if (subcommand === 'logout') {
    if (args.length > 1) throw Object.assign(new Error(USAGE), { code: 'invalid_params' });
    const session = createSession({ happyHomeDir: resolveHappyHomeDirFromEnvironment(process.env) });
    await session.logout();
    // `logout` drops the restricted credential and keeps the selection, so the
    // next sign-in returns to the same service without rediscovering it.
    console.log('Signed out of the selected service. Homes you already entered keep their own access.');
    return;
  }

  throw Object.assign(new Error(USAGE), { code: 'invalid_params' });
}
