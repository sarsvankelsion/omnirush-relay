import { execFile } from 'node:child_process';
import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RelayError } from './errors.js';

const run = promisify(execFile);

/**
 * Read the device session the OmniRush desktop app already saved.
 *
 * Windows only: the app seals the file with Chromium's v10 scheme — a random
 * key wrapped by DPAPI in `Local State`, and AES-256-GCM over the payload.
 * The first refresh spends the app's token, so the app is signed out after it.
 */
export async function importFromDesktopApp({ appDir, platform = process.platform } = {}) {
  if (platform !== 'win32') {
    throw new RelayError(
      400,
      'import_unsupported',
      'Importing from the desktop app is only implemented on Windows. Use `omnirush-relay login` instead.',
    );
  }
  const directory = appDir ?? (process.env.APPDATA ? path.join(process.env.APPDATA, 'ai.omnirush.desktop') : null);
  if (!directory) throw new RelayError(400, 'import_no_app_data', 'APPDATA is not set; cannot find the OmniRush app data.');

  const accountFile = path.join(directory, 'omnirush-account.bin');
  const localStateFile = path.join(directory, 'Local State');

  let sealed;
  try {
    sealed = await readFile(accountFile);
  } catch {
    throw new RelayError(
      404,
      'import_not_found',
      `No saved OmniRush sign-in at ${accountFile}. Open the desktop app and sign in once, or use \`omnirush-relay login\`.`,
    );
  }

  const key = await unwrapMasterKey(localStateFile);
  const plain = decryptV10(sealed, key);

  let credentials;
  try {
    credentials = JSON.parse(plain);
  } catch {
    throw new RelayError(500, 'import_bad_payload', 'The saved OmniRush sign-in could not be decoded.');
  }
  if (!credentials?.gatewayUrl || !credentials?.accessToken || !credentials?.refreshToken) {
    throw new RelayError(500, 'import_incomplete', 'The saved OmniRush sign-in is missing credentials. Sign in again in the app.');
  }
  return {
    gatewayUrl: credentials.gatewayUrl,
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    rotation: Number(credentials.rotation) || 0,
  };
}

/** DPAPI-unwrap `os_crypt.encrypted_key` from Chromium's Local State. */
async function unwrapMasterKey(localStateFile) {
  const script = `
Add-Type -AssemblyName System.Security
$state = Get-Content -Raw -LiteralPath '${escapePowerShell(localStateFile)}' | ConvertFrom-Json
$raw = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
$blob = New-Object byte[] ($raw.Length - 5)
[Array]::Copy($raw, 5, $blob, 0, $blob.Length)
$key = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($key)
`.trim();

  let stdout;
  try {
    ({ stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 20_000,
    }));
  } catch (error) {
    throw new RelayError(500, 'import_key_failed', `Could not read the app's encryption key: ${firstLine(error?.stderr ?? error?.message)}`);
  }
  const key = Buffer.from(String(stdout).trim(), 'base64');
  if (key.length !== 32) throw new RelayError(500, 'import_key_failed', 'The app encryption key had an unexpected size.');
  return key;
}

function decryptV10(sealed, key) {
  if (sealed.subarray(0, 3).toString() !== 'v10') {
    throw new RelayError(500, 'import_bad_format', 'The saved OmniRush sign-in is not in the expected v10 format.');
  }
  const nonce = sealed.subarray(3, 15);
  const tag = sealed.subarray(sealed.length - 16);
  const ciphertext = sealed.subarray(15, sealed.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new RelayError(500, 'import_decrypt_failed', 'Could not decrypt the saved OmniRush sign-in. Sign in in the app again.');
  }
}

function escapePowerShell(value) {
  return String(value).replaceAll("'", "''");
}

function firstLine(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean)[0] ?? 'unknown error';
}

export function defaultAppDir(env = process.env) {
  return env.APPDATA ? path.join(env.APPDATA, 'ai.omnirush.desktop') : path.join(os.homedir(), 'AppData', 'Roaming', 'ai.omnirush.desktop');
}
