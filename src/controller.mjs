/**
 * antigravity-session-autotitle / lifecycle hook & title-apply controller.
 *
 * Architecture:
 *   1. PreInvocation Hook (pure local, no LS env required):
 *      Checks local session state & transcript.jsonl. When an evaluation is
 *      due, injects a compact systemMessage instructing the agent to run
 *      `src/apply-title.mjs` via `run_command`.
 *   2. apply-title.mjs (runs inside agent's `run_command`, which receives
 *      ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN):
 *      Reads current conversation metadata, detects manual renames (auto-lock),
 *      validates & renders the canonical `[对象](动作)任务` title, writes it via
 *      ConversationService/UpdateConversation, and persists updated state.
 */

import path from 'node:path';
import { extractConversationInfo } from './conversations-api.mjs';
import {
  buildHookDirective,
  evaluateNamingPayload,
  isCurrentTitleFormat,
  isExplicitTopicChange,
  isLegacyTitleFormat,
  titlesEquivalent,
} from './naming.mjs';
import { createInitialState } from './store.mjs';
import { readTranscriptSummary } from './transcript.mjs';

function isEligibleConversation(info, options) {
  if (!info) return true;
  if (info.archived) return false;
  if (!options.manageSubsessions && info.parentConversationId) return false;
  return true;
}

/**
 * Detect whether the user manually renamed the conversation outside this plugin.
 * If so, lock the session persistently so auto-naming never overwrites manual titles.
 */
function detectExternalRename(state, currentTitle) {
  if (!state || state.mode === 'locked') return false;
  if (!state.initialNamed && !state.baselineTitle) return false;
  if (!currentTitle) return false;
  if (state.baselineTitle && !titlesEquivalent(currentTitle, state.baselineTitle)) {
    state.mode = 'locked';
    state.reason = 'external_rename';
    state.baselineTitle = currentTitle;
    state.lastOutcome = 'locked_external_rename';
    return true;
  }
  return false;
}

function decideTrigger({ state, currentTitle, transcript, options, now }) {
  if (state.mode === 'locked') {
    return { shouldTrigger: false, reason: 'locked' };
  }
  if (transcript.meaningfulUserCount === 0) {
    return { shouldTrigger: false, reason: 'no_meaningful_input' };
  }
  // Avoid injecting repeatedly across multiple tool-calling invocations in the same user turn.
  if (state.lastPromptedFingerprint === transcript.userFingerprint) {
    return { shouldTrigger: false, reason: 'already_prompted_for_turn' };
  }

  // 1. Initial naming on the first meaningful user turn.
  if (!state.initialNamed) {
    return { shouldTrigger: true, mode: 'initial', reason: 'initial_request' };
  }

  // 2. First post-reply calibration once an assistant response exists and a follow-up turn arrives.
  if (!state.calibrated && transcript.assistantCount >= 1) {
    return { shouldTrigger: true, mode: 'adaptive', reason: 'first_calibration' };
  }

  if (options.mode === 'initial') {
    return { shouldTrigger: false, reason: 'initial_mode_only' };
  }

  // 3. Adaptive updates respect cooldown.
  if (state.lastAttemptAt > 0 && now - state.lastAttemptAt < options.cooldownMs) {
    return { shouldTrigger: false, reason: 'cooldown' };
  }

  // 4. Legacy format migration or non-canonical title cleanup.
  if (currentTitle && (isLegacyTitleFormat(currentTitle) || !isCurrentTitleFormat(currentTitle))) {
    return { shouldTrigger: true, mode: 'adaptive', reason: 'format_normalization' };
  }

  // 5. Explicit topic switch.
  if (currentTitle && isExplicitTopicChange(currentTitle, transcript.latestMeaningfulUserText)) {
    return { shouldTrigger: true, mode: 'adaptive', reason: 'topic_change' };
  }

  // 6. Enough new meaningful user turns accumulated.
  const newTurns = transcript.meaningfulUserCount - (state.evaluatedUserCount ?? 0);
  if (newTurns >= options.minNewUserTurns) {
    return { shouldTrigger: true, mode: 'adaptive', reason: 'turn_threshold' };
  }

  return { shouldTrigger: false, reason: 'threshold_not_met' };
}

export class HookController {
  constructor({ store, api, options, pluginRoot = process.cwd(), dataDir = store?.dataDir, now = Date.now }) {
    this.store = store;
    this.api = api;
    this.options = options;
    this.pluginRoot = pluginRoot;
    this.dataDir = dataDir ?? store?.dataDir ?? '';
    this.now = now;
  }

