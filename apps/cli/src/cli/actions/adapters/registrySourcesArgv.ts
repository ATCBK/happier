import {findCompiledActionCliCommand,listCompiledActionCliCommands} from '../compiledCommands';
import {runCompiledActionCliCommand,type ActionCliExecutionDeps} from '../executeCommand';
/** The create preview is the safe detector Action; this adapter only selects its compiled leaf. */
export async function tryHandleRegistrySourceCliCommand(params:Readonly<{argv:readonly string[];signal?:AbortSignal;actionExecutionDeps?:Partial<ActionCliExecutionDeps>}>):Promise<boolean>{
  if(params.argv[0]!=='registries'||params.argv[1]!=='add'||!params.argv.includes('--dry-run'))return false;
  const command=findCompiledActionCliCommand(['registries','sources','detect'],listCompiledActionCliCommands());
  if(!command)throw new Error('Registry detection Action is unavailable');
  await runCompiledActionCliCommand({command,argv:[...command.path,...params.argv.slice(2).filter(token=>token!=='--dry-run')],signal:params.signal,deps:params.actionExecutionDeps});
  return true;
}
