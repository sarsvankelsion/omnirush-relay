import { randomUUID } from 'node:crypto';
import { RelayError } from '../errors.js';
import { sendJson } from '../http.js';
import { sseHeaders, writeEvent } from '../sse.js';
import {
  anthropicStopReason,
  collectStream,
  readResponseStream,
  responsesBodyFromMessages,
} from '../translate/responses.js';

/** POST /v1/messages — Anthropic Messages, backed by the Responses API. */
export async function handleMessages(ctx, body) {
  if (!body.model) throw new RelayError(400, 'missing_model', '`model` is required.');
  if (!body.max_tokens) throw new RelayError(400, 'missing_max_tokens', '`max_tokens` is required.');

  const upstreamBody = responsesBodyFromMessages(body);
  const wantsStream = Boolean(body.stream);

  const upstream = await ctx.gateway.post('responses', upstreamBody, {
    signal: ctx.signal,
    accept: wantsStream ? 'text/event-stream' : 'application/json',
  });

  if (wantsStream) return streamMessages(ctx, body, upstream);
  return completeMessages(ctx, body, upstream);
}

async function completeMessages(ctx, body, upstream) {
  const result = await collectStream(readResponseStream(upstream.body, { signal: ctx.signal }));
  if (result.error) throw new RelayError(502, 'upstream_failed', result.error);

  const content = [];
  if (result.text) content.push({ type: 'text', text: result.text });
  for (const call of result.toolCalls) {
    content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseArguments(call.arguments) });
  }

  sendJson(ctx.res, 200, {
    id: `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content,
    stop_reason: anthropicStopReason(result.status, result.reason, result.toolCalls.length > 0),
    stop_sequence: null,
    usage: {
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
    },
  });
}

async function streamMessages(ctx, body, upstream) {
  const res = ctx.res;
  res.writeHead(200, sseHeaders());

  const id = `msg_${randomUUID().replaceAll('-', '')}`;
  const model = body.model;
  const wantsThinking = body.thinking?.type === 'enabled';

  let nextIndex = 0;
  let open = null;
  let toolCalls = 0;
  let stopReason = 'end_turn';
  let usage = null;

  const closeOpen = () => {
    if (!open) return;
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
  };

  const openBlock = (contentBlock, kind, extra = {}) => {
    closeOpen();
    const index = nextIndex;
    nextIndex += 1;
    writeEvent(res, 'content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
    open = { index, kind, ...extra };
    return index;
  };

  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  try {
    for await (const event of readResponseStream(upstream.body, { signal: ctx.signal })) {
      if (event.type === 'text') {
        if (open?.kind !== 'text') openBlock({ type: 'text', text: '' }, 'text');
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: { type: 'text_delta', text: event.delta },
        });
      } else if (event.type === 'reasoning') {
        if (!wantsThinking) continue;
        if (open?.kind !== 'thinking') {
          openBlock({ type: 'thinking', thinking: '' }, 'thinking');
        }
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: { type: 'thinking_delta', thinking: event.delta },
        });
      } else if (event.type === 'tool_start') {
        toolCalls += 1;
        openBlock({ type: 'tool_use', id: event.id, name: event.name, input: {} }, 'tool', {
          toolIndex: event.index,
        });
      } else if (event.type === 'tool_args') {
        if (open?.kind !== 'tool' || open.toolIndex !== event.index) {
          // Arguments before their item was announced: keep them rather than drop them.
          openBlock({ type: 'tool_use', id: `tool_${event.index}`, name: '', input: {} }, 'tool', {
            toolIndex: event.index,
          });
        }
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: { type: 'input_json_delta', partial_json: event.delta },
        });
      } else if (event.type === 'done') {
        stopReason = anthropicStopReason(event.status, event.reason, toolCalls > 0);
        usage = event.usage;
      } else if (event.type === 'error') {
        closeOpen();
        writeEvent(res, 'error', { type: 'error', error: { type: 'api_error', message: event.message } });
        res.end();
        return;
      }
    }
  } catch (error) {
    if (ctx.signal.aborted) return res.end();
    closeOpen();
    writeEvent(res, 'error', {
      type: 'error',
      error: { type: 'api_error', message: error?.message ?? 'The stream failed.' },
    });
    res.end();
    return;
  }

  closeOpen();

  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  });
  writeEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function parseArguments(raw) {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}
