import { RelayError } from '../errors.js';
import { pipeBody, sendJson } from '../http.js';
import { sseHeaders } from '../sse.js';
import { collectStream, readResponseStream, responseObjectFromCollected } from '../translate/responses.js';

/** POST /v1/responses — the OpenAI Responses API, backed by the gateway. */
export async function handleResponses(ctx, body) {
  if (!body.model) throw new RelayError(400, 'missing_model', '`model` is required.');

  const wantsStream = Boolean(body.stream);
  const upstream = await ctx.gateway.post('responses', body, {
    signal: ctx.signal,
    accept: 'text/event-stream',
  });

  if (!wantsStream) {
    const collected = await collectStream(readResponseStream(upstream.body, { signal: ctx.signal }));
    if (collected.error) throw new RelayError(502, 'upstream_failed', collected.error);
    sendJson(ctx.res, 200, responseObjectFromCollected(collected, body.model));
    return;
  }

  ctx.res.writeHead(200, sseHeaders());
  await pipeBody(upstream, ctx.res);
}
