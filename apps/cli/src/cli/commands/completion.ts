import type { CommandContext } from '@/cli/commandRegistry';
import { COMPLETION_USAGE } from './completionHelp';
import { resolveCliHappyHomeDir } from '@/configuration/resolveCliHappyHomeDir';
import { resolveCommandPathCompletionCandidates } from '@/cli/commandCompletionPaths';

const scripts = Object.freeze({
  bash: `_happier_completion() {
  local candidate
  COMPREPLY=()
  while IFS= read -r candidate; do
    COMPREPLY+=("$candidate")
  done < <(happier completion candidates -- "\${COMP_WORDS[@]:1}" 2>/dev/null)
}
complete -F _happier_completion happier`,
  zsh: `#compdef happier
_happier_completion() {
  local -a candidates
  candidates=("\${(@f)$(happier completion candidates -- "\${words[@]:1}" 2>/dev/null)}")
  compadd -- "\${candidates[@]}"
}
compdef _happier_completion happier`,
  fish: `function __happier_completion
  set -l words (commandline -xpc)
  happier completion candidates -- $words[2..] 2>/dev/null
end
complete -c happier -f -a '(__happier_completion)'`,
  powershell: `Register-ArgumentCompleter -Native -CommandName happier -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object {
    $element = $_
    # Dequote literal strings, but never evaluate expandable AST nodes during completion.
    if ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
      $element.Value
    } else {
      $element.Extent.Text
    }
  })
  happier completion candidates -- @words 2>$null
}`,
});

export async function handleCompletionCliCommand(context: CommandContext): Promise<void> {
  if (context.args.includes('--help') || context.args.includes('-h')) { console.log(COMPLETION_USAGE); return; }
  const args = context.args.slice(1);
  if (args[0] === 'candidates') {
    const separator = args.indexOf('--');
    const words = separator >= 0 ? args.slice(separator + 1) : args.slice(1);
    if (words.length <= 1) {
      const { resolveRootCommandNames } = await import('@/cli/rootHelp');
      const roots = await resolveRootCommandNames(resolveCliHappyHomeDir(process.env));
      const candidates = resolveCommandPathCompletionCandidates(roots.map((root) => [root]), words);
      if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
      return;
    }
    const [{ resolveCommandCompletionCandidates }, { resolveReadOnlyCommandCompletionDeclarations }] = await Promise.all([
      import('@/cli/commandRegistry'), import('@/cli/rootHelp'),
    ]);
    const declarations = await resolveReadOnlyCommandCompletionDeclarations(resolveCliHappyHomeDir(process.env), words);
    const candidates = await resolveCommandCompletionCandidates(words, {
      declarations,
      resolveDynamicOptions: async (request) => (await import('./completionDynamicOptions')).resolveActionDynamicOptionsForCliCompletion(request),
      resolveDynamicActionDefinition: async (actionId, argv) => (await import('./actions')).resolveActionDefinitionForCliCompletion(actionId, argv),
    });
    if (candidates.length > 0) process.stdout.write(`${candidates.join('\n')}\n`);
    return;
  }
  const shell = args[0] as keyof typeof scripts | undefined;
  if (!shell || !Object.prototype.hasOwnProperty.call(scripts, shell)) {
    throw new Error(COMPLETION_USAGE);
  }
  process.stdout.write(`${scripts[shell]}\n`);
}
