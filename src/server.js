import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { asRelayError } from './errors.js';
import { safeEqual } from './util.js';
import { CORS, sendError, sendJson } from './http.js';
import { handleChat } from './routes/chat.js';
import { handleMessages } from './routes/messages.js';
import { handleResponses } from './routes/responses.js';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Build the relay HTTP server.
 *
 * @param {{account: import('./auth.js').Account, gateway: import('./gateway.js').Gateway, apiKey: string, log?: Function}} options
 */
export function createServer({ account, gateway, apiKey, log = () => {} }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`[server] unhandled: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        let pathname = '/';
        try {
          pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
        } catch {
          /* keep '/' */
        }
        sendError(res, pathname, asRelayError(error), CORS);
      } else {
        res.end();
      }
    });
  });

  async function handle(req, res) {
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
    res.setHeader('x-request-id', req.headers['x-request-id'] ?? randomUUID().replaceAll('-', ''));

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    if (pathname === '/health' || pathname === '/') {
      sendJson(res, 200, {
        ok: true,
        service: 'omnirush-relay',
        signedIn: account.signedIn,
        gatewayUrl: account.gatewayUrl,
      });
      return;
    }

    if (!pathname.startsWith('/v1/')) {
      sendJson(res, 404, {
        error: { message: 'Not found', type: 'invalid_request_error', code: 'not_found' },
      });
      return;
    }

    if (!isAuthorized(req, apiKey)) {
      sendError(
        res,
        pathname,
        asRelayError(Object.assign(new Error('Invalid API key'), { status: 401, code: 'invalid_api_key' })),
        CORS,
        401,
      );
      return;
    }

    if (pathname === '/v1/models' && req.method === 'GET') {
      const catalog = await gateway.models();
      sendJson(res, 200, catalog);
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: { message: 'Method not allowed', type: 'invalid_request_error', code: 'method_not_allowed' },
      });
      return;
    }

    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendError(res, pathname, asRelayError(Object.assign(new Error('Request body must be a JSON object'), { status: 400, code: 'invalid_body' })), CORS, 400);
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const ctx = { account, gateway, apiKey, log, signal: controller.signal, pathname, res };

    if (pathname === '/v1/chat/completions') {
      await handleChat(ctx, body);
      return;
    }
    if (pathname === '/v1/messages') {
      await handleMessages(ctx, body);
      return;
    }
    if (pathname === '/v1/responses') {
      await handleResponses(ctx, body);
      return;
    }

    sendJson(res, 404, {
      error: { message: `Unknown route ${pathname}`, type: 'invalid_request_error', code: 'not_found' },
    });
  }

  return server;
}

function isAuthorized(req, apiKey) {
  if (!apiKey) return true;
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const fromHeader = bearer || String(req.headers['x-api-key'] ?? '').trim();
  return safeEqual(fromHeader, apiKey);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(asRelayError(Object.assign(new Error('Request body too large'), { status: 413, code: 'body_too_large' })));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(asRelayError(Object.assign(new Error('Request body is not valid JSON'), { status: 400, code: 'invalid_json' })));
      }
    });
    req.on('error', reject);
  });
}
