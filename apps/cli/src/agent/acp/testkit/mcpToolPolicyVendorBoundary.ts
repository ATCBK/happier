import { createServer } from 'node:http';
import { join } from 'node:path';
import type { AcpMcpPolicyVendorBoundary } from './mcpToolPolicyHarness';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/** Only the model service is simulated. Installed CLIs discover, approve and execute MCP tools. */
export function createLocalModelVendorBoundary(executablePath: string, protocol: 'google' | 'openai'): AcpMcpPolicyVendorBoundary {
  let cwd = '';
  const server = createServer(async (incoming, response) => {
    try {
      if (incoming.method === 'HEAD' || incoming.method === 'OPTIONS') {
        console.log(JSON.stringify({ vendorModelConnectivity: incoming.method, url: incoming.url }));
        response.writeHead(204); response.end(); return;
      }
      if (incoming.method === 'GET') {
        console.log(JSON.stringify({ vendorModelDiscovery: incoming.url }));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-pro',
          supportedGenerationMethods: ['generateContent', 'countTokens'] }] }));
        return;
      }
      let raw = ''; for await (const chunk of incoming) raw += String(chunk);
      const body = record(JSON.parse(raw));
      const messages = array(protocol === 'google' ? body.contents : body.messages).map(record);
      const users = messages.filter(message => message.role === 'user' && (typeof message.content === 'string'
        || array(message.parts).some(part => typeof record(part).text === 'string')
        || array(message.content).some(part => typeof record(part).text === 'string')));
      const lastUser = users.at(-1);
      const text = protocol === 'google' ? array(lastUser?.parts).map(part => record(part).text).join('')
        : typeof lastUser?.content === 'string' ? lastUser.content : array(lastUser?.content).map(part => record(part).text).join('');
      let request: Record<string, unknown> = {};
      try { request = record(JSON.parse(text)); } catch {
        const starts = [text.lastIndexOf('{"server"'), text.lastIndexOf('{"kind"')].filter(index => index >= 0);
        if (starts.length) {
          const start = Math.max(...starts);
          let depth = 0; let quoted = false; let escaped = false;
          for (let index = start; index < text.length; index++) {
            const character = text[index];
            if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; }
            else if (character === '"') quoted = true;
            else if (character === '{') depth++;
            else if (character === '}' && --depth === 0) {
              try { request = record(JSON.parse(text.slice(start, index + 1))); } catch {}
              break;
            }
          }
        }
      }
      const afterUser = lastUser ? messages.slice(messages.lastIndexOf(lastUser) + 1) : [];
      const hasToolResult = afterUser.some(message => message.role === 'tool' || array(message.parts).some(part => 'functionResponse' in record(part)));
      const tools = protocol === 'google' ? array(body.tools).flatMap(group => array(record(group).functionDeclarations)).map(record)
        : array(body.tools).map(tool => record(record(tool).function));
      const names = tools.map(tool => String(tool.name));
      const shell = request.kind === 'shell';
      const desiredServer = String(request.server ?? '');
      const desiredTool = String(request.tool ?? '');
      const name = shell ? names.find(name => ['bash', 'run_shell_command', 'shell'].includes(name))
        : (desiredServer && desiredTool ? names.find(name => name.endsWith(`${desiredServer.replace(/[^a-zA-Z0-9_-]/g, '_')}_${desiredTool.replace(/[^a-zA-Z0-9_-]/g, '_')}`)) : undefined)
          ?? (desiredTool ? names.find(name => name === desiredTool) : undefined);
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(join(cwd, 'capture.json.shell'))}, JSON.stringify({argv:process.argv,env:process.env}))`)}`;
      const args = shell ? { command, description: 'Observe isolated test process environment' } : record(request.arguments);
      console.log(JSON.stringify({ vendorModelRequest: incoming.url, requested: request, names, selected: name, hasToolResult }));
      const call = !hasToolResult && name;
      if (protocol === 'google') {
        if (incoming.url?.includes(':countTokens')) {
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"totalTokens":1}'); return;
        }
        const chunk = { candidates: [{ index: 0, content: { role: 'model', parts: call ? [{ functionCall: { name, args } }]
          : [{ text: 'Fixture turn complete.' }] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } };
        const streaming = incoming.url?.includes(':streamGenerateContent');
        response.writeHead(200, { 'content-type': streaming ? 'text/event-stream' : 'application/json' });
        response.end(streaming ? `data: ${JSON.stringify(chunk)}\n\n` : JSON.stringify(chunk));
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: 'Fixture turn complete.' };
        const chunk = { id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] };
        response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      }
    } catch (error) { console.error(error); response.writeHead(500); response.end(String(error)); }
  });
  return {
    executablePath,
    async prepare(input) {
      cwd = input.cwd;
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local model fixture has no port');
      const base = `http://127.0.0.1:${address.port}`;
      const trace = { HAPPIER_MCP_VENDOR_TRACE_FILE: `/tmp/happier-p7f-acp-${protocol}-${process.pid}-vendor-trace.jsonl` };
      console.log(JSON.stringify({ vendorTraceFile: trace.HAPPIER_MCP_VENDOR_TRACE_FILE, executablePath }));
      return protocol === 'google' ? { ...trace, GEMINI_API_KEY: 'fixture-not-a-credential', GOOGLE_GEMINI_BASE_URL: base,
        GEMINI_TELEMETRY_ENABLED: 'false', GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_MODEL: 'gemini-2.5-pro' } : { ...trace,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'fixture/fixture',
          provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Local fixture', options: { baseURL: `${base}/v1`, apiKey: 'fixture-not-a-credential' },
            models: { fixture: { name: 'fixture', limit: { context: 128000, output: 8000 } } } } } }),
        KILO_CONFIG_CONTENT: JSON.stringify({ model: 'fixture/fixture',
          provider: { fixture: { npm: '@ai-sdk/openai-compatible', name: 'Local fixture', options: { baseURL: `${base}/v1`, apiKey: 'fixture-not-a-credential' },
            models: { fixture: { name: 'fixture', limit: { context: 128000, output: 8000 } } } } } }),
        OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_SHARE: 'true',
        OPENAI_API_KEY: 'fixture-not-a-credential', OPENAI_BASE_URL: `${base}/v1`, OPENAI_MODEL: 'fixture',
      };
    },
    async dispose() { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
