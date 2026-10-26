import os from 'node:os';
import path from 'node:path';
import { Account, DEFAULT_GATEWAY_URL } from './auth.js';
import { banner, loadConfig } from './config.js';
import { RelayError } from './errors.js';
import { Gateway } from './gateway.js';
import { importFromDesktopApp } from './import-app.js';
import { createServer } from './server.js';
import { openBrowser, VERSION } from './util.js';
import { removeFile } from './store.js';

export function relayHome(env = process.env) {
  return env.OMNIRUSH_RELAY_HOME?.trim() || path.join(os.homedir(), '.omnirush-relay');
}

export function authFile(env = process.env) {
  return path.join(relayHome(env), 'auth.json');
}

export function configFile(env = process.env) {
  return path.join(relayHome(env), 'config.json');
}

export async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const args = parseArgs(rest);

  switch (command) {
    case 'login':
      return login(args);
    case 'import':
      return importCommand(args);
    case 'serve':
    case 'start':
      return serve(args);
    case 'status':
      return status(args);
    case 'logout':
      return logout(args);
    case 'models':
      return models(args);
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'help':
    case '--help':
    case '-h':
      return usage();
    default:
      usage();
      throw new RelayError(400, 'unknown_command', `Unknown command: ${command}`);
  }
}

async function login(args) {
  const account = new Account({ file: authFile(), log: (line) => console.error(line) });
  await account.load();
  if (args.gateway) account.gatewayUrl = String(args.gateway);
  account.gatewayUrl ??= DEFAULT_GATEWAY_URL;

  const result = await account.signIn({
    deviceName: args.name ? String(args.name) : `omnirush-relay (${os.hostname()})`,
    onAuthorize: (info) => {
      console.log('');
      console.log('  Open this link to sign in to OmniRush:');
      console.log(`  ${info.verification_uri_complete}`);
      if (info.user_code) console.log(`  Code: ${info.user_code}`);
      if (!args['no-open']) openBrowser(info.verification_uri_complete, console.log);
      console.log('');
      console.log('  Waiting for you to approve it in the browser...');
    },
  });

  console.log('');
  console.log(`  Signed in. Gateway: ${result.gatewayUrl}`);
  console.log('  Next: `omnirush-relay serve`');
}

async function importCommand() {
  const credentials = await importFromDesktopApp();
  const account = new Account({ file: authFile() });
  account.gatewayUrl = credentials.gatewayUrl;
  account.accessToken = credentials.accessToken;
  account.refreshToken = credentials.refreshToken;
  account.rotation = credentials.rotation;
  account.source = 'file';
  await account.save();

  console.log('');
  console.log(`  Imported the desktop app's sign-in. Gateway: ${credentials.gatewayUrl}`);
  console.log('  The desktop app holds the same refresh token, so the first renewal here');
  console.log('  signs the app out. That is expected if you are retiring it.');
}

async function serve(args) {
  const config = await loadConfig(configFile());
  if (args.port) config.port = Number(args.port);
  if (args.host) config.host = String(args.host);
  if (args['api-key']) config.apiKey = String(args['api-key']);

  const account = new Account({ file: authFile(), log: (line) => console.error(line) });
  const signedIn = await account.load();
  if (!signedIn) {
    console.error('');
    console.error('  warning: not signed in. Model calls will fail until you run `omnirush-relay login`.');
  }

  const gateway = new Gateway({ account, log: (line) => console.error(line) });

  const server = createServer({
    account,
    gateway,
    apiKey: config.apiKey,
    log: (line) => console.error(line),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(banner(config, account));

  if (signedIn) {
    try {
      const catalog = await gateway.models();
      console.log(`  models     ${catalog.data.map((model) => model.id).join(', ') || '(none advertised)'}`);
      console.log('');
    } catch (error) {
      console.error(`  warning: could not read the model catalog: ${error.message}`);
    }
  }

  console.log('  Press Ctrl+C to stop.');
  console.log('');

  const shutdown = () => {
    console.log('\n  Stopping...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function status(args) {
  const account = new Account({ file: authFile() });
  if (!(await account.load())) {
    console.log('Not signed in. Run `omnirush-relay login`.');
    process.exitCode = 1;
    return;
  }

  console.log(`gateway    ${account.gatewayUrl}`);
  console.log(`rotation   ${account.rotation}`);
  console.log(`saved      ${account.updatedAt ? new Date(account.updatedAt).toISOString() : '(never)'}`);

  try {
    const profile = await account.profile();
    if (args.json) {
      console.log(JSON.stringify(profile, null, 2));
      return;
    }
    const usage = profile?.usage ?? profile;
    const used = usage?.used_tokens ?? usage?.usedTokens;
    const limit = usage?.token_limit ?? usage?.tokenLimit;
    if (used !== undefined || limit !== undefined) {
      console.log(`tokens     ${used ?? '?'} / ${limit ?? '?'}`);
    }
    if (usage?.resets_at) console.log(`resets     ${usage.resets_at}`);
    const id = profile?.account_id ?? profile?.accountId ?? profile?.id;
    if (id) console.log(`account    ${id}`);
  } catch (error) {
    console.log(`profile    unavailable (${error.message})`);
    process.exitCode = 1;
  }
}

async function logout() {
  await removeFile(authFile());
  await removeFile(`${authFile()}.refreshing.json`);
  console.log('Local sign-in removed. The account server is not contacted.');
}

async function models(args) {
  const account = new Account({ file: authFile() });
  if (!(await account.load())) throw new RelayError(401, 'not_signed_in', 'Not signed in. Run `omnirush-relay login` first.');
  const gateway = new Gateway({ account });
  const catalog = await gateway.models();
  if (args.json) {
    console.log(JSON.stringify(catalog.data, null, 2));
    return;
  }
  for (const model of catalog.data) {
    console.log(`${model.id}${model.name && model.name !== model.id ? `  (${model.name})` : ''}`);
  }
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const eq = item.indexOf('=');
      if (eq !== -1) {
        args[item.slice(2, eq)] = item.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        args[item.slice(2)] = argv[i + 1];
        i += 1;
      } else {
        args[item.slice(2)] = true;
      }
    } else if (item.startsWith('-') && item.length > 1) {
      args[item.slice(1)] = true;
    } else {
      args._.push(item);
    }
  }
  return args;
}

function usage() {  console.log(`
  omnirush-relay ${VERSION}

  Usage:
    omnirush-relay login [--name <device>] [--gateway <url>] [--no-open]
    omnirush-relay import            Import the desktop app's sign-in (Windows)
    omnirush-relay serve [--port 8787] [--host 127.0.0.1] [--api-key <key>]
    omnirush-relay status [--json]
    omnirush-relay models [--json]
    omnirush-relay logout
    omnirush-relay --version

  Files:
    ~/.omnirush-relay/auth.json      device session (0600)
    ~/.omnirush-relay/config.json    port, host, local API key

  Environment:
    OMNIRUSH_RELAY_HOME              move both files
    OMNIRUSH_RELAY_API_KEY           local API key, overrides config.json
    OMNIRUSH_ACCESS_TOKEN / OMNIRUSH_REFRESH_TOKEN / OMNIRUSH_GATEWAY_URL
                                     use credentials from the environment
`);
}
