/**
 * antigravity-session-autotitle / persistent state & config store.
 *
 * Persists per-conversation state as atomic JSON files under PLUGIN_DATA
 * (falling back to ~/.gemini/config/plugin-data/antigravity-session-autotitle).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_OPTIONS, normalizeOptions } from './naming.mjs';

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;

export function resolveDataDir(env = process.env) {
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) return path.resolve(env.PLUGIN_DATA.trim());
  if (env.ANTIGRAVITY_AUTOTITLE_DATA_DIR && env.ANTIGRAVITY_AUTOTITLE_DATA_DIR.trim()) {
    return path.resolve(env.ANTIGRAVITY_AUTOTITLE_DATA_DIR.trim());
  }
  return path.join(os.homedir(), '.gemini', 'config', 'plugin-data', 'antigravity-session-autotitle');
}

function sessionFilePath(dataDir, conversationId) {
  if (typeof conversationId !== 'string' || !conversationId || !SAFE_ID_RE.test(conversationId)) {
    throw new TypeError(`invalid conversationId: ${String(conversationId)}`);
  }
  return path.join(dataDir, 'sessions', `${conversationId}.json`);
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function loadConfig(dataDir = resolveDataDir(), env = process.env) {
  const candidates = [];
  if (env.ANTIGRAVITY_AUTOTITLE_CONFIG && env.ANTIGRAVITY_AUTOTITLE_CONFIG.trim()) {
    candidates.push(path.resolve(env.ANTIGRAVITY_AUTOTITLE_CONFIG.trim()));
  }
  candidates.push(path.join(dataDir, 'config.json'));

  for (const configPath of candidates) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return normalizeOptions(raw);
    } catch {
      return DEFAULT_OPTIONS;
    }
  }
  return DEFAULT_OPTIONS;
}

export function createInitialState(currentTitle = '', reason = 'default_unlocked') {
  return {
    schema: 1,
    mode: 'auto',
    reason,
    baselineTitle: currentTitle,
    tasks: [],
    initialNamed: false,
    calibrated: false,
    evaluatedUserCount: 0,
    lastPromptedFingerprint: '',
    lastAttemptAt: 0,
    lastUpdatedAt: 0,
    lastOutcome: 'not_evaluated',
    lastTriggerReason: null,
    pendingRefresh: false,
    pendingWrite: null,
  };
}

export class SessionStore {
  constructor(dataDir = resolveDataDir()) {
    this.dataDir = dataDir;
  }

  get(conversationId) {
    const filePath = sessionFilePath(this.dataDir, conversationId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return parsed?.schema === 1 ? parsed : null;
    } catch {
      return null;
    }
  }

  set(conversationId, state) {
    const filePath = sessionFilePath(this.dataDir, conversationId);
    writeJsonAtomic(filePath, state);
    return state;
  }

  delete(conversationId) {
    const filePath = sessionFilePath(this.dataDir, conversationId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}
