import assert from 'node:assert/strict'
import test from 'node:test'
import { createHarnessRunCollector, HarnessUsageAccumulator, normalizeHarnessUsage } from '../lib/usage-meter.js'

function event(type, seq, data) {
  return { type, seq, data }
}

function recordAttempt(meter, sessionId, { seq, turn = 1, step = 1, usage, provider = 'deepseek-official', model = 'deepseek-v4-flash', message = true, finishKind = 'stop' }) {
  meter.recordEvent(sessionId, event('assistant/chunk', seq, { turn, step, chunk: { type: 'usage', usage } }))
  meter.recordEvent(sessionId, event('assistant/chunk', seq + 1, { turn, step, chunk: { type: 'finish', reason: { kind: finishKind } } }))
  if (message) {
    meter.recordEvent(sessionId, event('assistant/message', seq + 2, {
      turn,
      step,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider, model } },
      usage,
    }))
  }
}

test('normalizes disjoint Harness cache tokens without double charging reasoning tokens', () => {
  assert.deepEqual(normalizeHarnessUsage({
    inputTokens: 10,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
  }), {
    ok: true,
    value: {
      uncachedInputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      billedPromptTokens: 17,
      outputTokens: 3,
      reasoningTokens: 1,
    },
  })
  assert.equal(normalizeHarnessUsage({ inputTokens: -1, outputTokens: 2 }).reason, 'model_usage_invalid')
  assert.equal(normalizeHarnessUsage(undefined).reason, 'model_usage_missing')
  assert.deepEqual(normalizeHarnessUsage({
    promptTokens: 12,
    completionTokens: 3,
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
  }).value, {
    uncachedInputTokens: 7,
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
    billedPromptTokens: 12,
    outputTokens: 3,
    reasoningTokens: 0,
  })
})

test('aggregates root, child, cached tokens and retry attempts into one complete meter', () => {
  const meter = new HarnessUsageAccumulator('root')
  meter.subscribe('root', -1)
  meter.subscribe('child', -1)
  meter.setLineage('child', 'root')

  recordAttempt(meter, 'root', {
    seq: 0,
    usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1 },
  })
  recordAttempt(meter, 'child', {
    seq: 0,
    usage: { inputTokens: 4, outputTokens: 1 },
    message: false,
    finishKind: 'error',
  })
  meter.recordEvent('child', event('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'openai-compatible', model: 'worker-model' } },
    usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 2 },
  }))

  const report = meter.finalize({ rootTurn: 1, descendantIds: new Set(['child']) })
  assert.equal(report.usageComplete, true)
  assert.deepEqual(report.incompleteReasons, [])
  assert.equal(report.sessionCount, 2)
  assert.equal(report.subagentCount, 1)
  assert.equal(report.modelCalls, 3)
  assert.equal(report.uncachedInputTokens, 20)
  assert.equal(report.cacheReadTokens, 7)
  assert.equal(report.cacheWriteTokens, 2)
  assert.equal(report.billedPromptTokens, 29)
  assert.equal(report.outputTokens, 6)
  assert.equal(report.reasoningTokens, 1)
  assert.equal(report.modelUsed, 'multiple')
  assert.deepEqual(report.models, [
    { provider: 'deepseek-official', model: 'deepseek-v4-flash', calls: 1 },
    { provider: 'openai-compatible', model: 'worker-model', calls: 2 },
  ])
})

