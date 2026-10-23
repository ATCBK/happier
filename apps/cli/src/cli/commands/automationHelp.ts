import chalk from 'chalk';

export function showAutomationHelp(): void {
  console.log(`
${chalk.bold('happier automation')} - Manage automations

${chalk.bold('Usage:')}
  happier automation list [--cursor <opaque>] [--json]
  happier automation run <automation-id> [--idempotency-key <key>] [--json]

${chalk.bold('Commands:')}
  list   List automations with their stable IDs
  run    Queue an immediate run through the automation's existing assignments

${chalk.bold('Options:')}
  --cursor <opaque>        Continue listing from an opaque cursor
  --idempotency-key <key>  Reuse the same run when a trigger occurrence is retried
  --json                   Print a machine-readable result
`);
}