  async handlePreInvocation(input) {
    const conversationId = input?.conversationId;
    if (!conversationId) return {};

    // Read LS metadata only when available (optional in hook process).
    const convRes = this.api?.isConfigured?.() ? await this.api.getConversation(conversationId) : { ok: false, data: null };
    const info = convRes.ok ? extractConversationInfo(convRes.data) : null;
    if (!isEligibleConversation(info, this.options)) {
      return {};
    }

    let state = this.store.get(conversationId);
    const currentTitle = info?.title || state?.baselineTitle || '';
    if (!state) {
      state = createInitialState(currentTitle, 'default_unlocked');
    }

    if (info && detectExternalRename(state, info.title)) {
      this.store.set(conversationId, state);
      return {};
    }

    const transcript = readTranscriptSummary(input?.transcriptPath, input?.lastUserInput ?? '');
    const decision = decideTrigger({
      state,
      currentTitle,
      transcript,
      options: this.options,
      now: this.now(),
    });

    if (!decision.shouldTrigger) {
      this.store.set(conversationId, state);
      return {};
    }

    state.lastPromptedFingerprint = transcript.userFingerprint;
    state.lastAttemptAt = this.now();
    state.lastTriggerReason = decision.reason;
    this.store.set(conversationId, state);

    const scriptPath = path.join(this.pluginRoot, 'src', 'apply-title.mjs');
    const directive = buildHookDirective({
      conversationId,
      scriptPath,
      dataDir: this.dataDir,
      currentTitle,
      tasks: state.tasks,
      mode: decision.mode,
      triggerReason: decision.reason,
      meaningfulUserCount: transcript.meaningfulUserCount,
      options: this.options,
    });

    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage: directive,
          },
        },
      ],
    };
  }

  async applyTitle({ conversationId, payload, meaningfulUserCount }) {
    if (!conversationId) {
      return { ok: false, outcome: 'missing_conversation_id', title: '' };
    }

    const convRes = await this.api.getConversation(conversationId);
    if (!convRes.ok) {
      let state = this.store.get(conversationId) ?? createInitialState('', 'default_unlocked');
      state.lastOutcome = convRes.errorCode ?? 'ls_unreachable';
      state.lastUpdatedAt = this.now();
      this.store.set(conversationId, state);
      return { ok: false, outcome: state.lastOutcome, title: '' };
    }

    const info = extractConversationInfo(convRes.data);
    if (!isEligibleConversation(info, this.options)) {
      return { ok: true, outcome: 'ineligible_conversation', title: info?.title ?? '' };
    }

    const currentTitle = info?.title ?? '';
    let state = this.store.get(conversationId);
    if (!state) {
      state = createInitialState(currentTitle, 'default_unlocked');
    }

    if (state.mode === 'locked' || detectExternalRename(state, currentTitle)) {
      state.lastUpdatedAt = this.now();
      this.store.set(conversationId, state);
      return { ok: true, outcome: state.lastOutcome || 'locked', title: currentTitle };
    }

    const evaluated = evaluateNamingPayload(payload, state.tasks, {
      ...this.options,
      currentTitle,
    });

    if (Number.isInteger(meaningfulUserCount) && meaningfulUserCount >= 0) {
      state.evaluatedUserCount = meaningfulUserCount;
    }
    state.lastUpdatedAt = this.now();

    if (!evaluated.ok) {
      state.lastOutcome = evaluated.errors[0]?.code ? `invalid_${evaluated.errors[0].code}` : 'invalid_result';
      this.store.set(conversationId, state);
      return {
        ok: false,
        outcome: state.lastOutcome,
        title: currentTitle,
        errors: evaluated.errors,
      };
    }

    if (evaluated.action === 'defer') {
      state.lastOutcome = 'deferred';
      this.store.set(conversationId, state);
      return { ok: true, outcome: 'deferred', title: currentTitle };
    }

    if (evaluated.action === 'keep' || !evaluated.changed) {
      if (state.initialNamed) state.calibrated = true;
      state.tasks = evaluated.tasks;
      state.lastOutcome = evaluated.action === 'keep' ? 'kept' : 'unchanged';
      this.store.set(conversationId, state);
      return { ok: true, outcome: state.lastOutcome, title: currentTitle };
    }

    const writeRes = await this.api.updateTitle(conversationId, evaluated.title);
    if (!writeRes.ok) {
      state.lastOutcome = writeRes.errorCode ?? 'write_failed';
      this.store.set(conversationId, state);
      return { ok: false, outcome: state.lastOutcome, title: currentTitle };
    }

    if (state.initialNamed) state.calibrated = true;
    state.initialNamed = true;
    state.baselineTitle = evaluated.title;
    state.tasks = evaluated.tasks;
    state.lastOutcome = evaluated.migratedFromFormat ? 'migrated' : 'renamed';
    this.store.set(conversationId, state);
    return {
      ok: true,
      outcome: state.lastOutcome,
      title: evaluated.title,
      tasks: evaluated.tasks,
      warnings: evaluated.warnings,
    };
  }
}
