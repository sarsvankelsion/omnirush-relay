import { randomUUID } from 'node:crypto';
import { RelayError } from '../errors.js';
import { sendJson } from '../http.js';
import { sseHeaders, writeData } from '../sse.js';
import {
  chatFinishReason,
  collectStream,
  readResponseStream,
  responsesBodyFromChat,
} from '../translate/responses.js';

/** POST /v1/chat/completions — OpenAI Chat Completions, backed by the Responses API. */
export async function handleChat(ctx, body) {
  if (!body.model) throw new RelayError(400, 'missing_model', '`model` is required.');

  const upstreamBody = responsesBodyFromChat(body);
  const wantsStream = Boolean(body.stream);

  const upstream = await ctx.gateway.post('responses', upstreamBody, {
    signal: ctx.signal,
    accept: wantsStream ? 'text/event-stream' : 'application/json',
  });

  if (wantsStream) return streamChat(ctx, body, upstream);
  return completeChat(ctx, body, upstream);
}

async function completeChat(ctx, body, upstream) {
  const result = await collectStream(readResponseStream(upstream.body, { signal: ctx.signal }));
  if (result.error) throw new RelayError(502, 'upstream_failed', result.error);

  const message = {
    role: 'assistant',
    content: result.text || (result.toolCalls.length ? null : ''),
  };
  if (result.toolCalls.length) {
    message.tool_calls = result.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (result.reasoning) message.reasoning_content = result.reasoning;

  const usage = openAiUsage(result.usage);
  sendJson(ctx.res, 200, {
    id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: chatFinishReason(result.status, result.reason, result.toolCalls.length > 0),
      },
    ],
    ...(usage ? { usage } : {}),
  });
}

async function streamChat(ctx, body, upstream) {
  const res = ctx.res;
  res.writeHead(200, sseHeaders());

  const id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model;
  const includeUsage = Boolean(body.stream_options?.include_usage);

  let toolCalls = 0;
  let finishReason = 'stop';
  let usage = null;

  const chunk = (delta, extra = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: null, ...extra }],
  });

  writeData(res, chunk({ role: 'assistant', content: '' }));

  try {
    for await (const event of readResponseStream(upstream.body, { signal: ctx.signal })) {
      if (event.type === 'text') {
        writeData(res, chunk({ content: event.delta }));
      } else if (event.type === 'reasoning') {
        writeData(res, chunk({ reasoning_content: event.delta }));
      } else if (event.type === 'tool_start') {
        toolCalls += 1;
        writeData(
          res,
          chunk({
            tool_calls: [{ index: event.index, id: event.id, type: 'function', function: { name: event.name, arguments: '' } }],
          }),
        );
      } else if (event.type === 'tool_args') {
        writeData(
          res,
          chunk({ tool_calls: [{ index: event.index, function: { arguments: event.delta } }] }),
        );
      } else if (event.type === 'done') {
        finishReason = chatFinishReason(event.status, event.reason, toolCalls > 0);
        usage = event.usage;
      } else if (event.type === 'error') {
        writeData(res, { error: { message: event.message, type: 'upstream_error', code: 'upstream_stream_error' } });
        res.end();
        return;
      }
    }
  } catch (error) {
    if (ctx.signal.aborted) return res.end();
    writeData(res, { error: { message: error?.message ?? 'The stream failed.', type: 'upstream_error' } });
    res.end();
    return;
  }

  writeData(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, logprobs: null, finish_reason: finishReason }],
  });

  if (includeUsage && usage) {
    writeData(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: openAiUsage(usage),
    });
  }

  writeData(res, '[DONE]');
  res.end();
}

function openAiUsage(usage) {
  if (!usage) return null;
  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.cached_tokens ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
    ...(usage.reasoning_tokens ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
  };
}
