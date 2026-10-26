import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chatFinishReason,
  collectResponse,
  responsesBodyFromChat,
  responsesBodyFromMessages,
} from '../src/translate/responses.js';

test('chat request: system prompt becomes instructions, messages become input items', () => {
  const body = responsesBodyFromChat({
    model: 'gpt-6-astra',
    stream: true,
    max_tokens: 4096,
    temperature: 0.3,
    reasoning_effort: 'high',
    messages: [
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'tool', tool_call_id: 'call_9', content: '42' },
    ],
  });

  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.stream, true);
  assert.equal(body.instructions, 'Be terse.');
  assert.equal(body.max_output_tokens, 4096);
  assert.equal(body.temperature, 0.3);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
    { type: 'function_call_output', call_id: 'call_9', output: '42' },
  ]);
});

test('chat request: tool calls and tools are converted to Responses shapes', () => {
  const body = responsesBodyFromChat({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Hanoi"}' } }],
      },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: {} } },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  });

  assert.deepEqual(body.tools, [
    { type: 'function', name: 'get_weather', description: 'Weather', parameters: { type: 'object', properties: {} } },
  ]);
  assert.deepEqual(body.tool_choice, { type: 'function', name: 'get_weather' });
  assert.deepEqual(body.input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Hanoi"}',
  });
});

test('anthropic request: system, tool_use and tool_result are converted', () => {
  const body = responsesBodyFromMessages({
    model: 'gpt-6-sol',
    max_tokens: 1000,
    system: [{ type: 'text', text: 'Be brief.' }],
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
    tools: [{ name: 'lookup', description: 'Look up', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto' },
  });

  assert.equal(body.instructions, 'Be brief.');
  assert.equal(body.max_output_tokens, 1000);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.tools[0], {
    type: 'function',
    name: 'lookup',
    description: 'Look up',
    parameters: { type: 'object', properties: {} },
  });
  assert.deepEqual(body.input, [
    { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: 'ok' },
  ]);
});

test('collectResponse: text, reasoning, tool calls and usage', () => {
  const result = collectResponse({
    status: 'completed',
    output: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought' }] },
      { type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
      { type: 'function_call', call_id: 'call_2', name: 'do', arguments: '{"a":1}' },
    ],
    usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
  });

  assert.equal(result.text, 'answer');
  assert.equal(result.reasoning, 'thought');
  assert.deepEqual(result.toolCalls, [{ id: 'call_2', name: 'do', arguments: '{"a":1}' }]);
  assert.deepEqual(result.usage, {
    input_tokens: 5,
    output_tokens: 7,
    total_tokens: 12,
    cached_tokens: 0,
    reasoning_tokens: 0,
  });
});

test('finish reasons map from the Responses status', () => {
  assert.equal(chatFinishReason('completed', null, false), 'stop');
  assert.equal(chatFinishReason('completed', null, true), 'tool_calls');
  assert.equal(chatFinishReason('incomplete', 'max_output_tokens', false), 'length');
});
