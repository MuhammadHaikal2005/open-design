/**
 * Optional real-CLI regression: set OD_TEST_OPENCODE_BIN to the bundled OpenCode
 * executable. All requests go to a local mock; isolated homes protect live runs.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOpenCodeByokProviderConfig } from '../../src/runtimes/byok-opencode.js';

const binary = process.env.OD_TEST_OPENCODE_BIN;
describe.skipIf(!binary)('BYOK reliability through bundled OpenCode', () => {
  it.each(['valid', 'empty-once', 'truncated-once', 'tool-once', 'empty-always', 'streaming'])(
    '%s summary preserves normal generation and history safety', async (scenario) => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'od-byok-cli-'));
      const seen: { limit: number; summary: boolean; title: boolean; tools: number; choice: unknown; thinking: unknown; marker: unknown }[] = [];
      let main = 0, summaries = 0;
      const server = createServer(async (request, response) => {
        let raw = '';
        for await (const chunk of request) raw += chunk;
        if (request.method !== 'POST') { response.end('{"data":[]}'); return; }
        const body = JSON.parse(raw);
        const limit = body.max_tokens ?? body.max_completion_tokens;
        const title = JSON.stringify(body.messages).includes('title generator');
        const summary = limit === 16384;
        if (summary) summaries++; else if (!title) main++;
        seen.push({ limit, title, summary, tools: body.tools?.length ?? 0,
          choice: body.tool_choice, thinking: body.chat_template_kwargs?.enable_thinking,
          marker: request.headers['x-od-summary-only'] ?? request.headers['x-od-activity-stage'] });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta: object, finish: string | null = null, usage?: object) => response.write('data: ' + JSON.stringify({
          id: 'mock', object: 'chat.completion.chunk', created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }], usage,
        }) + '\n\n');
        if (scenario === 'streaming' && !title && !summary && main === 1) {
          emit({ reasoning_content: 'private first reasoning' });
          await new Promise((resolve) => setTimeout(resolve, 10500));
          emit({ reasoning_content: 'private later reasoning' });
        }
        const empty = summary && (scenario === 'empty-always' || (scenario === 'empty-once' && summaries === 1));
        const truncated = summary && scenario === 'truncated-once' && summaries === 1;
        const tools = summary && scenario === 'tool-once' && summaries === 1;
        const content = summary ? 'Objective: finish this local test. Completed: first normal generation. Working files are unchanged. Remaining: resume the normal tool-enabled task and reply OK. No external services, real API keys, or user projects are involved.' : 'OK';
        emit(tools ? { tool_calls: [{ index: 0, id: 'bad-summary-tool', type: 'function', function: { name: 'todowrite', arguments: '{"todos":[]}' } }] } : empty ? { reasoning_content: 'No visible checkpoint' } : { content });
        emit({}, tools ? 'tool_calls' : empty || truncated ? 'length' : 'stop', !summary && !title && main === 1
          ? { prompt_tokens: 50000, completion_tokens: 1000, total_tokens: 51000 }
          : { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 });
        response.end('data: [DONE]\n\n');
      });
      try {
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No test port');
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        writeFileSync(path.join(root, 'byok-token-profile.json'), JSON.stringify({
          baseUrl, model: 'local-reasoner', context: 131072, maxOutput: 65536,
          summaryOutput: 16384, headroom: 20000, retainRecent: 8192,
        }));
        const provider = buildOpenCodeByokProviderConfig({ protocol: 'openai', apiKey: 'mock-key', baseUrl }, 'local-reasoner', root)!;
        const env: NodeJS.ProcessEnv = { ...process.env, ...provider.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(provider.config),
          OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_MODELS_FETCH: '1',
          OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
          XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'),
        };
        for (const key of ['OPENCODE', 'OPENCODE_PID', 'OPENCODE_RUN_ID', 'OPENCODE_SERVER_PASSWORD']) delete env[key];
        let output = '';
        const child = spawn(binary!, ['run', '--format', 'json', '--dir', root, '-m', provider.modelId, 'Reply OK. This is a token budget test.'], { env, windowsHide: true });
        child.stdin.end();
        child.stdout.on('data', (data) => { output += data; });
        child.stderr.on('data', (data) => { output += data; });
        const timer = setTimeout(() => child.kill(), 35000);
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
        if (scenario === 'empty-always') {
          expect(code, output.slice(-1600)).not.toBe(0);
          expect(main).toBe(1); expect(summaries).toBe(2);
          expect(output).toContain('two invalid summaries');
        } else {
          expect(code, output.slice(-1600)).toBe(0);
          expect(main).toBeGreaterThanOrEqual(2);
          expect(summaries).toBe(['valid', 'streaming'].includes(scenario) ? 1 : 2);
        }
        for (const request of seen.filter((item) => !item.title)) {
          expect(request.marker).toBeUndefined();
          if (request.summary) {
            expect(request.choice).toBe('none'); expect(request.tools).toBe(0); expect(request.thinking).toBe(false);
          } else {
            expect(request.limit).toBe(65536); expect(request.tools).toBeGreaterThan(0);
            expect(request.choice).not.toBe('none'); expect(request.thinking).toBeUndefined();
          }
        }
        if (scenario === 'streaming') {
          const notices = output.split('\n').filter((line) => line.startsWith('[model-activity]') && line.includes('phase=thinking'));
          expect(notices.length).toBeGreaterThanOrEqual(2);
          expect(notices.join(' ')).not.toContain('private');
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
      }
    }, 45000,
  );
});
