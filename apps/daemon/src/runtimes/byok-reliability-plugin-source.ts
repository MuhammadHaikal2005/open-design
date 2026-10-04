/**
 * Standalone OpenCode plugin payload. Stored as source text because the packaged
 * daemon bundles modules into chunks while OpenCode loads a separate ESM file.
 * Keeping the payload here makes both tsc and packaged builds self-contained;
 * regression tests execute this exact payload, including its streaming behavior.
 */
export const BYOK_RELIABILITY_PLUGIN_SOURCE = `
// Relay real generation progress through stderr, which OpenDesign already counts
// as activity. No timer emits notices: only newly received content can do so.
// Original SSE bytes are forwarded unchanged, without persisting reasoning text.
function trackGeneration(response, stage) {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const decoder = new TextDecoder();
  let pending = '', droppingLine = false, lastNotice, generatedChars = 0;
  const started = Date.now();
  const observeLine = (line) => {
    if (!line.startsWith('data:')) return;
    let event;
    try { event = JSON.parse(line.slice(5).trim()); } catch { return; }
    let thinking = 0, answer = 0, tool = 0;
    const length = (value) => typeof value === 'string' ? value.length : 0;
    for (const choice of event.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      thinking += length(delta.reasoning_content) + length(delta.reasoning);
      answer += length(delta.content);
      for (const call of delta.tool_calls ?? []) tool += length(call.function?.arguments);
      tool += length(delta.function_call?.arguments);
    }
    if (!thinking && !answer && !tool) return;
    generatedChars += thinking + answer + tool;
    const now = Date.now();
    if (lastNotice !== undefined && now - lastNotice < 10000) return;
    lastNotice = now;
    const phase = thinking ? 'thinking' : tool ? 'tool-arguments' : 'answer';
    console.error(\`[model-activity] stage=\${stage} phase=\${phase} generated_chars=\${generatedChars} elapsed_seconds=\${Math.floor((now-started)/1000)}\`);
  };
  const observe = (text) => {
    pending += text;
    let newline;
    while ((newline = pending.indexOf('\\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!droppingLine && line.length <= 2 * 1024 * 1024) observeLine(line);
      droppingLine = false;
    }
    if (pending.length > 2 * 1024 * 1024) { pending = ''; droppingLine = true; }
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      // Monitoring must never prevent delivery of an otherwise valid response.
      try { observe(decoder.decode(chunk, { stream: true })); } catch { /* ignore malformed monitoring data */ }
    },
    flush() {
      try { observe(decoder.decode()); if (pending && !droppingLine) observeLine(pending); } catch { /* no synthetic progress */ }
    },
  }));
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Hold summary output until it is complete and useful. Never expose an empty
// successful completion: OpenCode would then replace history with no summary.
async function inspectSummary(response) {
  const reader = response.body?.getReader();
  if (!reader) return { valid: false, reason: 'missing response body' };
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) {
        await reader.cancel();
        return { valid: false, reason: 'oversized summary response' };
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const wire = new TextDecoder().decode(bytes);
  let content = '', finish, done = false, tools = false, reasoningTokens;
  try {
    for (const line of wire.split(/\\r?\\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') { done = true; continue; }
      if (!data) continue;
      const event = JSON.parse(data);
      if (event.error) return { valid: false, reason: 'error in summary stream' };
      reasoningTokens = event.usage?.completion_tokens_details?.reasoning_tokens ?? reasoningTokens;
      for (const choice of event.choices ?? []) {
        if (choice.index !== 0) continue;
        if (typeof choice.delta?.content === 'string') content += choice.delta.content;
        if (choice.delta?.tool_calls?.length || choice.delta?.function_call) tools = true;
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
  } catch { return { valid: false, reason: 'malformed summary stream' }; }
  const visible = content.replace(/<think>[\\s\\S]*?(?:<\\/think>|$)/gi, '').trim();
  const valid = done && finish === 'stop' && !tools && visible.length >= 100 && !/<\\/?think>/i.test(content);
  return { valid, bytes, chars: visible.length, reasoningTokens, reason: \`finish=\${finish ?? 'missing'}, chars=\${visible.length}, tools=\${tools}, complete=\${done}\` };
}

export const SummaryGuard = async ({ directory } = {}) => ({
  async config(config) {
    const provider = config.provider?.['open-design-byok'];
    if (!provider) return;
    provider.options ??= {};
    const originalFetch = provider.options.fetch ?? globalThis.fetch;
    provider.options.fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const stage = headers.get('x-od-activity-stage');
      headers.delete('x-od-activity-stage');
      if (headers.get('x-od-summary-only') !== '1') {
        if (!stage) return originalFetch(input, init);
        const response = await originalFetch(input, { ...init, headers });
        return trackGeneration(response, 'generation');
      }
      headers.delete('x-od-summary-only');
      const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof raw !== 'string') throw new Error('Summary guard expected a JSON request body');
      const body = JSON.parse(raw);
      body.tool_choice = 'none';
      delete body.tools;
      delete body.reasoning_effort;
      body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: false };
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await originalFetch(input, { ...init, headers, body: JSON.stringify(body) });
        if (!response.ok) return response;
        const checked = await inspectSummary(trackGeneration(response, 'compaction'));
        console.error(\`[summary-guard] attempt=\${attempt} accepted=\${checked.valid} \${checked.reason} reasoning_tokens=\${checked.reasoningTokens ?? 'unreported'}\`);
        if (checked.valid) {
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete('content-length');
          responseHeaders.delete('content-encoding');
          return new Response(checked.bytes, { status: response.status, statusText: response.statusText, headers: responseHeaders });
        }
        if (attempt === 1) body.messages.push({ role: 'user', content: 'Your previous summary was invalid or incomplete. Return only a concise, complete task checkpoint in plain text, without reasoning or tools. Preserve the objective, working directory, key constraints, files already written, what remains, and the exact next action. Target 600-1200 words. Do not perform the task.' });
      }
      // A non-retryable API error prevents a blank summary from being committed.
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'invalid_compaction_summary', message: 'Compaction stopped: two invalid summaries. Original history has not been replaced. Retry compaction after checking the summarizer.' } }), { status: 422, headers: { 'content-type': 'application/json' } });
    };
  },
  async 'chat.headers'(input, output) {
    if (input.model?.providerID && input.model.providerID !== 'open-design-byok') return;
    if (input.agent === 'compaction') output.headers['x-od-summary-only'] = '1';
    if (input.agent !== 'title') output.headers['x-od-activity-stage'] = input.agent === 'compaction' ? 'compaction' : 'generation';
  },
  async 'experimental.session.compacting'(_input, output) {
    output.context.push(\`Return a concise task checkpoint, ideally 600-1200 words. Summarize only; do not continue the task, call tools, or narrate deliberation. Preserve the user's objective, constraints, actual written files, decisions, remaining work, and exact next actions. Current working directory: \${directory ?? 'preserve the directory from the conversation'}. Distinguish plans from completed work. Preserve the location and status of any on-disk progress checklist so work can resume without rereading every source.\`);
  },
});

`;