import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

// Read only the authorized QA CLI log directory. Never inspect credential files.
const code = String.raw`
import fs from 'node:fs';
const dir='/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/cli/logs';
const from=Date.parse('2026-10-17T22:38:00Z'),to=Date.parse('2026-10-17T22:46:00Z');
const rows=[];
for(const name of fs.readdirSync(dir)) {
  if(!name.endsWith('.log')||name.includes('-daemon.log'))continue;
  const path=dir+'/'+name,stat=fs.statSync(path);
  if(stat.mtimeMs<from||stat.mtimeMs>to)continue;
  const lines=fs.readFileSync(path,'utf8').split('\n');
  const diagnostics=[];
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    // Emit only recognized content-free diagnostic classes and enum codes.
    // A missing diagnostic is not proof that the original failure had no cause.
    const classes=['TypeError','ReferenceError','SyntaxError','MACHINE_RPC_TIMEOUT','ECONNREFUSED','ETIMEDOUT',
      'RPC_FORBIDDEN','target_unavailable','action_failed','server_scope_mismatch','not_authenticated',
      'projects.worker.status','mcp serve'].filter(value=>line.includes(value));
    if(classes.length)diagnostics.push({line:i+1,classes});
  }
  rows.push({path,mtime:new Date(stat.mtimeMs).toISOString(),bytes:stat.size,lineCount:lines.length,diagnostics});
}
console.log(JSON.stringify({at:new Date().toISOString(),dir,window:{from,to},rows}));`;
const child = spawn(process.execPath, ['apps/stack/scripts/repo_local.mjs', 'dev-targets', 'exec', 'nl1',
  '--', 'node', '--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '', stderrBytes = 0;
child.stdout.on('data', value => { stdout += value; });
child.stderr.on('data', value => { stderrBytes += value.length; });
const exit = await new Promise(resolve => child.once('close', resolve));
const line = stdout.split('\n').findLast(value => value.startsWith('{'));
const result = { exit, stderrBytes, ...(line ? JSON.parse(line) : { noResult: true }) };
await writeFile(new URL('./historical-errors.json', import.meta.url), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = exit ?? 1;
