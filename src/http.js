import { Readable } from 'node:stream';

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'Authorization, Content-Type, X-Api-Key, Anthropic-Version, Anthropic-Beta, X-Stainless-Lang',
  'access-control-expose-headers': 'X-Request-Id',
  'access-control-max-age': '86400',
};

export function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

/** Send an error in the shape the calling protocol expects. */
export function sendError(res, pathname, error, headers = CORS, statusOverride = 0) {
  const status = statusOverride || error.status || 500;
  const anthropic = String(pathname ?? '').startsWith('/v1/messages');
  const payload = anthropic ? error.toAnthropicJSON() : error.toJSON();
  sendJson(res, status, payload, headers);
}

/** A streaming error frame the client can show, after headers are already sent. */
export function sendStreamError(res, pathname, error) {
  if (res.writableEnded) return;
  if (String(pathname).startsWith('/v1/messages')) {
    res.write(`event: error\ndata: ${JSON.stringify(error.toAnthropicJSON())}\n\n`);
  } else {
    res.write(`data: ${JSON.stringify(error.toJSON())}\n\n`);
  }
  res.end();
}

/** Copy an upstream web stream to the Node response without re-encoding it. */
export function pipeBody(upstream, res) {
  const body = upstream.body;
  if (!body) {
    res.end();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const nodeStream = Readable.fromWeb(body);
    nodeStream.on('error', reject);
    nodeStream.on('end', resolve);
    res.on('close', () => nodeStream.destroy());
    nodeStream.pipe(res);
  });
}
