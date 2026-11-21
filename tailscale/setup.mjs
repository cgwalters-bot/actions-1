import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export function settings(owner, overrides = {}) {
  const tailnets = JSON.parse(readFileSync(new URL('./tailnets.json', import.meta.url)));
  // An organization without an entry, another deployment's, names its own
  // login: a client ID and tags, both, which our wrappers take from the
  // calling repository's variables. That admits no one new: Tailscale's
  // federated identity decides which repositories may log in as a client
  // ID, and an entry's settings could already be overridden all the same.
  const known = Object.hasOwn(tailnets, owner);
  if (!known && !(overrides['oauth-client-id'] && overrides.tags)) {
    throw new Error(`No tailnet settings for GitHub organization ${owner}; add an entry to tailscale/tailnets.json, or give both oauth-client-id and tags.`);
  }
  const result = known ? { ...tailnets[owner] } : { 'oauth-client-id': '', tags: '', proxy: '' };
  for (const key of ['oauth-client-id', 'tags', 'proxy']) {
    if (overrides[key]) result[key] = overrides[key];
  }
  result.audience = overrides.audience || `api.tailscale.com/${result['oauth-client-id']}`;
  for (const value of Object.values(result)) {
    if (/[\r\n]/.test(value)) throw new Error('Tailnet settings must be single-line values');
  }
  return result;
}

const withoutFinalDot = name => name.endsWith('.') ? name.slice(0, -1) : name;

function readStatus() {
  let json;
  try {
    // Only the CLI runs as root. Keep its peer snapshot out of job logs.
    json = execFileSync('sudo', ['-n', '/usr/local/bin/tailscale', 'status', '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    });
  } catch {
    throw new Error('Could not read Tailscale status');
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Could not decode Tailscale status');
  }
}

function resolveProxyAddress(proxy) {
  if (!proxy) return '';
  let url;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error('Invalid inference proxy URL');
  }
  const { hostname } = url;
  if (isIP(hostname) === 4) return hostname;

  // Only tailnet names use LocalAPI. Do not look up other proxy hosts in DNS.
  const host = withoutFinalDot(hostname);
  if (!hostname.replace(/\.+$/, '').endsWith('.ts.net')) return '';
  if (host.length > 253 || host.split('.').some(label =>
    !label || label.length > 63 || /[^a-z0-9-]|^-|-$/.test(label))) {
    throw new Error('Invalid .ts.net inference proxy hostname');
  }

  const peers = readStatus()?.Peer;
  if (!peers || typeof peers !== 'object' || Array.isArray(peers)) {
    throw new Error('Tailscale status has no Peer object');
  }
  const matches = Object.values(peers).filter(peer =>
    typeof peer?.DNSName === 'string' && withoutFinalDot(peer.DNSName) === host);
  if (matches.length === 0) throw new Error('No Tailscale peer matches the broker host');
  if (matches.length > 1) throw new Error('Ambiguous Tailscale broker peer');

  const ips = matches[0].TailscaleIPs;
  if (!Array.isArray(ips)) throw new Error('Tailscale broker peer has no TailscaleIPs array');
  if (ips.some(ip => typeof ip !== 'string' || ip.includes('%') || !isIP(ip))) {
    throw new Error('Tailscale broker peer has an invalid TailscaleIP');
  }
  const ip = ips.find(ip => isIP(ip) === 4);
  if (!ip) throw new Error('Tailscale broker peer has no IPv4 address');
  return ip;
}

function main() {
  if (process.argv[2] === 'resolve-proxy') {
    const ip = resolveProxyAddress(process.env.PROXY);
    if (ip) appendFileSync(process.env.GITHUB_OUTPUT, `proxy-address=${ip}\n`);
    return;
  }
  const overrides = Object.fromEntries(['oauth-client-id', 'audience', 'tags', 'proxy']
    .map(key => [key, process.env[key.toUpperCase().replaceAll('-', '_')]]));
  const result = settings(process.env.REPOSITORY_OWNER, overrides);
  appendFileSync(process.env.GITHUB_OUTPUT,
    Object.entries(result).map(([key, value]) => `${key}=${value}\n`).join(''));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
