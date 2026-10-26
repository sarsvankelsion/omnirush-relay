import { RelayError } from './errors.js';

/**
 * Read a Server-Sent-Events body and yield `{event, data}` frames.
 *
 * Handles CRLF, comment lines, multi-line `data:` fields and the bare
 * `data: [DONE]` sentinel. Throws when the upstream goes silent for `idleMs`.
 */
export async function* readSse(stream, { idleMs = 180_000, signal } = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await readWithIdle(reader, idleMs, signal);
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
      }
    }
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
    const last = parseFrame(buffer);
    if (last) yield last;
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

function readWithIdle(reader, idleMs, signal) {
  if (!idleMs) return reader.read();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RelayError(504, 'upstream_stream_stalled', 'The OmniRush stream went quiet and was closed. Retry the request.'));
    }, idleMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new RelayError(499, 'client_closed', 'The client closed the request.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function parseFrame(raw) {
  if (!raw || !raw.trim()) return null;
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

export function sseHeaders(extra = {}) {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extra,
  };
}

export function writeData(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

export function writeEvent(res, name, payload) {
  res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}
