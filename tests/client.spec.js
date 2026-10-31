import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

function clientFixture(remote = { llm: { discoverModels: async () => ({ ok: true, value: [{ id: 'model-a' }] }) } }) {
  let descriptor;
  const registrations = [];
  const views = new Map();
  const document = {
    createElement: () => ({ dataset: {}, remove() {} }),
    head: { append() {} },
  };
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { descriptor = value; } } },
    document,
  });
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: initial => [initial, () => {}],
    useCallback: callback => callback,
    useEffect: effect => effect(),
  };
  const client = descriptor.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      IconChevronDownOutlineRegular: () => null,
      IconRefreshOutlineRegular: () => null,
      IconSearchOutlineRegular: () => null,
      IconThinkOutlineRegular: () => null,
    };
    throw new Error(`unexpected client import ${name}`);
  });
  client.apply({
    uiConversation: { events: { register: definition => registrations.push(definition) } },
    slots: {
      inject: (_name, register) => register(),
      register: (spec, view) => views.set(spec.key, view),
    },
    locale: { register: () => () => {} },
    remote,
    effect: effect => effect(),
  });
  return { descriptor, client, registrations, views };
}

function matching(definition, seq, status, fields = {}) {
  const event = {
    type: 'plugin:codebuddy/tool-call', seq, time: seq * 1_000, ignorable: true,
    data: { provider: 'codebuddy-cli', callId: 'bash-1', toolName: 'Bash', status, ...fields },
  };
  return { event, location: { kind: 'step', turn: { turn: 2 }, step: { step: 3 } } };
}

function textOf(element) {
  if (typeof element === 'string') return element;
  if (element == null || typeof element !== 'object') return '';
  return (element.children ?? []).map(textOf).join(' ');
}

test('client bundle registers plugin-owned Chat and Execution folds', () => {
  const { descriptor, client, registrations, views } = clientFixture();
  assert.equal(descriptor.id, 'dsh-codebuddy-llm');
  assert.deepEqual(Array.from(client.inject), ['uiConversation', 'slots', 'locale', 'remote', 'remote.llm']);
  assert.equal(registrations.length, 3);
  assert.equal(views.has('codebuddy-tool-call'), false);
  assert.ok(views.has('codebuddy-thought'));
  assert.ok(views.has('llm-cli'));

  const [chat, thought, execution] = registrations;
  const start = matching(chat, 10, 'running', { input: '{"command":"printf hello"}' });
  const result = matching(chat, 11, 'ok', { output: 'hello\nworld\n' });
  assert.equal(chat.match['plugin:codebuddy/tool-call'](start.event).id, 'codebuddy:codebuddy-cli:bash-1');
  assert.equal(chat.match['plugin:codebuddy/tool-call']({ ...start.event, type: 'tool/call' }), null);

  for (const definition of [chat, execution]) {
    const state = definition.update({ state: definition.start(undefined, start) }, result);
    const context = {
      key: `${definition.kind}:bash-1`, id: 'codebuddy:codebuddy-cli:bash-1',
      state, start, matches: [start, result],
    };
    const node = definition.buildViewNode(context);
    assert.equal(node.anchorSeq, 10);
    if (definition.target === 'chat') {
      assert.equal(node.kind, 'tool-call');
      assert.equal(node.data.root.kind, 'tool-result');
      assert.equal(node.data.root.call.argsRaw.includes('printf hello'), true);
      assert.equal(node.data.root.args.text('description'), 'printf hello');
    } else {
      assert.equal(node.turn, 2);
      assert.equal(node.data.step, 3);
      assert.equal(node.data.kind, 'run');
      assert.equal(node.data.status, 'succeeded');
      assert.equal(node.data.detail.content, 'hello\nworld\n');
    }
  }
  const thoughtEvent = { type: 'plugin:codebuddy/thought', seq: 12, time: 12_000, data: { provider: 'codebuddy-cli', text: 'After Bash.' } };
  const thoughtMatch = { event: thoughtEvent, location: start.location };
  assert.equal(thought.match['plugin:codebuddy/thought'](thoughtEvent).id, 'codebuddy:thought:12');
  const thoughtNode = thought.buildViewNode({ key: 'thought:12', id: 'codebuddy:thought:12', state: thought.start(undefined, thoughtMatch), start: thoughtMatch, matches: [thoughtMatch] });
  assert.equal(thoughtNode.anchorSeq, 12);
  assert.match(textOf(views.get('codebuddy-thought')({ node: thoughtNode, t: key => key })), /After Bash/);

  const wrapped = matching(chat, 13, 'ok', {
    input: '{"command":"pwd"}',
    output: 'Command: pwd\nStdout: /workspace\n\nStderr: (empty)\nExit Code: 0\nSignal: (none)',
  });
  const wrappedNode = chat.buildViewNode({
    key: 'bash:wrapped', id: 'codebuddy:codebuddy-cli:bash-1',
    state: chat.update({ state: chat.start(undefined, start) }, wrapped),
    start, matches: [start, wrapped],
  });
  assert.equal(wrappedNode.data.root.content[0].text, '/workspace\n[exit code: 0]');
});

test('models settings extension refreshes the CLI catalog', async () => {
  const calls = [];
  const { views } = clientFixture({ llm: {
    discoverModels: async (namespace, request) => {
      calls.push([namespace, request.provider]);
      return { ok: true, value: [{ id: 'claude-sonnet-5' }] };
    },
  } });
  const wrapper = views.get('llm-cli')({
    provider: { provider: 'codebuddy-cli', settingsNs: 'llm-cli' }, t: key => key,
  });
  wrapper.type(wrapper.props);
  await Promise.resolve();
  assert.deepEqual(calls, [['llm-cli', 'codebuddy-cli']]);
});

test('CodeBuddy tools project to native DSH tool rows', () => {
  const { registrations } = clientFixture();
  const chat = registrations[0];
  const cases = [
    ['Read', '{"file_path":"/workspace/a.txt","offset":1}', 'read'],
    ['Write', '{"file_path":"/workspace/a.txt","content":"hello"}', 'write'],
    ['Edit', '{"file_path":"/workspace/a.txt","old_string":"a","new_string":"b"}', 'edit'],
    ['Grep', '{"pattern":"TODO"}', 'grep'],
    ['Glob', '{"pattern":"*.js"}', 'glob'],
    ['WebSearch', '{"query":"docs"}', 'web_search'],
    ['WebFetch', '{"url":"https://example.com"}', 'web_fetch'],
    ['CustomTool', '{"key":"value"}', 'CustomTool'],
  ];
  for (const [toolName, input, nativeName] of cases) {
    const start = matching(chat, 20, 'running', { toolName, input });
    const result = matching(chat, 21, 'ok', { toolName, input, output: 'result' });
    const state = chat.update({ state: chat.start(undefined, start) }, result);
    const node = chat.buildViewNode({ key: toolName, id: toolName, state, start, matches: [start, result] });
    assert.equal(node.kind, 'tool-call');
    assert.equal(node.data.root.name, nativeName);
    assert.equal(node.data.root.call.name, nativeName);
    assert.equal(node.data.root.content[0].text, 'result');
  }
});
