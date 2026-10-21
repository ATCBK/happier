// External stdio boundary used by the host integration tests.
const fs = require('node:fs');
const log = process.argv[2];
const options = JSON.parse(process.argv[3] || '{}');
let input = Buffer.alloc(0), registered = false, queued = [], documents = new Map(), pending = new Map(), externalDiagnosticMessage, progressRequest, commandRequest;
const record = value => fs.appendFileSync(log, JSON.stringify(value) + '\n');
const send = value => { const json = JSON.stringify({jsonrpc:'2.0', ...value}); process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`); };
const reply = (id, result) => send({id, result});
const range = {start:{line:0,character:0},end:{line:0,character:1}};
const answer = message => {
  if (message.method === 'shutdown') {reply(message.id,null);return;}
  const uri = message.params?.textDocument?.uri;
  const document = documents.get(uri);
  if (options.requiredLanguageId && document?.languageId !== options.requiredLanguageId) {
    send({id:message.id,error:{code:-32602,message:'The document language id is unsupported'}});return;
  }
  if (message.method === 'textDocument/hover') reply(message.id, {contents:{kind:'markdown',value:document?.text || ''},range});
  if (message.method === 'textDocument/definition') reply(message.id, [{uri,range}]);
  if (message.method === 'textDocument/references') reply(message.id, options.referenceCount ? Array.from({length:options.referenceCount},(_,line)=>({uri,range:{start:{line,character:0},end:{line,character:1}}})) : [{uri,range}]);
  if (message.method === 'textDocument/documentSymbol') reply(message.id, [{name:'fixture',kind:12,range,selectionRange:range}]);
  if (message.method === 'textDocument/rename') {
    const edit={range:{start:{line:0,character:0},end:{line:0,character:3}},newText:message.params.newName};
    if(message.params.newName==='orderedInserts') {reply(message.id,{changes:{[uri]:[{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'},{range:{start:{line:0,character:0},end:{line:0,character:0}},newText:'x'}]}});return;}
    const target=message.params.newName==='outside'?new URL('../outside.ts',uri).href:new URL('b.ts',uri).href;
    reply(message.id,{documentChanges:[{textDocument:{uri,version:null},edits:[edit]}, {textDocument:{uri:target,version:null},edits:message.params.newName==='overlap'?[edit,edit]:[edit]}]});
  }
  if (message.method === 'textDocument/prepareRename') reply(message.id,{range:{start:{line:0,character:0},end:{line:0,character:3}},placeholder:'old'});
  if (message.method === 'textDocument/codeAction') {
    if(options.requireDiagnosticContext&&!message.params.context?.diagnostics?.some(diagnostic=>diagnostic.code===2322&&diagnostic.data?.fixToken==='native-fixture')){reply(message.id,[]);return;}
    const edit=options.commandDirectEdits?{documentChanges:[{textDocument:{uri:new URL('b.ts',uri).href,version:null},edits:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'mid'}]},{kind:'rename',oldUri:uri,newUri:new URL('moved.ts',uri).href}]}:undefined;
    reply(message.id,[{title:'Fix fixture',kind:'quickfix',...(edit?{edit}:{}),command:{title:'Fix fixture',command:'fixture.fix',arguments:[uri]}}]);
  }
  if (message.method === 'workspace/executeCommand') {
    if (options.delayCommand) {pending.set(message.id,message);return;}
    commandRequest=message;
    const target=new URL(options.refuseCommandEdit?'../outside.ts':'b.ts',message.params.arguments[0]).href;
    send({id:'server-edit',method:'workspace/applyEdit',params:{edit:{changes:{[target]:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'fixed'}]}}}});
  }
  if (message.method === 'textDocument/diagnostic') {
    if (externalDiagnosticMessage && options.failRefreshDiagnosticPath && uri?.endsWith('/'+options.failRefreshDiagnosticPath)) send({id:message.id,error:{code:-32000,message:'fixture refresh failed'}});
    else reply(message.id, {kind:'full',items:externalDiagnosticMessage || document?.text.includes('broken') ? [{range,severity:1,message:externalDiagnosticMessage || document.text,code:2322,source:'fixture',...(options.requireDiagnosticContext?{data:{fixToken:'native-fixture'},tags:[1]}:{})}] : []});
  }
};
const receive = (message, fromQueue = false) => {
  if (!fromQueue) record(message);
  if (message.id === 'registration' && !message.method) { registered = true; for (const item of queued.splice(0)) receive(item,true); return; }
  if (message.id === 'server-edit' && !message.method && commandRequest) {reply(commandRequest.id,message.result);commandRequest=undefined;return;}
  if (message.id === 'progress-create' && !message.method && progressRequest) {
    send({method:'$/progress',params:{token:progressRequest.token,value:{kind:'begin',title:'Loading fixture'}}});
    reply(progressRequest.id,null);progressRequest=undefined;return;
  }
  if (message.method === 'initialize') {
    if (options.stallInitialize) return;
    if (options.failInitialize) { send({id:message.id,error:{code:-32000,message:'fixture initialization failed'}}); return; }
    reply(message.id,{capabilities:{positionEncoding:'utf-16',textDocumentSync:{openClose:true,change:options.syncKind ?? 2},hoverProvider:true,definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,...(options.semanticEdits ? {renameProvider:{prepareProvider:true},codeActionProvider:true,executeCommandProvider:{commands:['fixture.fix']},workspace:{fileOperations:{willRename:{filters:[]},didRename:{filters:[]}}}}:{}),...(options.diagnosticsMode === 'push' ? {} : {diagnosticProvider:{interFileDependencies:true,workspaceDiagnostics:false}})}}); return;
  }
  if (message.method === 'initialized') { send({id:'registration',method:'client/registerCapability',params:{registrations:options.watching === false ? [] : [{id:'files',method:'workspace/didChangeWatchedFiles',registerOptions:{watchers:[{globPattern:'**/*'}]}}]}}); return; }
  if (message.method === 'shutdown') {
    if (options.pushOnShutdown) for (const [uri,document] of documents) send({method:'textDocument/publishDiagnostics',params:{uri,version:document.version,diagnostics:[{range,severity:1,message:options.pushOnShutdown}]}});
    if (options.delayShutdown) pending.set(message.id,message);
    else reply(message.id,null);
    return;
  }
  if (message.method === 'exit') { process.exit(0); }
  if (!registered) { queued.push(message); return; }
  if (message.method === 'textDocument/didOpen') documents.set(message.params.textDocument.uri,message.params.textDocument);
  if (message.method === 'textDocument/didClose') documents.delete(uriOf(message));
  if (message.method === 'textDocument/didChange') {
    const previous=documents.get(uriOf(message));const change=message.params.contentChanges[0];
    if (previous) {const offset=p=>previous.text.split(/\r\n|\r|\n/).slice(0,p.line).reduce((a,l)=>a+l.length+1,0)+p.character;previous.text=change.range?previous.text.slice(0,offset(change.range.start))+change.text+previous.text.slice(offset(change.range.end)):change.text;previous.version=message.params.textDocument.version;}
  }
  if (message.method === 'workspace/didChangeWatchedFiles') {externalDiagnosticMessage=options.externalDiagnosticMessage;send({id:'refresh',method:'workspace/diagnostic/refresh'});}
  if (message.method === '$/cancelRequest') {const request=pending.get(message.params.id);if(request){pending.delete(message.params.id);send({id:request.id,error:{code:-32800,message:'RequestCancelled'}});}}
  if (message.method === 'fixture/release') {for(const [id,request] of pending){if(!message.params?.method||request.method===message.params.method){answer(request);pending.delete(id);}}}
  if (message.method === 'fixture/publishDiagnostics') send({method:'textDocument/publishDiagnostics',params:message.params});
  if (message.method === 'fixture/progress') {
    if (message.params.kind === 'begin') {progressRequest={id:message.id,token:message.params.token};send({id:'progress-create',method:'window/workDoneProgress/create',params:{token:message.params.token}});}
    else {send({method:'$/progress',params:{token:message.params.token,value:{kind:'end'}}});reply(message.id,null);}
  }
  if (message.method === 'fixture/barrier') reply(message.id,null);
  if (message.method === 'fixture/unsolicitedEdit') { commandRequest=message;send({id:'server-edit',method:'workspace/applyEdit',params:{edit:{changes:{[message.params.uri]:[{range,newText:'bad'}]}}}}); }
  if (message.method === 'workspace/willRenameFiles') {
    const target=new URL('b.ts',message.params.files[0].oldUri).href;
    reply(message.id,{changes:{[target]:[{range:{start:{line:0,character:0},end:{line:0,character:3}},newText:'updated'}]}});
  }
  if (message.method === 'workspace/executeCommand') answer(message);
  if (message.method?.startsWith('textDocument/') && message.id !== undefined) {
    if (options.crashOnHover && message.method === 'textDocument/hover') process.exit(2);
    if ((options.delayHover && message.method === 'textDocument/hover') || (options.delayDiagnostic && message.method === 'textDocument/diagnostic' && (!options.delayDiagnosticPath || uriOf(message)?.endsWith('/'+options.delayDiagnosticPath)))) pending.set(message.id,message);
    else answer(message);
  }
};
const uriOf=message=>message.params?.textDocument?.uri;
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const end=input.indexOf('\r\n\r\n');if(end<0)return;const length=Number(/Content-Length:\s*(\d+)/i.exec(input.subarray(0,end).toString())[1]);if(input.length<end+4+length)return;const body=input.subarray(end+4,end+4+length);input=input.subarray(end+4+length);receive(JSON.parse(body.toString()));}});
