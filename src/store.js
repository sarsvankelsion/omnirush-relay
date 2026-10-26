import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Read and parse a JSON file. Returns null when it does not exist. */
export async function readJson(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Write JSON atomically: an owner-only temporary file renamed over the target,
 * so a reader never sees a half-written file.
 */
export async function writeJson(file, value) {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Delete a file, ignoring a missing one. */
export async function removeFile(file) {
  await rm(file, { force: true }).catch(() => undefined);
}
