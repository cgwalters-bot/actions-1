import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The deployment's defaults from deployment.json, checked. Only the keys
// below are taken, so a typo fails here rather than leaving a setting at
// another deployment's value.
const KEYS = {
  'agent-config-repo': /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  'agent-model': /^[A-Za-z0-9_.:-]+(?:\/[A-Za-z0-9_.:-]+)?$/,
};

export function defaults(text = readFileSync(new URL('./deployment.json', import.meta.url), 'utf8')) {
  const settings = JSON.parse(text);
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('deployment.json must be an object');
  for (const key of Object.keys(settings)) if (!Object.hasOwn(KEYS, key)) throw new Error(`deployment.json: unknown setting ${key}`);
  for (const [key, pattern] of Object.entries(KEYS)) {
    if (!Object.hasOwn(settings, key)) throw new Error(`deployment.json: missing setting ${key}`);
    if (typeof settings[key] !== 'string' || !pattern.test(settings[key])) throw new Error(`deployment.json: ${key} must match ${pattern}`);
  }
  return settings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [key, value] of Object.entries(defaults())) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
}
