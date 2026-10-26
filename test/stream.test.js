import assert from 'node:assert/strict';
import test from 'node:test';
import { readSse } from '../src/sse.js';
import { readResponseStream } from '../src/translate/responses.js';

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('readSse: frames split across chunks, CRLF and comments', async () => {
  const frames = [];
  for await (const frame of readSse(
    streamOf([': keepalive\r\n\r\nevent: a\r\ndata: {"x":', '1}\r\n\r\ndata: [DONE]\r\n\r\n']),
  )) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [
    { event: 'a', data: '{"x":1}' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('readResponseStream: text, tool call and usage', async () => {
  const events = [
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather"}}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":\\"Hanoi\\"}"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"done"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}\n\n',
  ];

  const out = [];
  for await (const event of readResponseStream(streamOf(events))) out.push(event);

  assert.deepEqual(out, [
    { type: 'tool_start', index: 0, id: 'call_1', name: 'get_weather' },
    { type: 'tool_args', index: 0, delta: '{"city":"Hanoi"}' },
    { type: 'text', delta: 'done' },
    {
      type: 'done',
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7, cached_tokens: 0, reasoning_tokens: 0 },
      status: 'completed',
      reason: null,
    },
  ]);
});

test('readResponseStream: an unterminated stream is reported as an error', async () => {
  const out = [];
  for await (const event of readResponseStream(
    streamOf(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n']),
  )) {
    out.push(event);
  }
  assert.equal(out.at(-1).type, 'error');
});
