import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readJson, removeFile, writeJson } from './store.js';
import { RelayError } from './errors.js';
import { controlPlane, sleep } from './util.js';

export const DEFAULT_GATEWAY_URL = 'https://omnirush.ai/omnirush/v1';

/** The server re-accepts a refresh token it just rotated for this long. */
const ROTATION_GRACE_MS = 110_000;
const REFRESH_TIMEOUT_MS = 20_000;
const AUTHORIZE_TIMEOUT_MS = 20_000;

function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Holds one OmniRush device session: the access token the gateway accepts, the
 * refresh token that rotates it, and the single-flight rotation around it.
 *
 * Only one process should own a given auth file. If a second one rotates the
 * same token the server answers 409; we then adopt the pair the winner saved
 * instead of signing the account out.
 */
export class Account {
  constructor({ file, fetchImpl = globalThis.fetch, log = () => {}, env = process.env } = {}) {
    this.file = file;
    this.markerFile = file ? `${file}.refreshing.json` : null;
    this.fetch = fetchImpl;
    this.log = log;
    this.env = env;

    this.gatewayUrl = null;
    this.accessToken = null;
    this.refreshToken = null;
    this.rotation = 0;
    this.updatedAt = 0;
    this.source = 'none';

    this._refreshInFlight = null;
  }

  get signedIn() {
    return Boolean(this.gatewayUrl && this.accessToken && this.refreshToken);
  }

  get root() {
    return controlPlane(this.gatewayUrl ?? this.env.OMNIRUSH_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
  }

  /** Load credentials: environment first, then the auth file. */
  async load() {
    const envGateway = this.env.OMNIRUSH_GATEWAY_URL?.trim();
    const envAccess = this.env.OMNIRUSH_ACCESS_TOKEN?.trim();
    const envRefresh = this.env.OMNIRUSH_REFRESH_TOKEN?.trim();
    if (envAccess && envRefresh) {
      this.gatewayUrl = envGateway || DEFAULT_GATEWAY_URL;
      this.accessToken = envAccess;
      this.refreshToken = envRefresh;
      this.rotation = 0;
      this.source = 'env';
      return true;
    }

    if (!this.file) return false;
    const stored = await readJson(this.file);
    if (!stored) return false;
    if (!stored.gatewayUrl || !stored.accessToken || !stored.refreshToken) return false;
    this.gatewayUrl = stored.gatewayUrl;
    this.accessToken = stored.accessToken;
    this.refreshToken = stored.refreshToken;
    this.rotation = Number(stored.rotation) || 0;
    this.updatedAt = Number(stored.updatedAt) || 0;
    this.source = 'file';
    return true;
  }

  /** Persist the current pair. Never writes env-provided credentials. */
  async save() {
    if (this.source === 'env' || !this.file) return;
    this.updatedAt = Date.now();
    await writeJson(this.file, {
      gatewayUrl: this.gatewayUrl,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      rotation: this.rotation,
      updatedAt: this.updatedAt,
    });
  }

  status() {
    return {
      signedIn: this.signedIn,
      gatewayUrl: this.gatewayUrl,
      rotation: this.rotation,
      updatedAt: this.updatedAt,
      source: this.source,
    };
  }

  /**
   * Device login: ask the account server for a code, hand the verification URL
   * to the caller, then poll until the browser approves it.
   *
   * @param {{deviceName?: string, platform?: string, onAuthorize?: (info: object) => void}} options
   */
  async signIn({ deviceName = os.hostname(), platform = process.platform, onAuthorize = () => {} } = {}) {
    const base = controlPlane(this.gatewayUrl ?? DEFAULT_GATEWAY_URL);

    const issued = await this.#postJson(`${base}/device/authorize`, {
      device_name: deviceName,
      platform,
    });
    if (!issued?.device_code || !issued?.verification_uri_complete) {
      throw new RelayError(502, 'device_link_invalid', 'The account server returned an invalid device link.');
    }
    onAuthorize(issued);

    const interval = Math.max(2, Number(issued.interval) || 3) * 1_000;
    const deadline = Date.now() + Math.max(60, Number(issued.expires_in) || 600) * 1_000;
    let wait = interval;

    while (Date.now() < deadline) {
      await sleep(wait);
      let response;
      try {
        response = await this.fetch(`${base}/device/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ device_code: issued.device_code }),
          signal: AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS),
        });
      } catch (error) {
        throw new RelayError(503, 'device_login_unreachable', `Could not reach the account server: ${error?.message ?? error}`);
      }

      if (response.status === 428 || response.status === 202) continue;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let detail = '';
        try {
          const payload = JSON.parse(text);
          detail = payload?.detail ?? payload?.error?.message ?? payload?.error ?? '';
        } catch {
          detail = text.slice(0, 300);
        }
        if (/pending|slow_down|authorization_pending/i.test(String(detail))) {
          if (/slow_down/i.test(String(detail))) wait += 5_000;
          continue;
        }
        throw new RelayError(400, 'device_login_failed', `Account link failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
      }

      const payload = await response.json().catch(() => null);
      if (!payload?.access_token || !payload?.refresh_token) {
        throw new RelayError(502, 'device_login_invalid', 'The account server returned invalid credentials.');
      }

      this.gatewayUrl = payload.gateway_url ?? this.gatewayUrl ?? DEFAULT_GATEWAY_URL;
      this.accessToken = payload.access_token;
      this.refreshToken = payload.refresh_token;
      this.rotation = 0;
      this.source = 'file';
      await this.save();
      if (this.markerFile) await removeFile(this.markerFile);
      return { gatewayUrl: this.gatewayUrl, userCode: String(issued.user_code ?? '') };
    }

    throw new RelayError(400, 'device_login_timeout', 'The account link expired before it was approved.');
  }

