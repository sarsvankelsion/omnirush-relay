# omnirush-relay

A tiny local API server that lets any OpenAI- or Anthropic-compatible client use an
[OmniRush](https://omnirush.ai) account — **without running the desktop app**.

It speaks:

| Route | Protocol |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming and non-streaming) |
| `POST /v1/messages` | Anthropic Messages (streaming and non-streaming) |
| `POST /v1/responses` | OpenAI Responses API (translated when non-streaming) |
| `GET /v1/models` | OpenAI model list |

Internally it talks to OmniRush's own gateway (`https://omnirush.ai/omnirush/v1`),
which uses the OpenAI Responses API. One Node process, no runtime dependencies.

```
client  ──/v1/chat/completions──▶  omnirush-relay  ──/omnirush/v1/responses──▶  omnirush.ai
client  ──/v1/messages──────────▶   (local, ~40 MB)                              (device token)
```

## Before you use this

Read this part, it is not boilerplate.

- **This is outside OmniRush's terms of service.** The account is meant to be used
  through their app and CLI. Running the account from a third-party client can get
  it rate-limited or banned. That risk is yours.
- **The desktop app uploads session traces to OmniRush. This relay does not.** Model
  traffic still reaches their servers, but their capture/session pipeline does not.
  Assume the two are not equivalent, and decide whether that is acceptable to you.
- OmniRush is a free service funded by that data. If you want to support it, use
  their app.

None of this is hidden in the code: it is what the gateway protocol happens to be.

## Requirements

- Node.js 20 or newer. Nothing else. No `npm install` needed.
- An OmniRush account (GitHub sign-in, 7+ days old, as their signup requires).

## Quick start

Not on npm yet — clone it and run the CLI directly:

```bash
git clone https://github.com/sarsvankelsion/omnirush-relay.git
cd omnirush-relay

# 1. Sign in once (opens a browser, prints a code)
node bin/omnirush-relay.js login

# 2. Start the relay
node bin/omnirush-relay.js serve

# 3. Point any client at it
#    base URL: http://127.0.0.1:8787/v1
#    API key:  the sk-omnirush-... key printed at startup
```

`login` creates its own device session. The desktop app can stay signed in; the two
do not share tokens.

Add a shell alias if you will use it often:

```bash
alias omnirush-relay="node \"$PWD/bin/omnirush-relay.js\""
```

## Client configuration

**OpenAI SDK (Python)**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="sk-omnirush-...")

stream = client.chat.completions.create(
    model="gpt-6-astra",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**curl**

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer sk-omnirush-..." \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-6-astra","messages":[{"role":"user","content":"hello"}]}'
```

**Claude Code / Anthropic SDK**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=sk-omnirush-...
export ANTHROPIC_MODEL=gpt-6-astra
```

Any GUI client works the same way: base URL `http://127.0.0.1:8787/v1`, the printed
API key, and one of the model ids from `GET /v1/models`.

## Commands

```
omnirush-relay login [--name <device>] [--gateway <url>] [--no-open]
omnirush-relay import            Import the desktop app's sign-in (Windows)
omnirush-relay serve [--port 8787] [--host 127.0.0.1] [--api-key <key>]
omnirush-relay status [--json]   Session state and daily token usage
omnirush-relay models [--json]
omnirush-relay logout            Remove the local session (server not contacted)
```

## How the account works

- Sign-in is OmniRush's device flow: `POST /omnirush/device/authorize`, then poll
  `/omnirush/device/token` until the browser approves.
- The access token is short-lived. The refresh token rotates on every use
  (`POST /omnirush/device/refresh`, 120 s grace on the old one).
- Rotation is single-flight and written to disk atomically. If the process dies
  mid-refresh, the next start re-sends the same token inside the grace window and
  the server returns the same rotated pair.
- Two processes must not share one `auth.json`. If they do, the server answers
  `409`, and the loser adopts the pair the winner saved instead of signing out.

### The gateway contract

The model endpoint is strict. The relay always sends:

| Requirement | Value |
| --- | --- |
| `User-Agent` | `omnirush` — a bare product label; a versioned one is refused |
| `X-OmniRush-Client` | `gui/<version>` (informational; override with `OMNIRUSH_CLIENT_HEADER`) |
| `store` | `false` — the gateway refuses `true` |
| `stream` | `true` — the gateway refuses non-streaming requests |
| `input` | a list of items, never a bare string |

Because the upstream only streams, non-streaming client requests are assembled by
the relay from the event stream. The result is a normal `chat.completion` /
`message` / `response` object.

## Files

```
~/.omnirush-relay/auth.json      device session (0600 on POSIX; user-profile ACL on Windows)
~/.omnirush-relay/config.json    port, host, local API key
```

Set `OMNIRUSH_RELAY_HOME` to move both. Set `OMNIRUSH_RELAY_API_KEY` to override the
local key. `OMNIRUSH_ACCESS_TOKEN` / `OMNIRUSH_REFRESH_TOKEN` / `OMNIRUSH_GATEWAY_URL`
make the relay use credentials from the environment and never write a file.

## Importing the desktop app's sign-in (Windows, optional)

```bash
omnirush-relay import
```

This decrypts the session the app saved (`%APPDATA%\ai.omnirush.desktop\omnirush-account.bin`,
Chromium's v10 scheme: a DPAPI-wrapped key plus AES-256-GCM). It is the fastest path
if the app is already signed in — but the app holds the same refresh token, so the
first renewal signs the app out. `login` is the cleaner option.

## Running it in the background

**Windows** — a shortcut in `shell:startup` running:

```
node "C:\path\to\omnirush-relay\bin\omnirush-relay.js" serve
```

**Linux (systemd)** — a user unit with `ExecStart=/usr/bin/node .../bin/omnirush-relay.js serve`.

The relay is a plain foreground process on purpose: no daemon, no tray, no Electron.

## Limitations

- Text, images (data URLs), tool calling and reasoning summaries are translated.
  Audio/voice endpoints and file uploads are not implemented.
- Tool schemas are passed through as given; provider-side strict schema validation
  is not performed.
- `stop` / `stop_sequences` are dropped: the Responses API has no equivalent.
- Anthropic `thinking` blocks are emitted only when the request enables thinking.
- The gateway allowlist is theirs. If OmniRush changes it, set `OMNIRUSH_USER_AGENT`
  and/or `OMNIRUSH_CLIENT_HEADER`, or update the relay.

## Development

```bash
node --test
```

The test suite covers the request translation, SSE parsing, the full HTTP relay
against a fake gateway, and the 401 → refresh → replay path.

## License

MIT. Not affiliated with OmniRush.
