/**
 * antigravity-session-autotitle / naming core (pure, dependency-free).
 *
 * Handles options normalization, display width & grapheme truncation,
 * sensitive-pattern redaction, cheap trigger gating, task ledger merging,
 * strict result validation, program-side title rendering, and prompt building.
 */

import { createHash } from 'node:crypto';
import {
  TITLE_SEPARATORS,
  isCurrentTitleFormat,
  isLegacyTitleFormat,
  migrateLegacyTitle,
  renderTitleTasks,
  titleKey,
  titlesEquivalent,
} from './title-format.mjs';

export {
  TITLE_SEPARATORS,
  isCurrentTitleFormat,
  isLegacyTitleFormat,
  migrateLegacyTitle,
  titleKey,
  titlesEquivalent,
};

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

const VERB_SHAPE_RE = /^(?=.*\p{L})[\p{L}\p{N}]+(?:[ -][\p{L}\p{N}]+)*$/u;

export const ACTIONS = Object.freeze(['keep', 'rename', 'defer']);
const ACTION_SET = new Set(ACTIONS);

export const TASK_STATES = Object.freeze(['active', 'done']);

const REDACTED = '[REDACTED]';

const TASK_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const REASON_CODE_RE = /^[a-z][a-z0-9_]{2,39}$/;

/** Text that claims a status/outcome instead of describing work. */
const STATUS_CLAIM_RE =
  /已\s*(?:完成|修复|解决|实现|上线|发布|合并|搞定|通过|部署)|(?:^|[^A-Za-z])(?:done|completed|fixed|finished|shipped)(?![A-Za-z])/i;

/* -------------------------------------------------------------------------- */
/* options                                                                    */
/* -------------------------------------------------------------------------- */

export const DEFAULT_OPTIONS = Object.freeze({
  cooldownMs: 60000,
  minNewUserTurns: 4,
  manageSubsessions: false,
  language: 'zh-CN',
  mode: 'adaptive',
  maxContextTokens: 2000,
  charsPerToken: 1.5,
  recentTurns: 6,
  messageWidth: 600,
  maxTasks: 8,
  maxDisplayFragments: 2,
  softTitleWidth: 44,
  extendedTitleWidth: 52,
  hardTitleWidth: 100,
  maxSubjectWidth: 28,
  maxVerbWidth: 8,
  maxTargetWidth: 48,
});

const NUMERIC_LIMITS = Object.freeze({
  cooldownMs: [0, 3600000],
  minNewUserTurns: [1, 50],
  maxContextTokens: [200, 200000],
  charsPerToken: [0.5, 8],
  recentTurns: [1, 20],
  messageWidth: [40, 8000],
  maxTasks: [1, 24],
  maxDisplayFragments: [1, 2],
  softTitleWidth: [12, 160],
  extendedTitleWidth: [12, 600],
  hardTitleWidth: [24, 600],
  maxSubjectWidth: [4, 120],
  maxVerbWidth: [2, 32],
  maxTargetWidth: [8, 300],
});

const BOOLEAN_OPTIONS = ['manageSubsessions'];
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function normalizeOptions(options = {}) {
  if (options === undefined || options === null) options = {};
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be a plain object');
  }
  const unknown = Object.keys(options).filter((key) => !(key in DEFAULT_OPTIONS));
  if (unknown.length > 0) {
    throw new TypeError(`unknown option(s): ${unknown.join(', ')}`);
  }

  const out = { ...DEFAULT_OPTIONS };

  for (const [key, [min, max]] of Object.entries(NUMERIC_LIMITS)) {
    if (!(key in options)) continue;
    const value = options[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`option ${key} must be a finite number`);
    }
    const normalized = key === 'charsPerToken' ? value : Math.round(value);
    out[key] = Math.min(max, Math.max(min, normalized));
  }

  for (const key of BOOLEAN_OPTIONS) {
    if (!(key in options)) continue;
    if (typeof options[key] !== 'boolean') throw new TypeError(`option ${key} must be a boolean`);
    out[key] = options[key];
  }

  if ('language' in options) {
    if (typeof options.language !== 'string' || !LANGUAGE_RE.test(options.language)) {
      throw new TypeError('option language must look like "zh-CN"');
    }
    if (!/^zh(?:-[A-Za-z0-9]+)*$/i.test(options.language)) {
      throw new TypeError(`unsupported title language ${options.language}: only zh-* is implemented`);
    }
    out.language = options.language;
  }

  if ('mode' in options) {
    if (options.mode !== 'initial' && options.mode !== 'adaptive') {
      throw new TypeError('option mode must be "initial" or "adaptive"');
    }
    out.mode = options.mode;
  }

  if (out.hardTitleWidth <= out.softTitleWidth) {
    throw new RangeError('hardTitleWidth must be greater than softTitleWidth');
  }
  out.extendedTitleWidth = Math.min(out.hardTitleWidth, out.softTitleWidth + 8);

  return Object.freeze(out);
}

