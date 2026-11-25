/**
 * antigravity-session-autotitle / title writer CLI.
 *
 * Invoked by the agent via `run_command` (which receives ANTIGRAVITY_LS_ADDRESS
 * and ANTIGRAVITY_CSRF_TOKEN). Validates structured tasks, renders the canonical
 * `[对象](动作)任务` title, detects manual renames, updates the conversation
 * title through ConversationService/UpdateConversation, and persists state.
 */

import { ConversationsClient } from './conversations-api.mjs';
import { HookController } from './controller.mjs';
import { loadConfig, resolveDataDir, SessionStore } from './store.mjs';

function parseArgs(argv) {
  const args = {
    conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID ?? '',
    dataDir: '',
    payload: '',
    payloadBase64: '',
    userTurns: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--conversation-id' && next !== undefined) {
      args.conversationId = next;
      i += 1;
    } else if (flag === '--data-dir' && next !== undefined) {
      args.dataDir = next;
      i += 1;
    } else if (flag === '--payload' && next !== undefined) {
      args.payload = next;
      i += 1;
    } else if (flag === '--payload-base64' && next !== undefined) {
      args.payloadBase64 = next;
      i += 1;
    } else if (flag === '--user-turns' && next !== undefined) {
      const parsed = Number.parseInt(next, 10);
      if (Number.isInteger(parsed) && parsed >= 0) args.userTurns = parsed;
      i += 1;
    }
  }
  return args;
}

async function readStdinIfPiped() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let rawJson = args.payload;
  if (!rawJson && args.payloadBase64) {
    rawJson = Buffer.from(args.payloadBase64, 'base64').toString('utf8');
  }
  if (!rawJson) {
    rawJson = await readStdinIfPiped();
  }

  if (!rawJson) {
    process.stdout.write(`${JSON.stringify({ ok: false, outcome: 'missing_payload' })}\n`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    process.stdout.write(`${JSON.stringify({ ok: false, outcome: 'invalid_json' })}\n`);
    return;
  }

  const dataDir = args.dataDir || resolveDataDir();
  const options = loadConfig(dataDir);
  const store = new SessionStore(dataDir);
  const api = new ConversationsClient();
  const controller = new HookController({ store, api, options, dataDir });

  const result = await controller.applyTitle({
    conversationId: args.conversationId,
    payload,
    meaningfulUserCount: args.userTurns,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, outcome: 'internal_error', message: String(error?.message ?? error) })}\n`);
});
