/**
 * antigravity-session-autotitle / transcript.jsonl reader.
 *
 * Extracts visible user requests and assistant responses from Antigravity's
 * transcript.jsonl without pulling in tool outputs, reasoning traces, or
 * injected system metadata.
 */

import fs from 'node:fs';
import { meaningfulUserText, titleFingerprint } from './naming.mjs';

const USER_REQUEST_RE = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u;

export function extractUserRequestText(rawContent) {
  if (typeof rawContent !== 'string') return '';
  const match = USER_REQUEST_RE.exec(rawContent);
  return (match ? match[1] : rawContent).trim();
}

export function parseTranscriptLines(rawText) {
  const messages = [];
  if (typeof rawText !== 'string' || !rawText.trim()) return messages;
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'USER_INPUT' && entry.source === 'USER_EXPLICIT') {
      const text = extractUserRequestText(entry.content);
      if (text) {
        messages.push({
          id: `step-${entry.step_index ?? messages.length}`,
          role: 'user',
          text,
        });
      }
      continue;
    }
    if (entry.type === 'PLANNER_RESPONSE' && typeof entry.content === 'string' && entry.content.trim()) {
      messages.push({
        id: `step-${entry.step_index ?? messages.length}`,
        role: 'assistant',
        text: entry.content.trim(),
      });
    }
  }
  return messages;
}

export function readTranscriptSummary(transcriptPath, lastUserInput = '') {
  let messages = [];
  if (typeof transcriptPath === 'string' && transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      messages = parseTranscriptLines(raw);
    } catch {
      messages = [];
    }
  }

  const trimmedLast = extractUserRequestText(lastUserInput);
  const users = messages.filter((m) => m.role === 'user');
  if (trimmedLast && users.at(-1)?.text !== trimmedLast) {
    messages.push({ id: `input-${messages.length}`, role: 'user', text: trimmedLast });
  }

  const allUsers = messages.filter((m) => m.role === 'user');
  const allAssistants = messages.filter((m) => m.role === 'assistant');
  const meaningfulUsers = allUsers.filter((m) => meaningfulUserText(m.text));

  const userSig = titleFingerprint(JSON.stringify(allUsers.map((m) => m.text)));
  const fullSig = titleFingerprint(JSON.stringify(messages.map((m) => [m.role, m.text])));

  return {
    messages,
    userCount: allUsers.length,
    meaningfulUserCount: meaningfulUsers.length,
    assistantCount: allAssistants.length,
    latestUserText: allUsers.at(-1)?.text ?? trimmedLast,
    latestMeaningfulUserText: meaningfulUsers.at(-1)?.text ?? '',
    userFingerprint: userSig,
    fullFingerprint: fullSig,
  };
}