/* -------------------------------------------------------------------------- */
/* display width / graphemes                                                  */
/* -------------------------------------------------------------------------- */

const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const WIDE_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FFFD}]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const REGIONAL_RE = /[\u{1F1E6}-\u{1F1FF}]/u;
const ZERO_WIDTH_RE = /[\p{Mn}\p{Me}]/u;

function isWideChar(ch) {
  return WIDE_RE.test(ch) || EMOJI_RE.test(ch) || REGIONAL_RE.test(ch);
}

/** Approximate display columns: CJK/fullwidth/emoji = 2, ASCII = 1, marks = 0. */
export function displayWidth(text) {
  const value = String(text ?? '');
  let total = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    let width = 0;
    for (const ch of segment) {
      const cp = ch.codePointAt(0);
      if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) continue;
      if (cp >= 0x1f3fb && cp <= 0x1f3ff) continue;
      if (ZERO_WIDTH_RE.test(ch)) continue;
      const charWidth = isWideChar(ch) ? 2 : 1;
      if (charWidth > width) width = charWidth;
    }
    total += width;
  }
  return total;
}

/** Grapheme-safe truncation. */
export function truncateGraphemes(text, maxWidth, ellipsis = '…') {
  const value = String(text ?? '');
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return { text: '', truncated: value.length > 0 };
  if (displayWidth(value) <= maxWidth) return { text: value, truncated: false };
  const tail = displayWidth(ellipsis) <= maxWidth ? ellipsis : '';
  const budget = maxWidth - displayWidth(tail);
  let out = '';
  let used = 0;
  for (const { segment } of SEGMENTER.segment(value)) {
    const width = displayWidth(segment);
    if (used + width > budget) break;
    out += segment;
    used += width;
  }
  return { text: out + tail, truncated: true };
}

export function estimateTokens(text, options = {}) {
  const charsPerToken =
    typeof options === 'number'
      ? options
      : typeof options?.charsPerToken === 'number'
        ? options.charsPerToken
        : DEFAULT_OPTIONS.charsPerToken;
  return Math.ceil(displayWidth(text) / charsPerToken);
}

/* -------------------------------------------------------------------------- */
/* redaction / unsafe chars                                                   */
/* -------------------------------------------------------------------------- */

