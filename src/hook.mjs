/**
 * antigravity-session-autotitle / PreInvocation hook entrypoint.
 *
 * Reads JSON payload from stdin and writes JSON result to stdout.
 * Always fails open (`{}`) so it never blocks the main agent loop.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConversationsClient } from './conversations-api.mjs';
import { HookController } from './controller.mjs';
import { loadConfig, resolveDataDir, SessionStore } from './store.mjs';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLUGIN_ROOT = path.resolve(THIS_DIR, '..');

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const raw = await readStdin();
  if (!raw) {
    process.stdout.write('{}\n');
    return;
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stdout.write('{}\n');
    return;
  }

  if (input?.hookEventName !== 'PreInvocation') {
    process.stdout.write('{}\n');
    return;
  }

  const pluginRoot = process.env.PLUGIN_ROOT?.trim() || DEFAULT_PLUGIN_ROOT;
  const dataDir = resolveDataDir();
  const options = loadConfig(dataDir);
  const store = new SessionStore(dataDir);
  const api = new ConversationsClient();
  const controller = new HookController({ store, api, options, pluginRoot, dataDir });

  const out = await controller.handlePreInvocation(input);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().catch(() => {
  process.stdout.write('{}\n');
});