  /**
   * Rotate the refresh token once. Callers pass the access token that was
   * refused; if it is no longer current, another request already refreshed.
   *
   * @param {string} [rejectedAccessToken]
   * @returns {Promise<boolean>} true when a usable pair is in place
   */
  async refresh(rejectedAccessToken) {
    if (!this.refreshToken) {
      throw new RelayError(401, 'not_signed_in', 'No OmniRush session. Run `omnirush-relay login` first.');
    }
    if (rejectedAccessToken && this.accessToken !== rejectedAccessToken) return true;
    if (!this._refreshInFlight) {
      this._refreshInFlight = this.#refreshLoop(rejectedAccessToken).finally(() => {
        this._refreshInFlight = null;
      });
    }
    return this._refreshInFlight;
  }

  async #refreshLoop(rejectedAccessToken) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(750 * attempt);
      if (this.accessToken !== rejectedAccessToken) return true;

      const outcome = await this.#rotate();

      if (outcome === 'rotated') return true;
      if (outcome === 'retired') {
        throw new RelayError(
          401,
          'account_signed_out',
          'The OmniRush device session was retired by the account server. Run `omnirush-relay login` again.',
        );
      }
      if (outcome === 'contended') {
        // Another process may have rotated the same token: adopt what it saved.
        if (await this.#adoptFromDisk()) return true;
        continue;
      }
      throw new RelayError(503, 'refresh_unavailable', 'The account server could not renew the session right now. Try again in a moment.');
    }
    throw new RelayError(503, 'refresh_contended', 'The session is being renewed by another process. Try again in a moment.');
  }

  /** Spend the current refresh token. Returns 'rotated' | 'retired' | 'contended' | 'unavailable'. */
  async #rotate() {
    const spent = this.refreshToken;
    await this.#writeMarker(spent);

    let response;
    try {
      response = await this.fetch(`${this.root}/device/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ refresh_token: spent }),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (error) {
      this.log(`[auth] refresh request failed: ${error?.message ?? error}`);
      return 'unavailable';
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return 'retired';
      if (response.status === 409) return 'contended';
      return 'unavailable';
    }

    const payload = await response.json().catch(() => null);
    if (!payload?.access_token || !payload?.refresh_token) return 'unavailable';

    this.gatewayUrl = payload.gateway_url ?? this.gatewayUrl;
    this.accessToken = payload.access_token;
    this.refreshToken = payload.refresh_token;
    this.rotation += 1;
    if (this.markerFile) await removeFile(this.markerFile);
    await this.save();
    this.log(`[auth] rotated the device session (rotation ${this.rotation})`);
    return 'rotated';
  }

  /** Replace in-memory credentials with a pair another process saved. */
  async #adoptFromDisk() {
    if (!this.file) return false;
    const stored = await readJson(this.file);
    if (!stored?.refreshToken || stored.refreshToken === this.refreshToken) return false;
    this.gatewayUrl = stored.gatewayUrl ?? this.gatewayUrl;
    this.accessToken = stored.accessToken;
    this.refreshToken = stored.refreshToken;
    this.rotation = Number(stored.rotation) || this.rotation;
    this.log('[auth] adopted the session another process renewed');
    return Boolean(this.accessToken);
  }

  /**
   * A note written before a refresh token is sent. If the process dies mid
   * rotation the next launch can tell the token may already be spent.
   */
  async #writeMarker(token) {
    if (!this.markerFile || this.source === 'env') return;
    await writeJson(this.markerFile, { hash: tokenHash(token), at: Date.now() }).catch(() => undefined);
  }

  /** Whether a refresh was cut off recently enough for the server to still accept the token. */
  async interruptedRefresh() {
    if (!this.markerFile) return null;
    const marker = await readJson(this.markerFile);
    if (!marker?.hash || !marker?.at) return null;
    const age = Date.now() - Number(marker.at);
    return { hash: marker.hash, age, inGrace: age < ROTATION_GRACE_MS };
  }

  /**
   * Authenticated request: attaches the bearer, and on 401 renews the session
   * once and replays the request.
   */
  async authorizedFetch(url, init = {}) {
    if (!this.accessToken) {
      throw new RelayError(401, 'not_signed_in', 'No OmniRush session. Run `omnirush-relay login` first.');
    }
    const send = (token) => {
      const headers = new Headers(init.headers ?? {});
      headers.set('authorization', `Bearer ${token}`);
      return this.fetch(url, { ...init, headers });
    };

    const token = this.accessToken;
    const response = await send(token);
    if (response.status !== 401) return response;

    await response.body?.cancel().catch(() => undefined);
    await this.refresh(token);
    return send(this.accessToken);
  }

  /** The signed-in account and its usage, from `<root>/device/me`. */
  async profile() {
    const response = await this.authorizedFetch(`${this.root}/device/me`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new RelayError(response.status, 'profile_failed', `Could not read the account profile (HTTP ${response.status}).`);
    }
    return response.json();
  }

  async #postJson(url, body) {
    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AUTHORIZE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new RelayError(503, 'device_login_unreachable', `Could not reach the account server: ${error?.message ?? error}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new RelayError(400, 'device_login_failed', `Account link failed (HTTP ${response.status})${text ? `: ${text.slice(0, 300)}` : ''}`);
    }
    return response.json();
  }
}

/** Default auth file location. */
export function defaultAuthFile(home = os.homedir()) {
  return path.join(home, '.omnirush-relay', 'auth.json');
}