test('marks a model attempt incomplete when neither raw chunks nor message carry usage', () => {
  const meter = new HarnessUsageAccumulator('root')
  meter.subscribe('root', -1)
  meter.recordEvent('root', event('assistant/chunk', 0, { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, delta: 'hello' } }))
  meter.recordEvent('root', event('assistant/chunk', 1, { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }))
  meter.recordEvent('root', event('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  }))

  const report = meter.finalize({ rootTurn: 1 })
  assert.equal(report.usageComplete, false)
  assert.deepEqual(report.incompleteReasons, ['model_usage_missing'])
  assert.equal(report.modelCalls, 1)
  assert.equal(report.billedPromptTokens, 0)
})

test('fails closed when a run exceeds the bounded model-call ledger', () => {
  const meter = new HarnessUsageAccumulator('root', { maxModelCalls: 1 })
  meter.subscribe('root', -1)
  recordAttempt(meter, 'root', { seq: 0, usage: { inputTokens: 2, outputTokens: 1 }, step: 1 })
  recordAttempt(meter, 'root', { seq: 3, usage: { inputTokens: 3, outputTokens: 1 }, step: 2 })

  const report = meter.finalize({ rootTurn: 1 })
  assert.equal(report.usageComplete, false)
  assert.ok(report.incompleteReasons.includes('model_call_limit_exceeded'))
  assert.equal(report.modelCalls, 1)
})

test('ignores events at or before each session subscription baseline', () => {
  const meter = new HarnessUsageAccumulator('root')
  meter.subscribe('root', 10)
  recordAttempt(meter, 'root', { seq: 8, usage: { inputTokens: 999, outputTokens: 999 } })
  recordAttempt(meter, 'root', { seq: 11, usage: { inputTokens: 2, outputTokens: 1 } })

  const report = meter.finalize({ rootTurn: 1 })
  assert.equal(report.usageComplete, true)
  assert.equal(report.billedPromptTokens, 2)
  assert.equal(report.outputTokens, 1)
  assert.equal(report.modelCalls, 1)
})

test('collector follows a child session and waits for an inactive stable catalog before settlement', async () => {
  let releaseRun
  const runReleased = new Promise(resolve => { releaseRun = resolve })
  let baselineCaptured = false
  const rootSessionId = 'root'
  const childSessionId = 'child'
  const promptRpcId = 'prompt-rpc'
  const apiProxy = {
    sessions: {
      list: async envelope => ({
        rpcId: envelope.rpcId,
        result: { ok: true, value: { items: [{ sessionId: rootSessionId, running: false, blank: false, updatedAt: Date.now() }] } },
      }),
    },
    events: {
      async *mux(envelope, signal) {
        yield { rpcId: envelope.rpcId, payload: { type: 'session/subscribed', sessionId: rootSessionId, lastSeq: -1 } }
        await runReleased
        yield { rpcId: 'r1', payload: { type: 'session/event', sessionId: rootSessionId, event: event('turn/start', 0, { turn: 1 }) } }
        yield { rpcId: 'r2', payload: { type: 'session/event', sessionId: rootSessionId, event: event('user/message', 1, { role: 'user', content: [], source: { kind: 'user', rpcId: promptRpcId } }) } }
        yield { rpcId: 'o0', payload: { type: 'session/subscribed', sessionId: 'unrelated', lastSeq: -1 } }
        yield { rpcId: 'o1', payload: { type: 'session/event', sessionId: 'unrelated', event: event('assistant/message', 0, { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'other', model: 'expensive' } }, usage: { inputTokens: 9999, outputTokens: 9999 } }) } }
        yield { rpcId: 'c0', payload: { type: 'session/subscribed', sessionId: childSessionId, lastSeq: -1 } }
        yield { rpcId: 'c1', payload: { type: 'session/event', sessionId: childSessionId, event: event('assistant/chunk', 0, { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 4, cacheReadTokens: 3, outputTokens: 2 } } }) } }
        yield { rpcId: 'c2', payload: { type: 'session/event', sessionId: childSessionId, event: event('assistant/chunk', 1, { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } }) } }
        yield { rpcId: 'c3', payload: { type: 'session/event', sessionId: childSessionId, event: event('assistant/message', 2, { turn: 1, step: 1, message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'child-model' } }, usage: { inputTokens: 4, cacheReadTokens: 3, outputTokens: 2 } }) } }
        yield { rpcId: 'r3', payload: { type: 'session/event', sessionId: rootSessionId, event: event('assistant/message', 2, { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'deepseek-official', model: 'root-model' } }, usage: { inputTokens: 5, outputTokens: 1 } }) } }
        yield { rpcId: 'r4', payload: { type: 'session/event', sessionId: rootSessionId, event: event('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }) } }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
      async *host(envelope, signal) {
        await runReleased
        yield { rpcId: envelope.rpcId, payload: { type: 'host/session-added', sessionId: childSessionId, parentSessionId: rootSessionId, origin: 'subagent', blank: true } }
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      },
    },
    subagents: {
      list: async envelope => ({
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            parentAvailable: true,
            entries: baselineCaptured ? [{ kind: 'child', id: childSessionId, activity: 'inactive', hasChildren: false, mode: 'one-shot' }] : [],
          },
        },
      }),
    },
  }
  const collector = createHarnessRunCollector({
    apiProxy,
    rootSessionId,
    runId: 'run-1',
    promptRpcId,
    timeoutMs: 2000,
  })
  await collector.ready
  await collector.captureBaseline()
  baselineCaptured = true
  releaseRun()
  const result = await collector.result
  assert.equal(result.lastText, 'done')
  const report = await collector.finalize()
  assert.equal(report.usageComplete, true)
  assert.equal(report.subagentCount, 1)
  assert.equal(report.modelCalls, 2)
  assert.equal(report.billedPromptTokens, 12)
  assert.equal(report.outputTokens, 3)
  assert.equal(report.modelUsed, 'multiple')
})
