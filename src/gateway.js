import { randomUUID } from 'node:crypto';
import { RelayError, upstreamMessage } from './errors.js';
import { joinUrl } from './util.js';

export const DEFAULT_CLIENT_HEADER = 'gui/3.7.0';

/**
 * The OmniRush gateway client. Every model call is a plain HTTP request to
 * `<gateway>/responses`; the gateway speaks the OpenAI Responses API.
 */
export class Gateway {
  constructor({ account, clientHeader = process.env.OMNIRUSH_CLIENT_HEADER || DEFAULT_CLIENT_HEADER, log = () => {} } = {}) {
    this.account = account;
    this.clientHeader = clientHeader;
    this.log = log;
  }

  url(path) {
    return joinUrl(this.account.gatewayUrl, path);
  }

  headers(accept = 'application/json') {
    return {
      'content-type': 'application/json',
      accept,
      // The gateway only serves recognised clients. A bare product label is the
      // one it accepts; a versioned "omnirush/x" is treated as a lookalike.
      'user-agent': process.env.OMNIRUSH_USER_AGENT || 'omnirush',
      'x-omnirush-client-request-id': randomUUID().replaceAll('-', ''),
      'X-OmniRush-Client': this.clientHeader,
    };
  }

  /**
   * POST to the gateway, renewing the session once on 401.
   * Returns the raw Response; the caller decides how to read it.
   *
   * The gateway refuses anything but a streamed, non-stored request, so both
   * are forced here whatever the caller asked for.
   */
  async post(path, body, { signal, accept = 'text/event-stream' } = {}) {
    const response = await this.account.authorizedFetch(this.url(path), {
      method: 'POST',
      headers: this.headers(accept),
      body: JSON.stringify({ ...body, store: false, stream: true }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw upstreamError(response, text);
    }
    return response;
  }

  /** The account's model catalog, normalized to OpenAI's list shape. */
  async models() {
    const response = await this.account.authorizedFetch(this.url('models'), {
      headers: {
        accept: 'application/json',
        'user-agent': process.env.OMNIRUSH_USER_AGENT || 'omnirush',
        'X-OmniRush-Client': this.clientHeader,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw upstreamError(response, text);
    }
    const payload = await response.json().catch(() => null);
    return normalizeCatalog(payload);
  }
}

function upstreamError(response, text) {
  const message = upstreamMessage(response.status, text);
  const status = response.status === 401 ? 401 : response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
  const code =
    response.status === 401
      ? 'upstream_unauthorized'
      : response.status === 429
        ? 'upstream_rate_limited'
        : response.status === 404
          ? 'model_or_route_not_found'
          : 'upstream_error';
  return new RelayError(status, code, message, { upstream_status: response.status });
}

function normalizeCatalog(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  return {
    object: 'list',
    data: list
      .map((entry) => {
        if (typeof entry === 'string') return { id: entry, object: 'model', created: 0, owned_by: 'omnirush' };
        const id = entry?.id ?? entry?.model ?? entry?.slug;
        if (!id) return null;
        return {
          id: String(id),
          object: 'model',
          created: Number(entry.created ?? entry.created_at ?? 0) || 0,
          owned_by: 'omnirush',
          ...(entry.display_name || entry.name ? { name: String(entry.display_name ?? entry.name) } : {}),
          ...(entry.limit || entry.context ? { context_window: entry.limit?.context ?? entry.context } : {}),
        };
      })
      .filter(Boolean),
  };
}
