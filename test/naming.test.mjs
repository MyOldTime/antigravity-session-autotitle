import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNamingPayload,
  extractAutotitlePayload,
  isCurrentTitleFormat,
  isExplicitTopicChange,
  meaningfulUserText,
  renderTitle,
} from '../src/naming.mjs';

test('renders single, same-subject, and two-subject titles in canonical format', () => {
  const single = renderTitle([
    { id: 't1', subject: '操作日志', verb: '修改', target: '按排序字段createTime倒序排序', state: 'active' },
  ]);
  assert.equal(single, '[操作日志](修改)按排序字段createTime倒序排序');
  assert.equal(isCurrentTitleFormat(single), true);

  const sameSubject = renderTitle([
    { id: 't1', subject: '操作日志', verb: '修改', target: '按createTime倒序排序', state: 'active' },
    { id: 't2', subject: '操作日志', verb: '补充', target: '清空筛选后回到第1页', state: 'active' },
  ]);
  assert.equal(sameSubject, '[操作日志](修改)按createTime倒序排序;(补充)清空筛选后回到第1页');
  assert.equal(isCurrentTitleFormat(sameSubject), true);

  const twoSubjects = renderTitle([
    { id: 't1', subject: '操作日志', verb: '修改', target: '按createTime倒序排序', state: 'done' },
    { id: 't2', subject: '登录接口', verb: '修复', target: '401后刷新Token并重试原请求', state: 'active' },
  ]);
  assert.equal(twoSubjects, '[操作日志](修改)按createTime倒序排序 | [登录接口](修复)401后刷新Token并重试原请求');
  assert.equal(isCurrentTitleFormat(twoSubjects), true);
});

test('preserves technical punctuation like API(v2), sort(), and handlers[0](event)', () => {
  const res = evaluateNamingPayload({
    action: 'rename',
    reasonCode: 'initial_request',
    tasks: [
      { id: 't1', subject: 'API(v2)', verb: '修复', target: 'handlers[0](event)中sort()异常', state: 'active' },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.title, '[API(v2)](修复)handlers[0](event)中sort()异常');
});

test('rejects status claims, emojis, secrets, and hard-width overflow', () => {
  const statusClaim = evaluateNamingPayload({
    action: 'rename',
    reasonCode: 'initial_request',
    tasks: [{ id: 't1', subject: '登录接口', verb: '修复', target: '已完成401刷新问题', state: 'active' }],
  });
  assert.equal(statusClaim.ok, false);
  assert.equal(statusClaim.errors[0].code, 'status_claim');

  const withEmoji = evaluateNamingPayload({
    action: 'rename',
    reasonCode: 'initial_request',
    tasks: [{ id: 't1', subject: '登录接口', verb: '修复', target: '401刷新🚀', state: 'active' }],
  });
  assert.equal(withEmoji.ok, false);
  assert.equal(withEmoji.errors[0].code, 'emoji_not_allowed');

  const withSecret = evaluateNamingPayload({
    action: 'rename',
    reasonCode: 'initial_request',
    tasks: [{ id: 't1', subject: '配置', verb: '修改', target: '更新 sk-1234567890abcdef', state: 'active' }],
  });
  assert.equal(withSecret.ok, false);
  assert.equal(withSecret.errors[0].code, 'sensitive_leak');

  const tooWide = evaluateNamingPayload(
    {
      action: 'rename',
      reasonCode: 'initial_request',
      tasks: [{ id: 't1', subject: '测试模块', verb: '修改', target: '很长的描述'.repeat(8), state: 'active' }],
    },
    [],
    { softTitleWidth: 40, hardTitleWidth: 60, maxTargetWidth: 100 },
  );
  assert.equal(tooWide.ok, false);
  assert.equal(tooWide.errors[0].code, 'title_too_wide');
});

test('retains previous done tasks and migrates legacy format on keep', () => {
  const prev = [{ id: 't1', subject: '操作日志', verb: '修改', target: '按createTime倒序排序', state: 'done' }];

  // Model omits previous task: retained automatically.
  const added = evaluateNamingPayload(
    {
      action: 'rename',
      reasonCode: 'new_task',
      tasks: [{ id: 't2', subject: '登录接口', verb: '修复', target: '401后刷新Token', state: 'active' }],
    },
    prev,
    { currentTitle: '[操作日志](修改)按createTime倒序排序' },
  );
  assert.equal(added.ok, true);
  assert.equal(added.tasks.length, 2);
  assert.equal(added.title, '[操作日志](修改)按createTime倒序排序 | [登录接口](修复)401后刷新Token');

  // Legacy format migration on keep.
  const migrated = evaluateNamingPayload(
    { action: 'keep', reasonCode: 'no_change' },
    prev,
    { currentTitle: '操作日志｜修改按createTime倒序排序' },
  );
  assert.equal(migrated.ok, true);
  assert.equal(migrated.action, 'rename');
  assert.equal(migrated.migratedFromFormat, true);
  assert.equal(migrated.title, '[操作日志](修改)按createTime倒序排序');
});

test('extractAutotitlePayload extracts last valid HTML comment JSON', () => {
  const reply = [
    '好的，已经帮你修改了排序逻辑。',
    '',
    '<!-- autotitle:{"action":"rename","reasonCode":"initial_request","tasks":[{"id":"t1","subject":"操作日志","verb":"修改","target":"按createTime倒序排序","state":"active"}]} -->',
  ].join('\n');

  const extracted = extractAutotitlePayload(reply);
  assert.equal(extracted.found, true);
  assert.equal(extracted.errorCode, null);
  assert.equal(extracted.payload.action, 'rename');
  assert.equal(extracted.payload.tasks[0].subject, '操作日志');

  const missing = extractAutotitlePayload('普通回复，没有注释');
  assert.equal(missing.found, false);

  const broken = extractAutotitlePayload('回复\n<!-- autotitle:{not json} -->');
  assert.equal(broken.found, true);
  assert.equal(broken.payload, null);
  assert.equal(broken.errorCode, 'invalid_json');
});

test('cheap gating helpers filter acks and detect topic changes', () => {
  assert.equal(meaningfulUserText('好的'), false);
  assert.equal(meaningfulUserText('ok'), false);
  assert.equal(meaningfulUserText('帮我把操作日志改成按 createTime 倒序'), true);

  assert.equal(
    isExplicitTopicChange('[操作日志](修改)按createTime倒序排序', '另外再说一个事，帮我修一下登录接口 401 刷新 Token'),
    true,
  );
});
