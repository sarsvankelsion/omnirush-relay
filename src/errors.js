/** An error that carries the HTTP status and an OpenAI-style code. */
export class RelayError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'RelayError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.status >= 500 ? 'server_error' : 'invalid_request_error',
        code: this.code,
        ...this.extra,
      },
    };
  }

  /** Anthropic-shaped error body, for `/v1/messages`. */
  toAnthropicJSON() {
    return {
      type: 'error',
      error: {
        type: this.status === 401 ? 'authentication_error' : this.status >= 500 ? 'api_error' : 'invalid_request_error',
        message: this.message,
      },
    };
  }
}

/** Turn any thrown value into a RelayError, keeping an HTTP status it already carries. */
export function asRelayError(error) {
  if (error instanceof RelayError) return error;
  const status = Number(error?.status) || 500;
  const code = typeof error?.code === 'string' ? error.code : 'internal_error';
  return new RelayError(status, code, error?.message ? String(error.message) : 'Internal error');
}

/** Read an upstream JSON/text error into a human message. */
export function upstreamMessage(status, text) {
  let detail = '';
  try {
    const payload = JSON.parse(text);
    detail = payload?.error?.message ?? payload?.detail ?? payload?.error ?? payload?.message ?? '';
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {
    detail = String(text ?? '').trim().slice(0, 500);
  }
  if (!detail) detail = `OmniRush gateway returned HTTP ${status}`;
  return detail;
}
