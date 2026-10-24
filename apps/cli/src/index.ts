#!/usr/bin/env node

/**
 * CLI entry point for happier command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import { isFamilyHelpRequest, isTopLevelHelpRequest, readCliProcessArgs } from './cli/processArgs';
import { isTopLevelVersionRequest, printCliVersion } from './cli/version';

const isCliDistIntegrityProbe = process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE === '1';

if (!isCliDistIntegrityProbe && isTopLevelVersionRequest(readCliProcessArgs())) {
  printCliVersion();
} else {
  // A pending Promise alone does not keep Node alive. Keep the CLI process
  // referenced until async command dispatch (including install cleanup) settles.
  const cliLifetimeKeepAlive = isCliDistIntegrityProbe ? null : setInterval(() => undefined, 60_000);
  const runBootstrap = () => import('./cli/bootstrap').then(async ({ runCliBootstrap }) => {
    if (!isCliDistIntegrityProbe) await runCliBootstrap(import.meta.url);
  });
  const dispatch = !isCliDistIntegrityProbe && isTopLevelHelpRequest(readCliProcessArgs())
    ? import('./cli/rootHelp').then(({ printRootHelp }) => printRootHelp())
    : !isCliDistIntegrityProbe && isFamilyHelpRequest(readCliProcessArgs())
      ? import('./cli/familyHelp').then(async ({ tryPrintFamilyHelp }) => {
        if (!await tryPrintFamilyHelp(readCliProcessArgs())) await runBootstrap();
      })
      : runBootstrap();
  void dispatch.catch((error) => {
      // Bootstrap's own failures retain its logger/formatting; a failed module
      // import must be reported without importing the same graph again.
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      if (process.env.DEBUG) console.error(error);
      process.exitCode = 1;
    })
    .finally(() => {
      if (cliLifetimeKeepAlive !== null) clearInterval(cliLifetimeKeepAlive);
    });
}
