import { randomUUID } from 'node:crypto';
import { readSse } from '../sse.js';

/** Normalize a Responses API usage block. */
export function normalizeUsage(usage) {
  if (!usage) return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? 0);
  const reasoning = Number(usage.output_tokens_details?.reasoning_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output),
    cached_tokens: cached,
    reasoning_tokens: reasoning,
  };
}

/**
 * Read the gateway's Responses SSE and emit protocol-neutral events:
 *   text | reasoning | tool_start | tool_args | done | error
 */
export async function* readResponseStream(stream, options = {}) {
  const toolIndex = new Map();
  let toolCount = 0;
  let sawDone = false;

  for await (const frame of readSse(stream, options)) {
    if (frame.data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(frame.data);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object') continue;
    const type = event.type ?? frame.event;

    switch (type) {
      case 'response.output_item.added': {
        const item = event.item;
        if (item?.type === 'function_call') {
          const index = toolCount++;
          if (item.id) toolIndex.set(item.id, index);
          yield { type: 'tool_start', index, id: item.call_id ?? item.id ?? `tool_${index}`, name: item.name ?? '' };
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const index = toolIndex.get(event.item_id) ?? 0;
        if (event.delta) yield { type: 'tool_args', index, delta: event.delta };
        break;
      }
      case 'response.output_text.delta': {
        if (event.delta) yield { type: 'text', delta: event.delta };
        break;
      }
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        if (event.delta) yield { type: 'reasoning', delta: event.delta };
        break;
      }
      case 'response.completed': {
        sawDone = true;
        const response = event.response ?? {};
        yield { type: 'done', usage: normalizeUsage(response.usage), status: 'completed', reason: null };
        break;
      }
      case 'response.incomplete': {
        sawDone = true;
        const response = event.response ?? {};
        yield {
          type: 'done',
          usage: normalizeUsage(response.usage),
          status: 'incomplete',
          reason: response.incomplete_details?.reason ?? 'incomplete',
        };
        break;
      }
      case 'response.failed': {
        sawDone = true;
        yield {
          type: 'error',
          message: event.response?.error?.message ?? 'The OmniRush gateway reported a failed response.',
        };
        break;
      }
      case 'error': {
        sawDone = true;
        yield {
          type: 'error',
          message: event.error?.message ?? event.message ?? 'The OmniRush stream returned an error.',
        };
        break;
      }
      default:
        break;
    }
  }

  if (!sawDone) {
    yield {
      type: 'error',
      message: 'The OmniRush stream ended before the response completed. Retry the request.',
    };
  }
}

/** Collapse a non-streaming Responses payload into text, reasoning and tool calls. */
export function collectResponse(payload) {  const text = [];
  const reasoning = [];
  const toolCalls = [];

  for (const item of payload?.output ?? []) {
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text') text.push(part.text ?? '');
        else if (part?.type === 'refusal') text.push(part.refusal ?? '');
      }
    } else if (item?.type === 'reasoning') {
      for (const part of item.summary ?? []) {
        if (part?.type === 'summary_text') reasoning.push(part.text ?? '');
      }
    } else if (item?.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `tool_${toolCalls.length}`,
        name: item.name ?? '',
        arguments: item.arguments ?? '',
      });
    }
  }

  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls,
    usage: normalizeUsage(payload?.usage),
    status: payload?.status ?? 'completed',
    reason: payload?.incomplete_details?.reason ?? null,
    error: payload?.error?.message ?? null,
  };
}

/**
 * Drain a normalized Responses event stream into the same shape as
 * collectResponse(). The gateway only streams, so non-streaming clients are
 * served from this.
 */
