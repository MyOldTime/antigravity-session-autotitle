import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HookController } from '../src/controller.mjs';
import { DEFAULT_OPTIONS } from '../src/naming.mjs';
import { SessionStore } from '../src/store.mjs';

const TMP_BASE = path.resolve('.tmp-tests');

function makeTempDir(t) {
  fs.mkdirSync(TMP_BASE, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'run-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      if (fs.existsSync(TMP_BASE) && fs.readdirSync(TMP_BASE).length === 0) {
        fs.rmdirSync(TMP_BASE);
      }
    } catch {}
  });
  return dir;
}

function writeTranscript(filePath, entries) {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

function makeMockApi(initial = {}) {
  const conv = {
    id: initial.id ?? 'conv-1',
    annotations: {
      title: initial.title ?? '',
      archived: initial.archived ?? false,
    },
    metadata: {
      parentConversationId: initial.parentConversationId ?? '',
    },
    state: { summary: '' },
  };
  const updates = [];
  return {
    conv,
    updates,
    isConfigured() {
      return initial.configured !== false;
    },
    async getConversation() {
      return { ok: true, errorCode: null, data: structuredClone(conv) };
    },
    async updateTitle(_id, title) {
      conv.annotations.title = title;
      updates.push(title);
      return { ok: true, errorCode: null, data: structuredClone(conv) };
    },
  };
}

test('PreInvocation triggers once per turn and applyTitle writes canonical title', async (t) => {
  const dir = makeTempDir(t);
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  const dataDir = path.join(dir, 'data');
  const store = new SessionStore(dataDir);
  // Simulate hook process without LS env vars.
  const hookApi = makeMockApi({ configured: false });
  const applyApi = makeMockApi({ configured: true });
  let clock = 1_000_000;

  const hookController = new HookController({
    store,
    api: hookApi,
    options: DEFAULT_OPTIONS,
    pluginRoot: path.resolve('.'),
    dataDir,
    now: () => clock,
  });

  writeTranscript(transcriptPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n帮我把操作日志改成按 createTime 倒序排序\n</USER_REQUEST>' },
  ]);

  const pre1 = await hookController.handlePreInvocation({
    conversationId: 'conv-1',
    transcriptPath,
    lastUserInput: '帮我把操作日志改成按 createTime 倒序排序',
  });
  assert.equal(pre1.injectSteps?.length, 1);
  assert.match(pre1.injectSteps[0].systemMessage.systemMessage, /apply-title\.mjs/);

  // Second invocation in same turn -> deduplicated.
  const pre2 = await hookController.handlePreInvocation({
    conversationId: 'conv-1',
    transcriptPath,
    lastUserInput: '帮我把操作日志改成按 createTime 倒序排序',
  });
  assert.deepEqual(pre2, {});

  // Agent executes apply-title.mjs -> validates, renders, writes via LS API.
  const applyController = new HookController({
    store,
    api: applyApi,
    options: DEFAULT_OPTIONS,
    dataDir,
    now: () => clock + 500,
  });
  const applied = await applyController.applyTitle({
    conversationId: 'conv-1',
    meaningfulUserCount: 1,
    payload: {
      action: 'rename',
      reasonCode: 'initial_request',
      tasks: [{ id: 't1', subject: '操作日志', verb: '修改', target: '按createTime倒序排序', state: 'active' }],
    },
  });

  assert.equal(applied.ok, true);
  assert.equal(applied.outcome, 'renamed');
  assert.equal(applied.title, '[操作日志](修改)按createTime倒序排序');
  assert.deepEqual(applyApi.updates, ['[操作日志](修改)按createTime倒序排序']);

  const saved = store.get('conv-1');
  assert.equal(saved.initialNamed, true);
  assert.equal(saved.baselineTitle, '[操作日志](修改)按createTime倒序排序');
  assert.equal(saved.lastOutcome, 'renamed');
});

test('manual rename locks the conversation and prevents further auto-renaming', async (t) => {
  const dir = makeTempDir(t);
  const store = new SessionStore(path.join(dir, 'data'));
  const api = makeMockApi();
  let clock = 2_000_000;
  const controller = new HookController({ store, api, options: DEFAULT_OPTIONS, now: () => clock });

  const first = await controller.applyTitle({
    conversationId: 'conv-1',
    meaningfulUserCount: 1,
    payload: {
      action: 'rename',
      reasonCode: 'initial_request',
      tasks: [{ id: 't1', subject: '登录接口', verb: '修复', target: '401后刷新Token', state: 'active' }],
    },
  });
  assert.equal(first.outcome, 'renamed');

  // User manually renames the conversation.
  api.conv.annotations.title = '我的手动标题';
  clock += 120_000;

  const second = await controller.applyTitle({
    conversationId: 'conv-1',
    meaningfulUserCount: 2,
    payload: {
      action: 'rename',
      reasonCode: 'topic_change',
      tasks: [{ id: 't2', subject: '缓存脚本', verb: '编写', target: '清理Redis过期键', state: 'active' }],
    },
  });
  assert.equal(second.outcome, 'locked_external_rename');
  assert.equal(api.conv.annotations.title, '我的手动标题');
  assert.equal(store.get('conv-1').mode, 'locked');
});

test('skips child conversations and archived conversations', async (t) => {
  const dir = makeTempDir(t);
  const childController = new HookController({
    store: new SessionStore(path.join(dir, 'data-child')),
    api: makeMockApi({ parentConversationId: 'root-conv' }),
    options: DEFAULT_OPTIONS,
  });
  const childRes = await childController.applyTitle({
    conversationId: 'sub-1',
    payload: { action: 'rename', reasonCode: 'initial_request', tasks: [{ id: 't1', subject: '数据库', verb: '排查', target: '连接超时', state: 'active' }] },
  });
  assert.equal(childRes.outcome, 'ineligible_conversation');

  const archivedController = new HookController({
    store: new SessionStore(path.join(dir, 'data-archived')),
    api: makeMockApi({ archived: true }),
    options: DEFAULT_OPTIONS,
  });
  const archivedRes = await archivedController.applyTitle({
    conversationId: 'arch-1',
    payload: { action: 'rename', reasonCode: 'initial_request', tasks: [{ id: 't1', subject: '数据库', verb: '排查', target: '连接超时', state: 'active' }] },
  });
  assert.equal(archivedRes.outcome, 'ineligible_conversation');
});

test('hook CLI entrypoint reads stdin JSON and outputs apply-title directive', (t) => {
  const dir = makeTempDir(t);
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  writeTranscript(transcriptPath, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n给支付回调接口增加幂等校验\n</USER_REQUEST>' },
  ]);

  const hookPath = path.resolve('src/hook.mjs');
  const payload = JSON.stringify({
    hookEventName: 'PreInvocation',
    conversationId: 'cli-test-conv',
    transcriptPath,
    lastUserInput: '给支付回调接口增加幂等校验',
  });

  const result = spawnSync(process.execPath, [hookPath], {
    input: payload,
    encoding: 'utf8',
    env: {
      ...process.env,
      PLUGIN_ROOT: path.resolve('.'),
      PLUGIN_DATA: path.join(dir, 'plugin-data'),
      ANTIGRAVITY_LS_ADDRESS: '',
      ANTIGRAVITY_CSRF_TOKEN: '',
    },
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.injectSteps?.length, 1);
  assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /apply-title\.mjs/);
  assert.match(parsed.injectSteps[0].systemMessage.systemMessage, /cli-test-conv/);
});
