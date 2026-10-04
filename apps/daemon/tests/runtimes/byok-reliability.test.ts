import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOpenCodeByokProviderConfig } from '../../src/runtimes/byok-opencode.js';
import { byokOpenCodeAgentDef } from '../../src/runtimes/defs/byok-opencode.js';

const roots: string[] = [];
const profile = {
  model: 'local-reasoner', baseUrl: 'http://127.0.0.1:18020/v1',
  context: 131_072, maxOutput: 65_536, summaryOutput: 16_384,
  headroom: 20_000, retainRecent: 8_192,
};
function setup(overrides = {}, filename = 'byok-token-profile.json') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'od-byok-reliability-'));
  roots.push(root);
  writeFileSync(path.join(root, filename), JSON.stringify({ ...profile, ...overrides }));
  return root;
}
function build(root: string, model = profile.model, baseUrl = profile.baseUrl) {
  return buildOpenCodeByokProviderConfig({ protocol: 'openai', apiKey: 'test-secret', baseUrl, maxTokens: 60_000 }, model, root)!;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('BYOK long reasoning profile', () => {
  it('budgets generation and compaction independently and installs its bundled plugin', () => {
    const root = setup();
    const result = build(root);
    expect(result.config).toMatchObject({
      provider: { 'open-design-byok': { models: {
        'local-reasoner': { limit: { context: 131072, input: 65536, output: 65536 } },
        'local-reasoner-compaction': { id: 'local-reasoner', limit: { context: 131072, input: 114688, output: 16384 } },
      } } },
      agent: { compaction: { model: 'open-design-byok/local-reasoner-compaction' } },
      compaction: { auto: true, prune: true, reserved: 20000, preserve_recent_tokens: 8192, tail_turns: 2 },
    });
    expect(result.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX).toBe('65536');
    const pluginUrl = (result.config.plugin as string[])[0]!;
    const pluginPath = fileURLToPath(pluginUrl);
    expect(path.relative(root, pluginPath)).not.toMatch(/^\.\./);
    expect(readFileSync(pluginPath, 'utf8')).toContain('[model-activity]');
    expect(JSON.stringify(result.config)).not.toContain('test-secret');
    expect(build(root).config.plugin).toEqual(result.config.plugin);
  });

  it('keeps other models and endpoints on their saved settings', () => {
    const root = setup();
    for (const result of [build(root, 'another-model'), build(root, profile.model, 'http://localhost:18021/v1')]) {
      expect(result.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX).toBe('60000');
      expect(result.config.compaction).toBeUndefined();
      expect(result.config.plugin).toBeUndefined();
      expect(result.env.XDG_CONFIG_HOME).toBeUndefined();
    }
  });

  it('accepts the existing maxout2 profile filename', () => {
    expect(build(setup({}, 'qwen27b-token-profile.json')).config.compaction).toBeDefined();
  });

  it.each([
    { maxOutput: 131072 }, { summaryOutput: 20000 }, { headroom: 0 },
    { retainRecent: 45536 }, { context: 12.5 }, { maxOutput: -1 }, { retainRecent: 30000 },
  ])('rejects unsafe budgets %j', (invalid) => {
    expect(() => build(setup(invalid))).toThrow(/token profile/i);
  });

  it('reports malformed profile JSON instead of silently running unsafe defaults', () => {
    const root = setup();
    writeFileSync(path.join(root, 'byok-token-profile.json'), '{broken');
    expect(() => build(root)).toThrow(/token profile/i);
  });

  it('uses a 30-minute silence allowance rather than a total run deadline', () => {
    expect(byokOpenCodeAgentDef.inactivityTimeoutMs).toBe(30 * 60 * 1000);
  });
});
