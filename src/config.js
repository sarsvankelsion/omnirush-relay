import { randomBytes } from 'node:crypto';
import { readJson, writeJson } from './store.js';
import { VERSION } from './util.js';

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = '127.0.0.1';

export async function loadConfig(file) {
  const stored = (await readJson(file)) ?? {};
  const apiKey = process.env.OMNIRUSH_RELAY_API_KEY?.trim() || stored.apiKey || generateApiKey();
  const config = {
    port: Number(process.env.PORT) || Number(stored.port) || DEFAULT_PORT,
    host: process.env.HOST?.trim() || stored.host || DEFAULT_HOST,
    apiKey,
  };
  if (!stored.apiKey) await writeJson(file, config).catch(() => undefined);
  return config;
}

export async function saveConfig(file, config) {
  await writeJson(file, config);
}

export function generateApiKey() {
  return `sk-omnirush-${randomBytes(24).toString('base64url')}`;
}

export function banner(config, account) {
  const base = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`;
  const lines = [
    '',
    `  omnirush-relay ${VERSION}`,
    '',
    `  base URL   ${base}/v1`,
    `  api key    ${config.apiKey}`,
    account.signedIn
      ? `  account    signed in (rotation ${account.rotation}) — ${account.gatewayUrl}`
      : '  account    NOT signed in — run `omnirush-relay login`',
    '',
    '  Clients: set the base URL and the API key above. Any OpenAI-compatible',
    '  client works; /v1/messages is available for Anthropic clients.',
    '',
  ];
  return lines.join('\n');
}