export async function collectStream(events) {
  const text = [];
  const reasoning = [];
  const tools = new Map();
  let usage = null;
  let status = 'completed';
  let reason = null;
  let error = null;

  for await (const event of events) {
    if (event.type === 'text') text.push(event.delta);
    else if (event.type === 'reasoning') reasoning.push(event.delta);
    else if (event.type === 'tool_start') tools.set(event.index, { id: event.id, name: event.name, arguments: '' });
    else if (event.type === 'tool_args') {
      const call = tools.get(event.index);
      if (call) call.arguments += event.delta;
    } else if (event.type === 'done') {
      usage = event.usage;
      status = event.status;
      reason = event.reason;
    } else if (event.type === 'error') {
      error = event.message;
    }
  }

  return {
    text: text.join(''),
    reasoning: reasoning.join(''),
    toolCalls: [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
    usage,
    status,
    reason,
    error,
  };
}

/** Build a Responses API object from collected stream output. */
export function responseObjectFromCollected(collected, model) {
  const output = [];
  if (collected.text) {
    output.push({
      type: 'message',
      id: `msg_${randomUUID().replaceAll('-', '')}`,
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: collected.text, annotations: [] }],
    });
  }
  for (const call of collected.toolCalls) {
    output.push({
      type: 'function_call',
      id: `fc_${randomUUID().replaceAll('-', '')}`,
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
      status: 'completed',
    });
  }

  return {
    id: `resp_${randomUUID().replaceAll('-', '')}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: collected.status,
    output,
    ...(collected.reason ? { incomplete_details: { reason: collected.reason } } : {}),
    usage: collected.usage
      ? {
          input_tokens: collected.usage.input_tokens,
          output_tokens: collected.usage.output_tokens,
          total_tokens: collected.usage.total_tokens,
          input_tokens_details: { cached_tokens: collected.usage.cached_tokens },
          output_tokens_details: { reasoning_tokens: collected.usage.reasoning_tokens },
        }
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Chat Completions -> Responses                                       */
/* ------------------------------------------------------------------ */

export function responsesBodyFromChat(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const instructions = [];
  const input = [];

  for (const message of messages) {
    const role = message?.role;

    if (role === 'system' || role === 'developer') {
      const text = contentText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === 'user') {
      input.push({ role: 'user', content: contentParts(message.content) });
      continue;
    }

    if (role === 'assistant') {
      const text = contentText(message.content);
      if (text) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.tool_calls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call?.id ?? `call_${input.length}`,
          name: call?.function?.name ?? '',
          arguments: call?.function?.arguments ?? '',
        });
      }
      continue;
    }

    if (role === 'tool' || role === 'function') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? message.name ?? 'call_0',
        output: contentText(message.content),
      });
    }
  }

  const out = {
    model: body?.model,
    input,
    stream: Boolean(body?.stream),
  };

  if (instructions.length) out.instructions = instructions.join('\n\n');
  if (body?.temperature !== undefined) out.temperature = body.temperature;
  if (body?.top_p !== undefined) out.top_p = body.top_p;
  const maxOut = body?.max_completion_tokens ?? body?.max_tokens;
  if (maxOut) out.max_output_tokens = maxOut;
  if (body?.reasoning_effort) out.reasoning = { effort: body.reasoning_effort };
  if (body?.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body?.user) out.user = body.user;

  const tools = mapTools(body?.tools, 'chat');
  if (tools.length) out.tools = tools;
  const toolChoice = mapToolChoice(body?.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  const format = mapResponseFormat(body?.response_format);
  if (format) out.text = { format };

  return out;
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages -> Responses                                     */
/* ------------------------------------------------------------------ */

export function responsesBodyFromMessages(body) {
  const input = [];

  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    const blocks = Array.isArray(message?.content)
      ? message.content
      : [{ type: 'text', text: String(message?.content ?? '') }];

    if (message?.role === 'assistant') {
      const parts = [];
      const calls = [];
      for (const block of blocks) {
        if (block?.type === 'text') parts.push({ type: 'output_text', text: block.text ?? '' });
        else if (block?.type === 'tool_use') {
          calls.push({
            type: 'function_call',
            call_id: block.id ?? `call_${input.length + calls.length}`,
            name: block.name ?? '',
            arguments: JSON.stringify(block.input ?? {}),
          });
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
      input.push(...calls);
      continue;
    }

    const parts = [];
    for (const block of blocks) {
      if (block?.type === 'text') parts.push({ type: 'input_text', text: block.text ?? '' });
      else if (block?.type === 'image') parts.push({ type: 'input_image', image_url: imageUrl(block.source) });
      else if (block?.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: block.tool_use_id ?? 'call_0',
          output: contentText(block.content),
        });
      }
    }
    if (parts.length) input.push({ role: 'user', content: parts });
  }

  const out = {
    model: body?.model,
    input,
    stream: Boolean(body?.stream),
  };

  const system = contentText(body?.system);
  if (system) out.instructions = system;
  if (body?.temperature !== undefined) out.temperature = body.temperature;
  if (body?.top_p !== undefined) out.top_p = body.top_p;
  if (body?.max_tokens) out.max_output_tokens = body.max_tokens;
  if (body?.metadata?.user_id) out.user = String(body.metadata.user_id);

  const tools = mapTools(body?.tools, 'anthropic');
  if (tools.length) out.tools = tools;
  const toolChoice = mapAnthropicToolChoice(body?.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  return out;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.type === 'text') return part.text ?? '';
        if (part?.type === 'image_url' || part?.type === 'image') return '[image]';
        return '';
      })
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function contentParts(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'input_text', text: String(content ?? '') }];
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'input_text', text: part });
    } else if (part?.type === 'text') {
      parts.push({ type: 'input_text', text: part.text ?? '' });
    } else if (part?.type === 'image_url') {
      parts.push({ type: 'input_image', image_url: part.image_url?.url ?? part.image_url });
    } else if (part?.type === 'input_image') {
      parts.push({ type: 'input_image', image_url: part.image_url });
    }
  }
  return parts.length ? parts : [{ type: 'input_text', text: '' }];
}

function imageUrl(source) {
  if (!source) return '';
  if (source.type === 'base64') return `data:${source.media_type ?? 'image/png'};base64,${source.data ?? ''}`;
  if (source.type === 'url') return source.url ?? '';
  return '';
}

function mapTools(tools, kind) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool) continue;
    if (kind === 'chat') {
      if (tool.type && tool.type !== 'function') continue;
      const fn = tool.function ?? tool;
      if (!fn?.name) continue;
      out.push({
        type: 'function',
        name: fn.name,
        description: fn.description ?? '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      });
    } else {
      if (tool.type && tool.type !== 'custom') continue;
      if (!tool.name) continue;
      out.push({
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      });
    }
  }
  return out;
}

function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') {
    return ['auto', 'none', 'required'].includes(choice) ? choice : undefined;
  }
  if (choice.type === 'function') {
    const name = choice.function?.name ?? choice.name;
    return name ? { type: 'function', name } : undefined;
  }
  return undefined;
}

function mapAnthropicToolChoice(choice) {
  if (!choice) return undefined;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'tool' && choice.name) return { type: 'function', name: choice.name };
  return undefined;
}

function mapResponseFormat(format) {
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema' && format.json_schema) {
    return {
      type: 'json_schema',
      name: format.json_schema.name ?? 'response',
      schema: format.json_schema.schema ?? { type: 'object' },
      strict: format.json_schema.strict ?? false,
    };
  }
  return undefined;
}

/** Map a Responses finish state to an OpenAI finish_reason. */
export function chatFinishReason(status, reason, hasTools) {
  if (hasTools) return 'tool_calls';
  if (status === 'incomplete') {
    if (reason === 'max_output_tokens') return 'length';
    if (reason === 'content_filter') return 'content_filter';
    return 'length';
  }
  return 'stop';
}

/** Map a Responses finish state to an Anthropic stop_reason. */
export function anthropicStopReason(status, reason, hasTools) {
  if (hasTools) return 'tool_use';
  if (status === 'incomplete') {
    if (reason === 'max_output_tokens') return 'max_tokens';
    return 'max_tokens';
  }
  return 'end_turn';
}
