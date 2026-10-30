import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { CliAdapter, parseCliLine, resolveAdapterOptions } from '../index.js'

const line = (record) => JSON.stringify(record)
const streamEvent = (event) => line({ type: 'stream_event', event })
const message = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect this' }] }]

function adapter(transport, events, activity, thoughts) {
  const facts = { ...resolveAdapterOptions({ command: 'codebuddy' }, process.cwd()), transport }
  return new CliAdapter({
    options: () => facts,
    onToolActivity: (sessionId, record) => activity.push({ sessionId, ...record }),
    ...(thoughts === undefined ? {} : { onThoughtActivity: (sessionId, text) => thoughts.push({ sessionId, text }) }),
    spawn: () => {
      const stdout = new PassThrough()
      setImmediate(() => stdout.end(events.map(lineOrText => `${lineOrText}\n`).join('')))
      return { stdout, done: Promise.resolve({ exitCode: 0 }), terminate() {}, async waitForExit() {} }
    },
  })
}

test('print separates thinking and tool progress from the final answer', async () => {
  const activity = []
  const events = [
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Need to inspect.' } }),
    streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'Read' } }),
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Opening file.' } }),
    streamEvent({ type: 'content_block_stop', index: 1 }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Need to inspect.Opening file.' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file: 'a.js' } }] } }),
    streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-2', name: 'Grep' } }),
    streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"pattern":"TODO"}' } }),
    streamEvent({ type: 'content_block_stop', index: 2 }),
    line({ type: 'user', parent_tool_use_id: 'call-1', message: { content: [
      { type: 'tool_result', tool_use_id: 'call-2', content: 'no matches\nsearched 2 files' },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' },
    ] } }),
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } }),
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }),
    line({ type: 'result', subtype: 'success', is_error: false }),
  ]
  const chunks = []
  for await (const chunk of adapter('print', events, activity).stream({ model: 'default', sessionId: 'harness-1', messages: message })) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Done')
  const thoughts = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  assert.match(thoughts, /Need to inspect/)
  assert.match(thoughts, /Opening file/)
  assert.doesNotMatch(thoughts, /file contents|no matches/)
  assert.deepEqual(activity, [
    { sessionId: 'harness-1', callId: 'call-1', toolName: 'Read', status: 'running' },
    { sessionId: 'harness-1', callId: 'call-1', toolName: 'Read', status: 'running', input: '{"file":"a.js"}' },
    { sessionId: 'harness-1', callId: 'call-2', toolName: 'Grep', status: 'running' },
    { sessionId: 'harness-1', callId: 'call-2', toolName: 'Grep', status: 'running', input: '{"pattern":"TODO"}' },
    { sessionId: 'harness-1', callId: 'call-2', toolName: 'Grep', status: 'ok', input: '{"pattern":"TODO"}', output: 'no matches\nsearched 2 files' },
    { sessionId: 'harness-1', callId: 'call-1', toolName: 'Read', status: 'ok', input: '{"file":"a.js"}', output: 'file contents' },
  ])
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('ACP activity uses the harness session id and stays outside answer text', async () => {
  const activity = []
  const instance = adapter('acp', [], activity)
  instance.acpTransport = () => ({
    async openSession() { return { sessionId: 'cli-session-2', created: true } },
    async *prompt() {
      yield { kind: 'thought', text: 'Checking.' }
      yield { kind: 'activity', record: { callId: 'call-2', toolName: 'Bash', status: 'running', input: '{"command":"pwd"}' } }
      yield { kind: 'activity', record: { callId: 'call-2', toolName: 'Bash', status: 'ok', output: '/workspace' } }
      yield { kind: 'text', text: 'Finished.' }
      return { stopReason: 'end_turn' }
    },
  })
  const chunks = []
  for await (const chunk of instance.stream({ model: 'default', sessionId: 'harness-2', messages: message })) chunks.push(chunk)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Finished.')
  assert.equal(chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), 'Checking.')
  assert.equal(activity.length, 2)
  assert.ok(activity.every(record => record.sessionId === 'harness-2'))
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('ACP records thinking after a tool at its own position', async () => {
  const activity = []
  const thoughts = []
  const order = []
  const instance = adapter('acp', [], activity, thoughts)
  instance.onToolActivity = (_, record) => order.push(record.status)
  instance.onThoughtActivity = (_, text) => order.push(text)
  instance.acpTransport = () => ({
    async openSession() { return { sessionId: 'cli-session', created: true } },
    async *prompt() {
      yield { kind: 'thought', text: 'Before.' }
      yield { kind: 'activity', record: { callId: 'call-1', toolName: 'Bash', status: 'running' } }
      yield { kind: 'activity', record: { callId: 'call-1', toolName: 'Bash', status: 'ok' } }
      yield { kind: 'thought', text: 'After.' }
      yield { kind: 'text', text: 'Done.' }
      return { stopReason: 'end_turn' }
    },
  })
  const chunks = []
  for await (const chunk of instance.stream({ model: 'default', sessionId: 'harness-1', messages: message })) chunks.push(chunk)
  assert.deepEqual(order, ['Before.', 'running', 'ok', 'After.'])
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false)
})

test('session thoughts are recorded in order around delegated Bash calls', async () => {
  const activity = []
  const thoughts = []
  const order = []
  const events = [
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Before bash.' } }),
    streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'bash-1', name: 'Bash' } }),
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"pwd"}' } }),
    streamEvent({ type: 'content_block_stop', index: 1 }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: '/workspace' }] } }),
    streamEvent({ type: 'message_start' }),
    streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'After bash.' } }),
    streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } }),
    line({ type: 'result', subtype: 'success', is_error: false }),
  ]
  const instance = adapter('print', events, activity, thoughts)
  instance.onToolActivity = (_, record) => { activity.push(record); order.push(record.status) }
  instance.onThoughtActivity = (_, text) => { thoughts.push(text); order.push(text) }
  const chunks = []
  for await (const chunk of instance.stream({ model: 'default', sessionId: 'harness-1', messages: message })) chunks.push(chunk)
  assert.deepEqual(order, ['Before bash.', 'running', 'running', 'ok', 'After bash.'])
  assert.equal(chunks.some(chunk => chunk.type === 'reasoning-delta'), false)
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'Done.')
})

test('parser ignores nested child thoughts and reports failed tool results', () => {
  assert.deepEqual(parseCliLine(line({ type: 'stream_event', parent_tool_use_id: 'parent', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private child' } } }), ''), { kind: 'ignored' })
  assert.deepEqual(parseCliLine(line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-x', is_error: true, content: 'denied' }] } }), ''), { kind: 'tool-result', callId: 'call-x', text: 'denied', failed: true })
  assert.deepEqual(parseCliLine(line({ type: 'assistant', message: { content: [
    { type: 'text', text: 'Running it.' },
    { type: 'tool_use', id: 'call-bash', name: 'Bash', input: { command: 'pwd' } },
  ] } }), ''), {
    kind: 'assistant', delta: { text: 'Running it.' },
    tools: [{ callId: 'call-bash', toolName: 'Bash', input: '{"command":"pwd"}' }],
  })
  assert.deepEqual(parseCliLine(line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'Check cwd.' }] } }), '', ''), {
    kind: 'assistant', tools: [], thought: { text: 'Check cwd.' },
  })
})