const REDACTION_RULES = [
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [
    /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|pwd)\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    `$1${REDACTED}`,
  ],
  [
    /(["'](?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|authorization)["']\s*:\s*)(["'])[^"']*\2/gi,
    `$1$2${REDACTED}$2`,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED],
  [/\b(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}\b/g, REDACTED],
  [/\b[A-Za-z]:[\\/](?:[^\s\\/:*?"<>|]+[\\/])*[^\s\\/:*?"<>|]+/g, REDACTED],
  [/\\\\[^\s\\]+\\[^\s\\]+(?:\\[^\s\\]*)*/g, REDACTED],
  [/(?<![\w.:])\/(?:[\w.@%+-]+\/)+[\w.@%+-]*/g, REDACTED],
];

export function redactSensitive(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of REDACTION_RULES) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

export function containsSensitive(text) {
  const value = String(text ?? '');
  return redactSensitive(value) !== value;
}

const FORBIDDEN_CHARS_RE = /[\p{Cf}\p{Co}\p{Cs}]/u;
const FORBIDDEN_CHARS_GLOBAL_RE = /[\p{Cf}\p{Co}\p{Cs}]/gu;
const TITLE_EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F/u;
const EMOJI_GLOBAL_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|\uFE0F/gu;

function stripTitleUnsafe(text) {
  return String(text ?? '').replace(FORBIDDEN_CHARS_GLOBAL_RE, '').replace(EMOJI_GLOBAL_RE, '');
}

/* -------------------------------------------------------------------------- */
/* cheap gates                                                                */
/* -------------------------------------------------------------------------- */

const ACK_RE =
  /^(?:嗯+|哦+|噢+|好的|好+|可以|行|ok(?:ay)?|yes|no|\+1|继续|收到|了解|谢谢|多谢|thanks|thx|ty|👍|👌|✅|。|，|\s)+$/iu;
const SLASH_COMMAND_RE = /^\/[\w:.-]+/u;
const WORD_LIKE_RE =
  /[\p{Script=Han}]{2}|[A-Za-z]{2}|[\p{Script=Hiragana}]{2}|[\p{Script=Katakana}]{2}|[\p{Script=Hangul}]{2}/u;

export function meaningfulUserText(text) {
  if (typeof text !== 'string') return false;
  let value = text.normalize('NFKC').trim();
  if (!value) return false;
  value = value.replace(SLASH_COMMAND_RE, '').trim();
  if (!value) return false;
  if (ACK_RE.test(value)) return false;
  const tokens = value.match(/[\p{L}\p{N}]/gu) ?? [];
  if (tokens.length < 2) return false;
  return WORD_LIKE_RE.test(value);
}

const TOPIC_MARKERS = [
  /换个?话题/u,
  /(?:^|[，。,.!！;；\s])(?:另外|此外|顺带|顺便|再说一个)(?:一个|一件|个)/u,
  /新(?:的)?任务/u,
  /(?:忘|别管|不用管|忽略)(?:了)?(?:上面|之前|刚才|前面)/u,
  /重新开始/u,
  /(?:改|转)到(?:另一个|别的|其他)/u,
  /别的(?:事情|问题|话题)/u,
  /(?:^|\s)(?:next topic|new topic|unrelated)\b/i,
];

function bigrams(text) {
  const clean = String(text ?? '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const grams = new Set();
  const symbols = clean.split(/\s+/u).join(' ').replace(/ /gu, '');
  const points = Array.from(symbols);
  for (let i = 0; i + 1 < points.length; i += 1) grams.add(points[i] + points[i + 1]);
  return grams;
}

export function isExplicitTopicChange(previous, next, options = {}) {
  const opts = typeof options === 'object' && options !== null ? options : {};
  const minWidth = typeof opts.minWidth === 'number' ? opts.minWidth : 8;
  if (!meaningfulUserText(next)) return false;
  const normalized = String(next).normalize('NFKC');
  if (TOPIC_MARKERS.some((pattern) => pattern.test(normalized))) return true;
  const before = bigrams(previous);
  const after = bigrams(normalized);
  if (before.size === 0 || after.size === 0) return false;
  for (const gram of after) if (before.has(gram)) return false;
  return displayWidth(normalized) >= minWidth;
}

/* -------------------------------------------------------------------------- */
/* task ledger                                                                */
/* -------------------------------------------------------------------------- */

const LEDGER_KEYS = ['id', 'subject', 'verb', 'target', 'state'];
const MODEL_TASK_KEYS = new Set([...LEDGER_KEYS, 'reason', 'mergedFrom']);

const SUBJECT_FORBIDDEN_RE = /[\[\]［］|｜;；]/u;
const TARGET_FORBIDDEN_RE = /[|｜;；]/u;
const SUBJECT_STRUCTURE_GLOBAL_RE = /[\[\]［］|｜;；]/gu;
const TARGET_SEPARATOR_GLOBAL_RE = /[|｜;；]/gu;

function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function ledgerEntry(task) {
  return {
    id: task.id,
    subject: task.subject,
    verb: task.verb,
    target: task.target,
    state: task.state,
  };
}

export function normalizeLedger(tasks, options = {}) {
  const opts = normalizeOptions(options);
  return sanitizeLedger(tasks, opts, []);
}

function sanitizeLedger(tasks, opts, warnings) {
  if (tasks === undefined || tasks === null) return [];
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  const out = [];
  const seen = new Set();
  for (const [index, raw] of tasks.entries()) {
    const path = `tasks[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push({ code: 'dropped_task', path, message: '任务不是对象，已丢弃' });
      continue;
    }
    const id = raw.id;
    if (typeof id !== 'string' || !TASK_ID_RE.test(id)) {
      warnings.push({ code: 'dropped_task', path, message: '任务 id 非法，已丢弃' });
      continue;
    }
    if (seen.has(id)) {
      warnings.push({ code: 'duplicate_task_id', path, message: `重复任务 id ${id}，已丢弃` });
      continue;
    }
    const verb = sanitizeLedgerVerb(raw.verb, opts.maxVerbWidth, `${path}.verb`, warnings);
    if (!verb) {
      warnings.push({ code: 'dropped_task', path, message: `任务 ${id} 的动作词不可用，已丢弃` });
      continue;
    }
    const subject = sanitizeLedgerText(
      raw.subject, opts.maxSubjectWidth, path, warnings, SUBJECT_STRUCTURE_GLOBAL_RE,
    );
    const target = sanitizeLedgerText(
      raw.target, opts.maxTargetWidth, path, warnings, TARGET_SEPARATOR_GLOBAL_RE,
    );
    if (!subject || !target) {
      warnings.push({ code: 'dropped_task', path, message: `任务 ${id} 文本不可用，已丢弃` });
      continue;
    }
    let state = 'active';
    if (raw.state !== undefined) {
      if (raw.state === 'active' || raw.state === 'done') state = raw.state;
      else warnings.push({ code: 'invalid_state', path: `${path}.state`, message: '状态非法，按 active 处理' });
    }
    seen.add(id);
    out.push({ id, subject, verb, target, state });
  }
  return out;
}

function sanitizeLedgerText(value, maxWidth, path, warnings, forbiddenRe) {
  if (typeof value !== 'string') {
    warnings.push({ code: 'invalid_field', path, message: '文本字段缺失' });
    return null;
  }
  const base = cleanText(value).normalize('NFKC').replace(forbiddenRe, ' ');
  const redacted = redactSensitive(base);
  if (redacted !== base) warnings.push({ code: 'field_redacted', path, message: '已有任务文本含敏感信息，已脱敏' });
  const cleaned = stripTitleUnsafe(redacted).replace(/[ \t]+/g, ' ').trim();
  if (!cleaned) return null;
  if (displayWidth(cleaned) > maxWidth) {
    warnings.push({
      code: 'field_too_wide',
      path,
      message: `已有任务文本宽度 ${displayWidth(cleaned)} 超过 ${maxWidth}，已完整保留`,
    });
  }
  return cleaned;
}

function sanitizeLedgerVerb(value, maxWidth, path, warnings) {
  const errors = [];
  const verb = readVerb(value, path, maxWidth, errors);
  for (const error of errors) warnings.push(error);
  return verb;
}

export function renderTitle(tasks, options = {}) {
  const opts = normalizeOptions(options);
  return renderTitleTasks(sanitizeLedger(tasks, opts, []), opts);
}

/* -------------------------------------------------------------------------- */
/* validation & ledger merge                                                  */
/* -------------------------------------------------------------------------- */

function readTaskText(value, path, maxWidth, minWidth, errors, forbidden) {
  if (typeof value !== 'string') {
    errors.push({ code: 'invalid_field', path, message: '必须是字符串' });
    return null;
  }
  if (/\p{Cc}/u.test(value)) {
    errors.push({ code: 'control_chars', path, message: '不得包含控制字符或换行' });
    return null;
  }
  if (FORBIDDEN_CHARS_RE.test(value)) {
    errors.push({ code: 'forbidden_chars', path, message: '不得包含 bidi/格式/私用区字符' });
    return null;
  }
  if (TITLE_EMOJI_RE.test(value)) {
    errors.push({ code: 'emoji_not_allowed', path, message: '标题不得包含 emoji' });
    return null;
  }
  const text = cleanText(value).normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!text) {
    errors.push({ code: 'empty_field', path, message: '不能为空' });
    return null;
  }
  if (forbidden && forbidden.test(text)) {
    errors.push({
      code: 'separator_injection',
      path,
      message: forbidden === TARGET_FORBIDDEN_RE
        ? '不得包含 | 或 ; 对象/任务分隔符'
        : '对象和动作不得包含方括号或分隔符（对象可用自然圆括号如 API(v2)）',
    });
    return null;
  }
  if (STATUS_CLAIM_RE.test(text)) {
    errors.push({ code: 'status_claim', path, message: '不得声称完成或修复结果' });
    return null;
  }
  if (containsSensitive(text)) {
    errors.push({ code: 'sensitive_leak', path, message: '不得包含密钥、邮箱、手机号或绝对路径' });
    return null;
  }
  const width = displayWidth(text);
  if (width < minWidth) {
    errors.push({ code: 'field_too_short', path, message: `宽度 ${width} 小于 ${minWidth}` });
    return null;
  }
  if (width > maxWidth) {
    errors.push({ code: 'field_too_wide', path, message: `宽度 ${width} 超过 ${maxWidth}` });
    return null;
  }
  return text;
}

function readVerb(value, path, maxWidth, errors) {
  const text = readTaskText(value, path, maxWidth, 2, errors, SUBJECT_FORBIDDEN_RE);
  if (text === null) return null;
  if (!VERB_SHAPE_RE.test(text)) {
    errors.push({
      code: 'invalid_verb',
      path,
      message: '动作词只能含汉字、字母、数字和必要空格或连字符，且至少包含一个文字字符',
    });
    return null;
  }
  return text;
}

function readModelTask(raw, path, opts, errors) {
  const before = errors.length;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ code: 'invalid_task', path, message: '任务必须是对象' });
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!MODEL_TASK_KEYS.has(key)) errors.push({ code: 'unknown_field', path: `${path}.${key}` });
  }
  if (typeof raw.id !== 'string' || !TASK_ID_RE.test(raw.id)) {
    errors.push({ code: 'invalid_task_id', path: `${path}.id`, message: 'id 需匹配 ^[a-z][a-z0-9_-]{0,23}$' });
  }
  const subject = readTaskText(
    raw.subject, `${path}.subject`, opts.maxSubjectWidth, 1, errors, SUBJECT_FORBIDDEN_RE,
  );
  const verb = readVerb(raw.verb, `${path}.verb`, opts.maxVerbWidth, errors);
  const target = readTaskText(
    raw.target, `${path}.target`, opts.maxTargetWidth, 2, errors, TARGET_FORBIDDEN_RE,
  );

  let state = 'active';
  if (raw.state !== undefined) {
    if (raw.state === 'active' || raw.state === 'done') state = raw.state;
    else errors.push({ code: 'invalid_state', path: `${path}.state`, message: 'state 只能是 active 或 done' });
  }

  let reason;
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string' || !raw.reason.trim() || displayWidth(raw.reason) > 120 || /\p{Cc}/u.test(raw.reason)) {
      errors.push({ code: 'invalid_reason', path: `${path}.reason`, message: 'reason 必须是简短单行文本' });
    } else if (containsSensitive(raw.reason)) {
      errors.push({ code: 'sensitive_leak', path: `${path}.reason`, message: 'reason 不得包含隐私信息' });
    } else {
      reason = raw.reason.trim();
    }
  }

  let mergedFrom;
  if (raw.mergedFrom !== undefined) {
    const value = raw.mergedFrom;
    if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !TASK_ID_RE.test(id))) {
      errors.push({ code: 'invalid_merged_from', path: `${path}.mergedFrom`, message: 'mergedFrom 必须是非空任务 id 数组' });
    } else {
      mergedFrom = [...new Set(value)];
    }
    if (mergedFrom && !reason) {
      errors.push({ code: 'merge_reason_required', path: `${path}.reason`, message: '合并必须给出 reason' });
    }
  }

  if (errors.length > before) return null;
  const task = { id: raw.id, subject, verb, target, state };
  if (reason) task.reason = reason;
  if (mergedFrom) task.mergedFrom = mergedFrom;
  return task;
}

function taskSignature(task) {
  return [task.id, task.subject, task.verb, task.target, task.state].join('\u0000');
}

function sameTaskList(a, b) {
  if (a.length !== b.length) return false;
  return a.every((task, index) => taskSignature(task) === taskSignature(b[index]));
}

function mergeLedger(previous, modelTasks, opts, errors, warnings) {
  const prevById = new Map(previous.map((task) => [task.id, task]));
  const modelIds = new Set();
  for (const [index, task] of modelTasks.entries()) {
    if (modelIds.has(task.id)) {
      errors.push({ code: 'duplicate_task_id', path: `tasks[${index}].id`, message: `id ${task.id} 重复` });
    }
    modelIds.add(task.id);
  }

  const mergedInto = new Map();
  for (const task of modelTasks) {
    if (!Array.isArray(task.mergedFrom)) continue;
    for (const oldId of task.mergedFrom) {
      if (oldId === task.id) {
        errors.push({ code: 'self_merge', path: `tasks.${task.id}.mergedFrom`, message: `任务 ${oldId} 不能合并自身` });
      } else if (!prevById.has(oldId)) {
        errors.push({ code: 'unknown_merged_id', path: `tasks.${task.id}.mergedFrom`, message: `合并来源 ${oldId} 不存在` });
      } else if (modelIds.has(oldId)) {
        errors.push({ code: 'reused_merged_id', path: `tasks.${task.id}.mergedFrom`, message: `合并来源 ${oldId} 同时被单独更新` });
      } else if (mergedInto.has(oldId)) {
        errors.push({ code: 'duplicate_merge_source', path: `tasks.${task.id}.mergedFrom`, message: `合并来源 ${oldId} 被多个任务重复引用` });
      } else {
        mergedInto.set(oldId, task.id);
      }
    }
  }

  for (const task of modelTasks) {
    const before = prevById.get(task.id);
    if (!before) continue;
    const changed = before.subject !== task.subject || before.verb !== task.verb || before.target !== task.target;
    if (changed && !task.reason) {
      errors.push({
        code: 'change_reason_required',
        path: `tasks.${task.id}.reason`,
        message: `修改任务 ${task.id} 的内容需要给出 reason`,
      });
    }
  }

  if (errors.length > 0) return [];

  const out = [];
  const consumed = new Set();
  const push = (task) => {
    const entry = ledgerEntry(task);
    if (task.mergedFrom) {
      const sources = task.mergedFrom.map((id) => prevById.get(id)).filter(Boolean);
      if (prevById.has(task.id)) sources.push(prevById.get(task.id));
      if (sources.length > 0 && sources.every((item) => item.state === 'done')) {
        entry.state = 'done';
      }
    }
    out.push(entry);
  };

  for (const previousTask of previous) {
    if (mergedInto.has(previousTask.id)) {
      const target = modelTasks.find((task) => task.id === mergedInto.get(previousTask.id));
      if (target && !consumed.has(target)) {
        push(target);
        consumed.add(target);
      }
      continue;
    }
    const updated = modelTasks.find((task) => task.id === previousTask.id);
    if (updated) {
      if (consumed.has(updated)) continue;
      if (previousTask.state === 'done' && updated.state !== 'done') {
        errors.push({
          code: 'done_task_reactivated',
          path: 'tasks',
          message: `已完成任务 ${previousTask.id} 不能被重新激活`,
        });
        push({ ...updated, state: 'done' });
      } else {
        push(previousTask.state === 'done' ? { ...updated, state: 'done' } : updated);
      }
      consumed.add(updated);
      continue;
    }
    out.push(ledgerEntry(previousTask));
    warnings.push({
      code: 'task_retained',
      path: `tasks.${previousTask.id}`,
      message: `模型未返回任务 ${previousTask.id}，已保留`,
    });
  }

  for (const task of modelTasks) {
    if (!consumed.has(task)) push(task);
  }

  if (out.length > opts.maxTasks) {
    errors.push({
      code: 'too_many_tasks',
      path: 'tasks',
      message: `任务数 ${out.length} 超过上限 ${opts.maxTasks}，请合并`,
    });
  }
  return out;
}

function validateOutputTitle(title, subjectCount, opts, warnings, errors) {
  if (!title) {
    errors.push({ code: 'empty_title', path: 'tasks', message: '无法从任务渲染出标题' });
    return false;
  }
  if (/\p{Cc}/u.test(title)) {
    errors.push({ code: 'control_chars', path: 'title', message: '标题不得包含控制字符或换行' });
    return false;
  }
  if (FORBIDDEN_CHARS_RE.test(title)) {
    errors.push({ code: 'forbidden_chars', path: 'title', message: '标题不得包含 bidi/格式/私用区字符' });
    return false;
  }
  if (TITLE_EMOJI_RE.test(title)) {
    errors.push({ code: 'emoji_not_allowed', path: 'title', message: '标题不得包含 emoji' });
    return false;
  }
  if (!isCurrentTitleFormat(title)) {
    errors.push({
      code: 'invalid_title_structure',
      path: 'title',
      message: '标题不符合 [对象](动作)任务 的严格结构',
    });
    return false;
  }
  if (STATUS_CLAIM_RE.test(title)) {
    errors.push({ code: 'status_claim', path: 'title', message: '不得声称完成或修复结果' });
    return false;
  }
  if (containsSensitive(title)) {
    errors.push({ code: 'sensitive_leak', path: 'title', message: '不得包含密钥、邮箱、手机号或绝对路径' });
    return false;
  }
  const width = displayWidth(title);
  if (width > opts.hardTitleWidth) {
    errors.push({
      code: 'title_too_wide',
      path: 'title',
      message: `标题宽度 ${width} 超过硬上限 ${opts.hardTitleWidth}（不做自动截断）`,
    });
    return false;
  }
  if (width > opts.softTitleWidth) {
    const smallOverrun = subjectCount >= 2 && width <= opts.extendedTitleWidth;
    if (!smallOverrun) {
      warnings.push({
        code: 'title_wide',
        path: 'title',
        message: `标题宽度 ${width} 超过软上限 ${opts.softTitleWidth}（硬上限 ${opts.hardTitleWidth}）`,
      });
    }
  }
  return true;
}

function fail(errors, warnings, previous, extra = {}) {
  return {
    ok: false,
    action: null,
    reasonCode: null,
    title: '',
    changed: false,
    tasks: previous,
    modelTasks: [],
    errors,
    warnings,
    ...extra,
  };
}

/**
 * Validate a structured naming payload (from MCP tool arguments or parsed JSON).
 * The title is always rendered by code from validated tasks.
 */
export function evaluateNamingPayload(payload, previousTasks = [], options = {}) {
  if (options !== null && options !== undefined && (typeof options !== 'object' || Array.isArray(options))) {
    throw new TypeError('options must be an object');
  }
  const rawOptions = { ...(options ?? {}) };
  const currentTitle = typeof rawOptions.currentTitle === 'string' ? rawOptions.currentTitle : '';
  delete rawOptions.currentTitle;
  const opts = normalizeOptions(rawOptions);

  const errors = [];
  const warnings = [];
  const previous = sanitizeLedger(previousTasks, opts, warnings);

  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    errors.push({ code: 'invalid_shape', path: 'root', message: '顶层必须是 JSON 对象' });
    return fail(errors, warnings, previous);
  }

  for (const key of Object.keys(payload)) {
    if (!['action', 'reasonCode', 'tasks', 'title'].includes(key)) {
      errors.push({ code: 'unknown_field', path: key, message: `未知字段 ${key}` });
    }
  }

  const action = payload.action;
  if (typeof action !== 'string' || !ACTION_SET.has(action)) {
    errors.push({ code: 'invalid_action', path: 'action', message: 'action 只能是 keep/rename/defer' });
  }
  const reasonCode = payload.reasonCode;
  if (typeof reasonCode !== 'string' || !REASON_CODE_RE.test(reasonCode)) {
    errors.push({
      code: 'invalid_reason_code',
      path: 'reasonCode',
      message: 'reasonCode 需匹配 ^[a-z][a-z0-9_]{2,39}$',
    });
  }

  const modelTasks = [];
  if (action === 'rename') {
    if (!Array.isArray(payload.tasks) || payload.tasks.length === 0) {
      errors.push({ code: 'missing_tasks', path: 'tasks', message: 'rename 必须给出非空 tasks' });
    }
  } else if (payload.tasks !== undefined && !Array.isArray(payload.tasks)) {
    errors.push({ code: 'invalid_tasks', path: 'tasks', message: 'tasks 必须是数组' });
  }

  if (Array.isArray(payload.tasks)) {
    for (const [index, rawTask] of payload.tasks.entries()) {
      const task = readModelTask(rawTask, `tasks[${index}]`, opts, errors);
      if (task) modelTasks.push(task);
    }
  }

  if (errors.length > 0) return fail(errors, warnings, previous);

  if (action === 'keep' || action === 'defer') {
    const declared = modelTasks.map(ledgerEntry);
    if (payload.tasks !== undefined && !sameTaskList(declared, previous)) {
      errors.push({
        code: `tasks_changed_on_${action}`,
        path: 'tasks',
        message: `${action} 不允许修改任务列表`,
      });
      return fail(errors, warnings, previous);
    }
    if (action === 'keep' && !currentTitle) {
      errors.push({
        code: 'keep_without_title',
        path: 'action',
        message: '没有当前标题时不能 keep，请使用 defer',
      });
      return fail(errors, warnings, previous);
    }
    if (action === 'keep') {
      const migrated = migrateLegacyTitle(currentTitle, previous, opts);
      if (migrated) {
        if (previous.every((task) => task.state === 'done')) {
          warnings.push({ code: 'all_tasks_done', path: 'tasks', message: '所有任务都已完成，仍保留完整主题' });
        }
        if (!validateOutputTitle(
          migrated, new Set(previous.map((task) => task.subject)).size, opts, warnings, errors,
        )) {
          return fail(errors, warnings, previous);
        }
        warnings.push({
          code: 'title_format_migrated',
          path: 'title',
          message: '当前标题是旧格式且与已保存任务一致，仅迁移为新格式',
        });
        return {
          ok: true,
          action: 'rename',
          reasonCode: 'format_migration',
          title: migrated,
          renderedFromTasks: true,
          changed: true,
          migratedFromFormat: true,
          tasks: previous,
          modelTasks: declared,
          errors,
          warnings,
        };
      }
    }
    const rendered = renderTitleTasks(previous, opts);
    const title = currentTitle || rendered;
    return {
      ok: true,
      action,
      reasonCode,
      title,
      renderedFromTasks: !currentTitle,
      changed: false,
      tasks: previous,
      modelTasks: declared,
      errors,
      warnings,
    };
  }

  const ledger = mergeLedger(previous, modelTasks, opts, errors, warnings);
  if (errors.length > 0) return fail(errors, warnings, previous);

  const subjects = new Set(ledger.map((task) => task.subject));
  if (subjects.size > opts.maxDisplayFragments) {
    errors.push({
      code: 'too_many_fragments',
      path: 'tasks',
      message: `任务涉及 ${subjects.size} 个对象，超过 ${opts.maxDisplayFragments} 个显示片段，请合并`,
    });
    return fail(errors, warnings, previous);
  }

  const title = renderTitleTasks(ledger, opts);
  if (ledger.every((task) => task.state === 'done')) {
    warnings.push({ code: 'all_tasks_done', path: 'tasks', message: '所有任务都已完成，仍保留完整主题' });
  }
  if (!validateOutputTitle(title, subjects.size, opts, warnings, errors)) {
    return fail(errors, warnings, previous);
  }

  const changed = !currentTitle
    || !isCurrentTitleFormat(currentTitle)
    || !titlesEquivalent(title, currentTitle);
  if (!changed) {
    warnings.push({
      code: 'title_equivalent',
      path: 'title',
      message: '新标题与当前标点/空格等价，视为未变更',
    });
  }

  return {
    ok: true,
    action,
    reasonCode,
    title,
    renderedFromTasks: true,
    changed,
    tasks: ledger,
    modelTasks: modelTasks.map(ledgerEntry),
    errors,
    warnings,
  };
}

/**
 * Extract the last hidden `<!-- autotitle:{...} -->` JSON block from an
 * assistant reply. Returns `{ found, payload, errorCode }`.
 */
export function extractAutotitlePayload(text) {
  if (typeof text !== 'string' || !text.includes('<!--')) {
    return { found: false, payload: null, errorCode: 'missing_marker' };
  }
  const matches = [...text.matchAll(/<!--\s*autotitle\s*:\s*([\s\S]*?)\s*-->/gu)];
  if (matches.length === 0) {
    return { found: false, payload: null, errorCode: 'missing_marker' };
  }
  const rawJson = matches.at(-1)[1].trim();
  if (!rawJson) {
    return { found: true, payload: null, errorCode: 'invalid_json' };
  }
  try {
    const parsed = JSON.parse(rawJson);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { found: true, payload: null, errorCode: 'invalid_shape' };
    }
    return { found: true, payload: parsed, errorCode: null };
  } catch {
    return { found: true, payload: null, errorCode: 'invalid_json' };
  }
}

/**
 * Build the compact system prompt injected by PreInvocation Hook when
 * a naming evaluation is due. Instructs the agent to invoke `apply-title.mjs`
 * via `run_command` (which carries ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN).
 */
export function buildHookDirective({
  conversationId,
  scriptPath,
  dataDir,
  currentTitle,
  tasks,
  mode,
  triggerReason,
  meaningfulUserCount = 0,
  options = {},
}) {
  const opts = normalizeOptions(options);
  const ledger = sanitizeLedger(tasks ?? [], opts, []).map(ledgerEntry);
  const safeTitle = currentTitle
    ? truncateGraphemes(stripTitleUnsafe(redactSensitive(cleanText(currentTitle).trim())), opts.hardTitleWidth).text
    : '';
  const posixScript = String(scriptPath ?? '').replaceAll('\\', '/');
  const posixDataDir = String(dataDir ?? '').replaceAll('\\', '/');
  const lines = [
    `[antigravity-session-autotitle] 本轮触发会话自动命名（模式: ${mode}，原因: ${triggerReason}）。`,
    '请在完成用户主任务的同时，调用一次 `run_command`（设置 `BypassSandbox: true`，因为需要访问本地 Antigravity ConversationService）执行以下命令来更新会话标题，不要在回复正文中向用户提及此次自动命名：',
    `node "${posixScript}" --data-dir "${posixDataDir}" --conversation-id "${conversationId}" --user-turns ${meaningfulUserCount} --payload '{"action":"rename","reasonCode":"${triggerReason}","tasks":[{"id":"t1","subject":"对象","verb":"动作","target":"具体任务","state":"active"}]}'`,
    `已知基准标题: ${safeTitle ? JSON.stringify(safeTitle) : '（无）'}`,
    `已有任务账本: ${JSON.stringify(ledger)}`,
    `标题由脚本按 tasks 自动渲染（不要输出 title）：单任务 [对象](动作)任务；同对象多动作 [对象](动作)任务1;(动作)任务2；不同对象 [对象1](动作)任务1 | [对象2](动作)任务2。最多 ${opts.maxDisplayFragments} 个对象，动作词≤${opts.maxVerbWidth} 列（2～4 字），对象≤${opts.maxSubjectWidth} 列，单任务描述≤${opts.maxTargetWidth} 列，总宽软上限 ${opts.softTitleWidth} 列、硬上限 ${opts.hardTitleWidth} 列。`,
    '简洁要求（重要）：标题必须极简短语化，单任务控制在 12～22 字以内；对象用简短名称，任务只留最核心的字段/条件/动作，去掉“关于/进行/实现一个/模仿…的”等冗余修饰词。示例：[操作日志](修改)createTime倒序、[登录接口](修复)401刷新Token重试、[自动命名插件](编写)Hook自动重命名。',
    '命名规则: 保留关键技术词大小写（如 createTime、Redis）；不写“优化功能/修改逻辑”等泛称；不声称已完成/已修复；禁止密钥/邮箱/手机号/绝对路径/emoji；已完成任务改 state="done" 并保留；修改或合并旧任务须写 reason（合并另加 mergedFrom）；信息不足传 {"action":"defer","reasonCode":"insufficient_context"}，无需改动传 {"action":"keep","reasonCode":"no_change"}。JSON 字符串中不要包含单引号。',
  ];
  return lines.join('\n');
}

/** Stable, non-reversible short hash to correlate checkpoints without leaking text. */
export function titleFingerprint(title) {
  return createHash('sha256').update(String(title ?? ''), 'utf8').digest('hex').slice(0, 16);
}
