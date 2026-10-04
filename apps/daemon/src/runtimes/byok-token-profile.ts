import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BYOK_RELIABILITY_PLUGIN_SOURCE } from './byok-reliability-plugin-source.js';

export interface ByokTokenProfile {
  model: string;
  baseUrl: string;
  context: number;
  maxOutput: number;
  summaryOutput: number;
  headroom: number;
  retainRecent: number;
}

/** Opt-in deployment policy, shared by UI and CLI runs through the daemon. */
export function readByokTokenProfile(
  dataDir: string | undefined, model: string, baseUrl: string,
): ByokTokenProfile | null {
  if (!dataDir) return null;
  const filename = ['byok-token-profile.json', 'qwen27b-token-profile.json']
    .map((name) => path.join(dataDir, name)).find(existsSync);
  if (!filename) return null;
  let value: Partial<ByokTokenProfile> | null;
  try { value = JSON.parse(readFileSync(filename, 'utf8')) as Partial<ByokTokenProfile> | null; }
  catch { throw new Error('Invalid BYOK token profile: could not read JSON.'); }
  if (!value || typeof value !== 'object' || typeof value.model !== 'string' || typeof value.baseUrl !== 'string') {
    throw new Error('Invalid BYOK token profile: model and baseUrl are required.');
  }
  if (value.model !== model || value.baseUrl.replace(/\/+$/, '') !== baseUrl) return null;
  const values = [value.context, value.maxOutput, value.summaryOutput, value.headroom, value.retainRecent];
  if (!values.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0)) {
    throw new Error('Invalid BYOK token profile: token budgets must be positive integers.');
  }
  const profile = value as ByokTokenProfile;
  const trigger = profile.context - profile.maxOutput - profile.headroom;
  if (trigger <= 0 || profile.summaryOutput >= profile.headroom || profile.retainRecent + profile.summaryOutput >= trigger) {
    throw new Error('Invalid BYOK token profile: insufficient space for generation, summary, or retained history.');
  }
  return profile;
}

/** Materialize the standalone CLI plugin from bundled source, never from a user-machine path. */
export function prepareByokReliabilityPlugin(dataDir: string, profile: ByokTokenProfile) {
  const identity = createHash('sha256').update(JSON.stringify([profile.model, profile.baseUrl])).digest('hex').slice(0, 16);
  const configHome = path.join(dataDir, 'byok-opencode', identity);
  const sourceHash = createHash('sha256').update(BYOK_RELIABILITY_PLUGIN_SOURCE).digest('hex');
  const pluginPath = path.join(configHome, `reliability-${sourceHash}.mjs`);
  mkdirSync(configHome, { recursive: true });
  // Publish the complete content atomically, including on the first run. A
  // versioned filename also prevents CLI module caches from retaining old code.
  if (!existsSync(pluginPath) || readFileSync(pluginPath, 'utf8') !== BYOK_RELIABILITY_PLUGIN_SOURCE) {
    const temporary = `${pluginPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, BYOK_RELIABILITY_PLUGIN_SOURCE, { flag: 'wx' });
      renameSync(temporary, pluginPath);
    } finally { rmSync(temporary, { force: true }); }
  }
  return { configHome, pluginUrl: pathToFileURL(pluginPath).href };
}
