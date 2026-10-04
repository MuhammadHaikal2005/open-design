import { afterEach, describe, expect, it, vi } from 'vitest';
import { BYOK_RELIABILITY_PLUGIN_SOURCE } from '../../src/runtimes/byok-reliability-plugin-source.js';

type Hooks = {
  config(config: { provider: Record<string, { options: { fetch: typeof fetch } }> }): Promise<void>;
  'chat.headers'(input: { agent: string; model: { providerID: string } }, output: { headers: Record<string, string> }): Promise<void>;
};
// Execute the exact standalone payload that both source and packaged builds emit.
const createPlugin = new Function(BYOK_RELIABILITY_PLUGIN_SOURCE.replace('export const SummaryGuard =', 'return'))() as () => Promise<Hooks>;
const encoder = new TextEncoder();
const frame = (delta: object, finish: string | null = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
const checkpoint = 'Objective: finish the deck. Written: checkpoint.md and the first slide. Remaining: build slides two through twenty-four and verify them. Next action: write the next group of slides. Preserve the original visual brief.';
const wire = (content = checkpoint, finish = 'stop', done = true) => frame({ content }) + frame({}, finish) + (done ? 'data: [DONE]\n\n' : '');
const response = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } });
async function setup(transport: typeof fetch, agent = 'build', providerID = 'open-design-byok') {
  const hooks = await createPlugin();
  const config = { provider: { 'open-design-byok': { options: { fetch: transport } } } };
  await hooks.config(config);
  const output = { headers: {} as Record<string, string> };
  await hooks['chat.headers']({ agent, model: { providerID } }, output);
  return { fetch: config.provider['open-design-byok'].options.fetch, headers: output.headers };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('standalone BYOK reliability plugin', () => {
  it('relays real progress beyond the silence limit, preserves bytes and propagates cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    let lastActivity = 0;
    const notices: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((value: string) => { notices.push(value); lastActivity = Date.now(); });
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { upstream = controller; }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const plugin = await setup(transport);
    const body = JSON.stringify({ max_tokens: 65536, tools: ['normal-tools'], messages: [] });
    const result = await plugin.fetch('http://localhost/mock', { headers: plugin.headers, body });
    const reader = result.body!.getReader();
    const send = async (bytes: Uint8Array) => {
      const pending = reader.read(); upstream.enqueue(bytes);
      expect((await pending).value).toEqual(bytes);
    };
    const bytes = encoder.encode(frame({ reasoning_content: 'private reasoning 中文' }));
    await send(bytes.slice(0, 37)); expect(notices).toHaveLength(0);
    await send(bytes.slice(37)); expect(notices).toHaveLength(1);
    for (const delta of [{ content: 'private answer' }, { tool_calls: [{ function: { arguments: '{"x":' } }] }, { reasoning: 'more' }, { content: 'next' }]) {
      vi.setSystemTime(Date.now() + 10 * 60 * 1000);
      expect(Date.now() - lastActivity).toBeLessThan(30 * 60 * 1000);
      await send(encoder.encode(frame(delta)));
    }
    expect(Date.now()).toBeGreaterThan(30 * 60 * 1000);
    expect(notices.some((line) => line.includes('phase=tool-arguments'))).toBe(true);
    expect(notices.join(' ')).not.toMatch(/private|中文/);
    vi.setSystemTime(Date.now() + 1000);
    await send(encoder.encode(frame({ content: 'throttled' })));
    expect(notices).toHaveLength(5);
    vi.setSystemTime(Date.now() + 30 * 60 * 1000);
    await send(encoder.encode(': ping\n\n' + frame({ role: 'assistant' }) + 'data: {"usage":{"total_tokens":1}}\n\n'));
    expect(Date.now() - lastActivity).toBeGreaterThan(30 * 60 * 1000);
    expect(notices).toHaveLength(5);
    expect(transport.mock.calls[0]?.[1]?.body).toBe(body);
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('x-od-activity-stage')).toBe(false);
    await reader.cancel();
    // pipeThrough cancellation propagates asynchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancelled).toBe(true);
  });

  it.each([
    ['empty', wire('')], ['truncated', wire(checkpoint, 'length')],
    ['missing DONE', wire(checkpoint, 'stop', false)],
    ['tools', frame({ tool_calls: [{ function: { name: 'todowrite' } }] }, 'tool_calls') + 'data: [DONE]\n\n'],
    ['thinking tags', wire('<think>hidden</think>' + checkpoint)],
    ['malformed', 'data: {broken}\n\n'],
    ['stream error', 'data: {"error":{"message":"bad"}}\n\n'],
  ])('retries one %s summary without exposing it', async (_label, invalid) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(response(invalid)).mockResolvedValueOnce(response(wire()));
    const plugin = await setup(transport, 'compaction');
    const body = { messages: [], max_tokens: 16384, tools: [{}], reasoning_effort: 'high' };
    const result = await plugin.fetch('http://localhost/mock', { headers: plugin.headers, body: JSON.stringify(body) });
    expect(result.status).toBe(200);
    expect(await result.text()).toBe(wire());
    expect(transport).toHaveBeenCalledTimes(2);
    for (const [, init] of transport.mock.calls) {
      const sent = JSON.parse(init?.body as string);
      expect(sent).toMatchObject({ max_tokens: 16384, tool_choice: 'none', chat_template_kwargs: { enable_thinking: false } });
      expect(sent.tools).toBeUndefined(); expect(sent.reasoning_effort).toBeUndefined();
      expect(new Headers(init?.headers).has('x-od-summary-only')).toBe(false);
    }
    expect(body.messages).toHaveLength(0);
  });

  it('fails explicitly after two invalid summaries instead of committing an empty checkpoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const transport = vi.fn<typeof fetch>(async () => response(wire('')));
    const plugin = await setup(transport, 'compaction');
    const result = await plugin.fetch('http://localhost/mock', { headers: plugin.headers, body: '{"messages":[]}' });
    expect(result.status).toBe(422); expect(transport).toHaveBeenCalledTimes(2);
    expect(await result.text()).toContain('invalid_compaction_summary');
  });

  it('reports summary progress while withholding output until validation', async () => {
    const notices = vi.spyOn(console, 'error').mockImplementation(() => {});
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const transport: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(c) { upstream = c; } }), { headers: { 'content-type': 'text/event-stream' } });
    const plugin = await setup(transport, 'compaction');
    let resolved = false;
    const pending = plugin.fetch('http://localhost/mock', { headers: plugin.headers, body: '{"messages":[]}' }).then((r) => { resolved = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    upstream.enqueue(encoder.encode(frame({ content: checkpoint })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notices).toHaveBeenCalledWith(expect.stringContaining('stage=compaction'));
    expect(resolved).toBe(false);
    upstream.enqueue(encoder.encode(frame({}, 'stop') + 'data: [DONE]\n\n')); upstream.close();
    expect((await pending).status).toBe(200);
  });

  it('preserves upstream errors and cancellation', async () => {
    const failure = new Response('unavailable', { status: 503 });
    const plugin = await setup(async () => failure);
    expect(await plugin.fetch('http://localhost/mock', { headers: plugin.headers })).toBe(failure);
    const aborted = await setup(async () => { throw new DOMException('aborted', 'AbortError'); });
    await expect(aborted.fetch('http://localhost/mock', { headers: aborted.headers })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it.each([['title', 'open-design-byok'], ['build', 'another-provider']])('does not annotate %s on %s', async (agent, provider) => {
    const plugin = await setup(vi.fn<typeof fetch>(), agent, provider);
    expect(plugin.headers).toEqual({});
  });
});
