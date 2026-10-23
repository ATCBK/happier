import type { CommandContext, CommandHandler } from './commandRegistry';
import { argvBeforeOptionTerminator } from './commands/shared/argvFlags';

export type FirstClassSessionCommandDescriptor = Readonly<{
  command: string;
  aliases?: readonly string[];
  sessionPath: readonly string[];
  rootHelpLabel: string;
  rootHelpDescription: string;
  handler: CommandHandler;
}>;

function delegateToSessionCommand(sessionPath: readonly string[]): CommandHandler {
  return async (context: CommandContext) => {
    if (argvBeforeOptionTerminator(context.args.slice(1)).some((arg) => arg === '--help' || arg === '-h')) {
      const [
        { formatFirstClassSessionCommandHelp },
        { emitSessionHelp, inferSessionKind },
      ] = await Promise.all([
        import('./commands/session/shared/sessionCommandUsage'),
        import('./commands/session/shared/sessionHelpOutput'),
      ]);
      const command = context.args[0] ?? sessionPath[0] ?? 'session';
      await emitSessionHelp({
        help: formatFirstClassSessionCommandHelp({ command, sessionPath }),
        json: argvBeforeOptionTerminator(context.args).includes('--json'),
        kind: inferSessionKind(sessionPath),
      });
      return;
    }
    const { handleSessionCliCommand } = await import('./commands/session');
    await handleSessionCliCommand({
      ...context,
      args: ['session', ...sessionPath, ...context.args.slice(1)],
    });
  };
}

/**
 * A first-class root whose canonical owner is a compiled Action command. It
 * projects argv into that one owner — parser, help and Action invocation all
 * come from the compiled descriptor, so the root spelling adds no grammar.
 */
function delegateToCompiledActionCliCommand(commandPath: readonly [string, ...string[]]): CommandHandler {
  return async (context: CommandContext) => {
    const [{ resolveAdmittedActionCliCommand }, { runCompiledActionCliCommand }] = await Promise.all([
      import('./commandRegistry'),
      import('./actions/executeCommand'),
    ]);
    // A first-class alias (currently `ls`) reaches the same handler as its
    // canonical root. Preserve the spelling the user invoked so the registry
    // selects that alias descriptor and help/JSON kinds describe the actual
    // command, while both descriptors still execute the same Action.
    const invokedRoot = context.args[0] ?? commandPath[0];
    const argv = [invokedRoot, ...commandPath.slice(1), ...context.args.slice(1)];
    const command = await resolveAdmittedActionCliCommand(argv);
    if (!command) {
      throw new Error(`No Action owns the command \`happier ${commandPath.join(' ')}\``);
    }
    await runCompiledActionCliCommand({
      command,
      argv,
      ...(context.signal ? { signal: context.signal } : {}),
    });
  };
}

/** First-class commands only project argv into the canonical session owner. */
export const FIRST_CLASS_SESSION_COMMANDS: readonly FirstClassSessionCommandDescriptor[] = Object.freeze([
  {
    command: 'spawn',
    sessionPath: ['create'],
    rootHelpLabel: 'happier spawn [options]',
    rootHelpDescription: 'Create a session',
    handler: delegateToSessionCommand(['create']),
  },
  {
    command: 'list',
    aliases: ['ls'],
    sessionPath: ['list'],
    rootHelpLabel: 'happier list [options]',
    rootHelpDescription: 'List sessions',
    handler: delegateToCompiledActionCliCommand(['list']),
  },
  {
    command: 'send',
    sessionPath: ['send'],
    rootHelpLabel: 'happier send <session> <message>',
    rootHelpDescription: 'Send a message to a session',
    // `session.message.send` owns this spelling; root dispatch resolves the
    // compiled `send` alias directly, and this handler reaches the same owner
    // for any caller that enters through the registry entry instead.
    handler: delegateToCompiledActionCliCommand(['send']),
  },
  {
    command: 'history',
    sessionPath: ['history'],
    rootHelpLabel: 'happier history <session> [options]',
    rootHelpDescription: 'Read or follow a session transcript',
    handler: delegateToSessionCommand(['history']),
  },
  {
    command: 'wait',
    sessionPath: ['wait'],
    rootHelpLabel: 'happier wait <session> [options]',
    rootHelpDescription: 'Wait for a session to become idle',
    handler: delegateToCompiledActionCliCommand(['wait']),
  },
  {
    command: 'stop',
    sessionPath: ['stop'],
    rootHelpLabel: 'happier stop <session>',
    rootHelpDescription: 'Stop a session',
    handler: delegateToCompiledActionCliCommand(['stop']),
  },
  {
    command: 'delegate',
    sessionPath: ['delegate', 'start'],
    rootHelpLabel: 'happier delegate <session> <instructions> --agent <agent>',
    rootHelpDescription: 'Delegate work from a session',
    handler: delegateToSessionCommand(['delegate', 'start']),
  },
]);
