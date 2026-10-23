import { staticCommandDescriptors } from './commandDescriptors';
import { ensureWindowsUtf8CodePage } from '@/utils/platform/windows/ensureWindowsUtf8CodePage';
import { installConsoleWriteErrorGuards, shouldInstallConsoleWriteErrorGuards } from '@/utils/writeConsoleBestEffort';
import { takeCliApiTokenEnvironment } from '@/auth/cliApiTokenEnvironment';
import { argvBeforeOptionTerminator, isFamilyHelpRequest } from './processArgs';
import { BUNDLED_ACTION_CLI_COMMAND_PATHS } from '@/plugins/projection/registry/sources/generatedBundledPluginManifests';
import { resolveCliHappyHomeDir } from '@/configuration/resolveCliHappyHomeDir';
import { printJsonEnvelope, wantsJson } from './output/jsonEnvelope';

/** Help references live beside the command registration, never in an alternate registry. */
export async function tryPrintFamilyHelp(args: readonly string[]): Promise<boolean> {
  if (!isFamilyHelpRequest(args)) return false;
  const descriptor = staticCommandDescriptors[args[0] ?? ''];
  const help = descriptor?.help;
  const actionRoot = BUNDLED_ACTION_CLI_COMMAND_PATHS.some((command) => command.path[0] === args[0]);
  const controls = argvBeforeOptionTerminator(args);
  if (controls[1] === 'help' && !controls.some((arg) => arg === '--help' || arg === '-h')) {
    // Positional roots (send, resume, attach, …) never acquired a `help`
    // subcommand. Only a registered family or an Action namespace owns it.
    const acceptsHelpSubcommand = descriptor
      ? descriptor.helpSubcommand === true
      : actionRoot && !BUNDLED_ACTION_CLI_COMMAND_PATHS.some((command) => command.path[0] === args[0] && command.path.length === 1);
    if (!acceptsHelpSubcommand) return false;
  }
  const pluginHelp = !help && !actionRoot
    ? await (await import('./pluginCommandHelp')).resolveReadOnlyPluginCommandHelp(args, resolveCliHappyHomeDir(process.env)) : null;
  if (!help && !actionRoot && pluginHelp === null) return false;
  ensureWindowsUtf8CodePage();
  if (shouldInstallConsoleWriteErrorGuards({ processVersions: process.versions })) installConsoleWriteErrorGuards();
  takeCliApiTokenEnvironment();
  if (pluginHelp !== null) {
    if (wantsJson(args)) await printJsonEnvelope({ ok: true, kind: 'plugin_command_help', data: { root: args[0], text: pluginHelp } });
    else console.log(pluginHelp);
    return true;
  }
  if (actionRoot) {
    const { printPublishedActionCliHelp } = await import('./actions/publishedHelp');
    if (await printPublishedActionCliHelp(args, { exactOnly: true })) return true;
  }
  if (help) {
    await help({ args: [...args], rawArgv: ['happier', ...args], terminalRuntime: null });
    return true;
  }
  if (actionRoot) return await (await import('./actions/publishedHelp')).printPublishedActionCliHelp(args);
  return false;
}
