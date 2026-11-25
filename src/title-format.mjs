/**
 * antigravity-session-autotitle / title format (pure, dependency-free).
 *
 * Current grammar:
 *   single task       [对象](动作)任务
 *   same object       [对象](动作)任务1;(动作)任务2
 *   different objects [对象1](动作)任务1 | [对象2](动作)任务2
 *
 * Structural punctuation is ASCII `[]();`; the fragment separator is exactly
 * one space, a pipe and one space (` | `).
 */

/** Structural tokens of the current title grammar. */
export const TITLE_SEPARATORS = Object.freeze(['[', ']', '(', ')', ';', '|']);

const FRAGMENT_SEPARATOR = ' | ';
const TASK_SEPARATOR = ';';

const OPEN_RE = /^\[([^[\]［］（）|｜;；]+)\]\(([^()[\]［］（）|｜;；]+)\)(.+)$/u;
const LATER_TASK_RE = /^\(([^()[\]［］（）|｜;；]+)\)(.+)$/u;

/**
 * Parse a title in the strict current grammar. Returns `null` for anything
 * else; used for format detection only, never as a source of task data.
 */
export function parseTitleFormat(title) {
  if (typeof title !== 'string' || !title.trim()) return null;
  if (/\p{Cc}/u.test(title)) return null;
  const fragments = title.split(FRAGMENT_SEPARATOR);
  if (fragments.length === 0) return null;
  const parsed = [];
  for (const fragment of fragments) {
    if (fragment !== fragment.trim()) return null;
    const match = OPEN_RE.exec(fragment);
    if (!match) return null;
    const [, subject, verb, body] = match;
    if (!subject.trim() || !verb.trim()) return null;
    if (!body || /[|｜；［］（）]/u.test(body)) return null;
    const segments = body.split(TASK_SEPARATOR);
    if (segments.some((segment) => !segment.trim())) return null;
    for (let index = 1; index < segments.length; index += 1) {
      const later = LATER_TASK_RE.exec(segments[index]);
      if (!later || !later[1].trim() || !later[2].trim()) return null;
    }
    parsed.push({ subject, verb, targets: segments });
  }
  return parsed;
}

/** True when `title` already follows the current `[对象](动作)任务` grammar. */
export function isCurrentTitleFormat(title) {
  return parseTitleFormat(title) !== null;
}

/** True when `title` uses the legacy `对象｜动作任务` format. */
export function isLegacyTitleFormat(title) {
  return typeof title === 'string' && title.includes('｜') && !isCurrentTitleFormat(title);
}

function groupBySubject(tasks) {
  const groups = [];
  for (const task of tasks) {
    const group = groups.find((item) => item.subject === task.subject);
    if (group) group.tasks.push(task);
    else groups.push({ subject: task.subject, tasks: [task] });
  }
  return groups;
}

/**
 * The single program-side renderer. Returns '' when the subject count exceeds
 * the configured fragment limit (caller fails closed).
 */
export function renderTitleTasks(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '';
  const maxFragments = Number.isInteger(options?.maxDisplayFragments) ? options.maxDisplayFragments : 2;
  const groups = groupBySubject(list);
  if (groups.length > maxFragments) return '';
  return groups
    .map((group) => `[${group.subject}]${group.tasks.map((task) => `(${task.verb})${task.target}`).join(TASK_SEPARATOR)}`)
    .join(FRAGMENT_SEPARATOR);
}

/** Legacy renderer, retained solely to recognise old titles for migration. */
export function renderLegacyTitle(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return '';
  const maxFragments = Number.isInteger(options?.maxDisplayFragments) ? options.maxDisplayFragments : 2;
  const groups = groupBySubject(list);
  if (groups.length > maxFragments) return '';
  return groups
    .map((group) => `${group.subject}｜${group.tasks.map((task) => `${task.verb}${task.target}`).join('；')}`)
    .join('；');
}

/** Equivalence key for current titles: NFKC plus whitespace removal only. */
export function titleKey(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\u00a0\u3000]+/gu, '');
}

export function titlesEquivalent(a, b) {
  return titleKey(a) === titleKey(b);
}

/**
 * Decide whether a `keep` answer can be turned into a pure format migration
 * from legacy `对象｜动作任务` to `[对象](动作)任务`.
 */
export function migrateLegacyTitle(currentTitle, tasks, options = {}) {
  if (!isLegacyTitleFormat(currentTitle)) return null;
  const list = Array.isArray(tasks) ? tasks : [];
  if (list.length === 0) return null;
  const legacy = renderLegacyTitle(list, options);
  if (!legacy) return null;
  if (titleKey(currentTitle) !== titleKey(legacy)) return null;
  return renderTitleTasks(list, options) || null;
}
