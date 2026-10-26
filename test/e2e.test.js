import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { Account } from '../src/auth.js';
import { Gateway } from '../src/gateway.js';
import { createServer } from '../src/server.js';

const TEXT_STREAM = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[]}}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"Hel"}\n\n',
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"delta":"lo"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
].join('');

const TOOL_STREAM = [
  'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"get_weather"}}\n\n',
  'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"city\\":\\"Hanoi\\"}"}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed","usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}\n\n',
].join('');

test('relay end to end', async (t) => {
  const state = {
    access: 'access-1',
    refresh: 'refresh-1',
    refreshes: 0,
    gatewayUrl: '',
    lastBody: null,
  };

  const upstream = await startUpstream(state);
  state.gatewayUrl = `http://127.0.0.1:${upstream.port}/omnirush/v1`;

  const account = new Account({ file: null, fetchImpl: fetch });
  account.gatewayUrl = state.gatewayUrl;
  account.accessToken = state.access;
  account.refreshToken = state.refresh;
  account.source = 'env';

  const gateway = new Gateway({ account });
  const server = createServer({ account, gateway, apiKey: 'sk-test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.server.close(resolve));
  });

  await t.test('rejects a bad local API key', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_api_key');
  });

  await t.test('lists models in OpenAI list shape', async () => {
    const res = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-test' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'list');
    assert.deepEqual(body.data.map((model) => model.id), ['gpt-6-astra']);
  });

  await t.test('streams chat completions', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /"delta":\{"role":"assistant","content":""\}/);
    assert.match(text, /"delta":\{"content":"Hel"\}/);
    assert.match(text, /"delta":\{"content":"lo"\}/);
    assert.match(text, /"finish_reason":"stop"/);
    assert.match(text, /data: \[DONE\]/);
  });

  await t.test('streams chat tool calls with arguments', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        stream: true,
        messages: [{ role: 'user', content: 'TOOL' }],
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      }),
    });
    const text = await res.text();
    assert.match(text, /"tool_calls":\[\{"index":0,"id":"call_1","type":"function","function":\{"name":"get_weather","arguments":""\}\}\]/);
    assert.match(text, /"function":\{"arguments":"\{\\"city\\":\\"Hanoi\\"\}"\}/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  });

  await t.test('translates the Anthropic request and streams Messages events', async () => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-6-astra',
        max_tokens: 100,
        system: 'Be brief.',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /"delta":\{"type":"text_delta","text":"Hel"\}/);
    assert.match(text, /event: message_delta/);
    assert.match(text, /"stop_reason":"end_turn"/);
    assert.match(text, /event: message_stop/);

    assert.equal(state.lastBody.instructions, 'Be brief.');
    assert.deepEqual(state.lastBody.input, [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
  });

  await t.test('returns a non-streaming chat completion assembled from the stream', async () => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.choices[0].message.content, 'Hello');
    assert.equal(body.choices[0].finish_reason, 'stop');
    assert.equal(body.usage.total_tokens, 7);
  });

  await t.test('sends the gateway contract the gateway requires', async () => {
    assert.equal(state.lastBody.store, false);
    assert.equal(state.lastBody.stream, true);
    assert.equal(state.lastHeaders['user-agent'], 'omnirush');
    assert.match(state.lastHeaders['x-omnirush-client'], /^gui\//);
    assert.ok(state.lastHeaders['x-omnirush-client-request-id']);
  });

  await t.test('renews the session on 401 and replays the request', async () => {
    state.access = 'access-2';
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-6-astra', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, 'Hello');
    assert.equal(state.refreshes, 1);
    assert.equal(account.accessToken, 'access-2');
    assert.equal(account.refreshToken, 'refresh-2');
  });
});

function startUpstream(state) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = req.headers.authorization;

    if (url.pathname === '/omnirush/device/refresh') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.refresh_token !== 'refresh-1') {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"refresh_token_invalid"}');
          return;
        }
        state.refreshes += 1;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ access_token: 'access-2', refresh_token: 'refresh-2', gateway_url: state.gatewayUrl }));
      });
      return;
    }

    if (url.pathname === '/omnirush/v1/models') {
      if (auth !== `Bearer ${state.access}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"device_token_invalid"}');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'gpt-6-astra', display_name: 'GPT 6 Astra' }] }));
      return;
    }

    if (url.pathname === '/omnirush/v1/responses') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        state.lastBody = body;
        state.lastHeaders = req.headers;
        if (auth !== `Bearer ${state.access}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"detail":"device_token_invalid"}');
          return;
        }
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(JSON_RESPONSE));
          return;
        }
        const wantsTool = JSON.stringify(body.input).includes('TOOL');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(wantsTool ? TOOL_STREAM : TEXT_STREAM);
      });
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
