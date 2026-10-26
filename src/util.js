import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';

export const VERSION = '1.0.0';

/** Wait `ms` milliseconds. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Constant-time string comparison that never throws on unequal lengths. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/** The account/control-plane root: the gateway URL without its trailing `/v1`. */
export function controlPlane(gatewayUrl) {
  const url = new URL(gatewayUrl);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

/** Join a base URL and a path without doubling slashes. */
export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

/** Open a URL in the user's browser. Best effort: never throws. */
export function openBrowser(url, log = () => {}) {
  const platform = process.platform;
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => log(`Could not open a browser. Open this URL manually:\n  ${url}`));
    child.unref();
    return true;
  } catch {
    log(`Could not open a browser. Open this URL manually:\n  ${url}`);
    return false;
  }
}
