import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewayServer } from '../lib/gateway-server.js'
import { harnessInternals } from '../lib/harness-bridge.js'

function ok(rpcId, value) {
  return { rpcId, result: { ok: true, value } }
}

function request() {
  return {
    schemaVersion: 'slashx.request.v1',
    event: 'user_message',
    runId: '11111111-1111-4111-8111-111111111111',
    traceId: '22222222-2222-4222-8222-222222222222',
    conversationId: '33333333-3333-4333-8333-333333333333',
    userId: 'user-1',
    agent: { id: 'agent-1', name: 'Agent' },
    client: { platform: 'pc-web', capabilities: ['stream', 'markdown'], locale: 'zh-CN' },
    input: { text: 'hello' },
    history: [],
    historyTruncated: false,
    extensions: {},
  }
}

function fakeHarness({ includeUsage = true } = {}) {
  const state = { phase: 'created', promptRpcId: undefined }
  let promptResolve
  const prompted = new Promise(resolve => { promptResolve = resolve })
  const sessionId = harnessInternals.sessionIdFor(request())
  return { state, api: {
    sessions: {
      create: async envelope => {
        state.phase = 'session-created'
        return ok(envelope.rpcId, { sessionId })
      },
      history: async envelope => {
        state.phase = 'history-read'
        return ok(envelope.rpcId, { events: [], hasMore: false })
      },
      list: async envelope => ok(envelope.rpcId, {
        items: [{ sessionId, running: false, blank: true, updatedAt: Date.now() }],
      }),
      prompt: async envelope => {
        state.phase = 'prompt-called'
        state.promptRpcId = envelope.rpcId
        const text = envelope.payload.content[0].text
        assert.match(text, /runId="11111111-1111-4111-8111-111111111111"/)
        assert.match(text, /<slashx_user_text>\n\nhello/)
        promptResolve()
        return ok(envelope.rpcId, { accepted: true })
      },
      cancel: async envelope => ok(envelope.rpcId, { accepted: true }),
      attachment: async envelope => ok(envelope.rpcId, { attachment: {}, data: '' }),
    },
    events: {
      async *mux(envelope, signal) {
        state.phase = 'mux-opened'
        yield { rpcId: envelope.rpcId, payload: { type: 'session/subscribed', sessionId, lastSeq: -1 } }
        state.phase = 'mux-subscribed'
        await prompted
        state.phase = 'mux-running'
        yield { rpcId: 'event-1', payload: { type: 'session/event', sessionId, event: { type: 'turn/start', seq: 0, data: { turn: 1 } } } }
        yield {
          rpcId: 'event-2',
          payload: {
            type: 'session/event',
            sessionId,
            event: {
              type: 'user/message',
              seq: 1,
              data: { id: 'message-1', role: 'user', content: [], source: { kind: 'user', rpcId: state.promptRpcId } },
            },
          },
        }
        yield {
          rpcId: 'event-3',
          payload: {
            type: 'session/event',
            sessionId,
            event: {
              type: 'assistant/chunk',
              seq: 2,
              data: {
                turn: 1,
                step: 1,
                chunk: includeUsage ? {
                  type: 'usage',
                  usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 3, reasoningTokens: 1 },
                } : { type: 'text-delta', index: 0, delta: '# Harness reply' },
              },
            },
          },
        }
        yield {
          rpcId: 'event-4',
          payload: {
            type: 'session/event',
            sessionId,
            event: {
              type: 'assistant/chunk',
              seq: 3,
              data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } },
            },
          },
        }
        yield {
          rpcId: 'event-5',
          payload: {
            type: 'session/event',
            sessionId,
            event: {
              type: 'assistant/message',
              seq: 4,
              data: {
                turn: 1,
                step: 1,
                message: {
                  content: [{ type: 'text', text: '# Harness reply' }],
                  source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
                },
                ...(includeUsage ? { usage: { inputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, outputTokens: 3, reasoningTokens: 1 } } : {}),
              },
            },
          },
        }
        yield { rpcId: 'event-6', payload: { type: 'session/event', sessionId, event: { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'completed' } } } } }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
      async *host(envelope, signal) {
        yield* []
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    },
    subagents: {
      list: async envelope => ok(envelope.rpcId, { entries: [], parentAvailable: true }),
    },
  } }
}

function within(promise, label, ms = 3000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${typeof label === 'function' ? label() : label} timed out`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

test('serves a real HTTP SlashX request through the Harness ApiProxy event loop', { timeout: 10_000 }, async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'slashx-gateway-e2e-'))
  const registered = []
  const harness = fakeHarness()
  const gateway = new GatewayServer({
    apiProxy: harness.api,
    tools: {
      register(tool) {
        registered.push(tool)
        return () => registered.splice(registered.indexOf(tool), 1)
      },
    },
    config: {
      host: '127.0.0.1',
      port: 0,
      token: 't'.repeat(32),
      stateRoot,
      requestTimeoutMs: 5000,
    },
  })
  await within(gateway.start(), 'gateway start')
  t.after(async () => {
    await within(gateway.stop(), 'gateway stop')
    await rm(stateRoot, { recursive: true, force: true })
  })
  assert.equal(registered[0].name, 'slashx_deliver')
  const response = await within(fetch(`http://127.0.0.1:${gateway.port}/slashx-provider/v1/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'t'.repeat(32)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request()),
  }), () => `gateway request (${harness.state.phase})`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.schemaVersion, 'slashx.response.v1')
  assert.equal(body.runStatus, 'success')
  assert.equal(body.messages[0].content.text, '# Harness reply')
  assert.equal(body.usage.promptTokens, 17)
  assert.equal(body.usage.completionTokens, 3)
  assert.equal(body.usage.totalTokens, 20)
  assert.equal(body.usage.modelUsed, 'deepseek-v4-flash')
  assert.deepEqual(body.extensions.slashxHarness.metering, {
    schemaVersion: 'slashx.harness-usage.v1',
    usageComplete: true,
    incompleteReasons: [],
    sessionCount: 1,
    subagentCount: 0,
    modelCalls: 1,
    uncachedInputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    billedPromptTokens: 17,
    outputTokens: 3,
    reasoningTokens: 1,
    models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash', calls: 1 }],
    modelCount: 1,
    modelsTruncated: false,
    modelUsed: 'deepseek-v4-flash',
  })
})

test('omits settlement usage and marks metering incomplete when Harness reports no tokens', { timeout: 10_000 }, async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'slashx-gateway-e2e-missing-usage-'))
  const harness = fakeHarness({ includeUsage: false })
  const gateway = new GatewayServer({
    apiProxy: harness.api,
    tools: { register: () => () => undefined },
    config: {
      host: '127.0.0.1',
      port: 0,
      token: 'u'.repeat(32),
      stateRoot,
      requestTimeoutMs: 5000,
    },
  })
  await within(gateway.start(), 'gateway start')
  t.after(async () => {
    await within(gateway.stop(), 'gateway stop')
    await rm(stateRoot, { recursive: true, force: true })
  })
  const response = await within(fetch(`http://127.0.0.1:${gateway.port}/slashx-provider/v1/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'u'.repeat(32)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request()),
  }), () => `gateway request (${harness.state.phase})`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.runStatus, 'success')
  assert.equal(body.usage, undefined)
  assert.equal(body.extensions.slashxHarness.metering.usageComplete, false)
  assert.deepEqual(body.extensions.slashxHarness.metering.incompleteReasons, ['model_usage_missing'])
})
