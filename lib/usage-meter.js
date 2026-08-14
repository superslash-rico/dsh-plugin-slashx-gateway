import { randomUUID } from 'node:crypto'

const USAGE_SCHEMA_VERSION = 'slashx.harness-usage.v1'
const DEFAULT_MAX_DESCENDANTS = 256
const DEFAULT_MAX_MODEL_CALLS = 10_000
const MAX_REPORTED_MODELS = 64
const MAX_MODEL_ID_CHARS = 128
const QUIESCENCE_POLL_MS = 25
const REQUIRED_STABLE_POLLS = 2

function rpcId(prefix, runId) {
  return `${prefix}-${runId}-${randomUUID()}`
}

function unwrap(response, operation) {
  if (response?.result?.ok) return response.result.value
  throw new Error(response?.result?.error?.message || `${operation} failed`)
}

function addReason(reasons, reason) {
  if (reason) reasons.add(reason)
}

function safeToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function addSafe(total, value) {
  const next = total + value
  return Number.isSafeInteger(next) && next >= 0 ? next : undefined
}

/**
 * Harness TokenUsage fields are disjoint. Cached reads and writes therefore
 * belong in SlashX promptTokens; reasoningTokens is a diagnostic breakdown of
 * the completion and must not be charged a second time.
 */
export function normalizeHarnessUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return { ok: false, reason: 'model_usage_missing' }
  }
  const nativeShape = Object.hasOwn(usage, 'inputTokens') || Object.hasOwn(usage, 'outputTokens')
  const inputTokens = safeToken(nativeShape ? usage.inputTokens : usage.promptTokens)
  const outputTokens = safeToken(nativeShape ? usage.outputTokens : usage.completionTokens)
  const cacheReadTokens = Object.hasOwn(usage, 'cacheReadTokens') ? safeToken(usage.cacheReadTokens) : 0
  const cacheWriteTokens = Object.hasOwn(usage, 'cacheWriteTokens') ? safeToken(usage.cacheWriteTokens) : 0
  const reasoningTokens = Object.hasOwn(usage, 'reasoningTokens') ? safeToken(usage.reasoningTokens) : 0
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens].some(value => value === undefined)) {
    return { ok: false, reason: 'model_usage_invalid' }
  }
  let billedPromptTokens = nativeShape ? addSafe(inputTokens, cacheReadTokens) : inputTokens
  billedPromptTokens = nativeShape && billedPromptTokens !== undefined ? addSafe(billedPromptTokens, cacheWriteTokens) : billedPromptTokens
  if (billedPromptTokens === undefined) return { ok: false, reason: 'model_usage_invalid' }
  const uncachedInputTokens = nativeShape ? inputTokens : billedPromptTokens - cacheReadTokens - cacheWriteTokens
  if (!Number.isSafeInteger(uncachedInputTokens) || uncachedInputTokens < 0) return { ok: false, reason: 'model_usage_invalid' }
  return {
    ok: true,
    value: {
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      billedPromptTokens,
      outputTokens,
      reasoningTokens,
    },
  }
}

function attemptKey(turn, step) {
  return `${turn}:${step}`
}

function modelKey(provider, model) {
  return `${provider ?? ''}\0${model ?? ''}`
}

export class HarnessUsageAccumulator {
  constructor(rootSessionId, { maxModelCalls = DEFAULT_MAX_MODEL_CALLS } = {}) {
    this.rootSessionId = rootSessionId
    this.maxModelCalls = maxModelCalls
    this.modelCalls = 0
    this.sessions = new Map()
    this.lineage = new Map()
  }

  session(sessionId) {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        baseline: undefined,
        attempts: [],
        current: new Map(),
        reasons: new Set(),
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  subscribe(sessionId, lastSeq) {
    const state = this.session(sessionId)
    if (state.baseline === undefined) {
      state.baseline = Number.isSafeInteger(lastSeq) && lastSeq >= -1 ? lastSeq : -1
    }
  }

  setLineage(sessionId, parentSessionId) {
    if (typeof sessionId === 'string' && typeof parentSessionId === 'string') {
      this.lineage.set(sessionId, parentSessionId)
    }
  }

  addSessionReason(sessionId, reason) {
    addReason(this.session(sessionId).reasons, reason)
  }

  currentAttempt(state, turn, step) {
    const key = attemptKey(turn, step)
    let current = state.current.get(key)
    if (!current) {
      current = { turn, step, sawChunk: false, usage: undefined, usageReason: undefined, finishReason: undefined }
      state.current.set(key, current)
    }
    return current
  }

  commitAttempt(state, current) {
    if (!current.sawChunk && !current.usage && !current.usageReason) return undefined
    const record = {
      turn: current.turn,
      step: current.step,
      usage: current.usage,
      usageReason: current.usageReason,
      finishReason: current.finishReason,
      provider: undefined,
      model: undefined,
      awaitingMessage: true,
    }
    state.current.delete(attemptKey(current.turn, current.step))
    if (!this.appendAttempt(state, record)) return undefined
    return record
  }

  appendAttempt(state, record) {
    if (this.modelCalls >= this.maxModelCalls) {
      addReason(state.reasons, 'model_call_limit_exceeded')
      return false
    }
    state.attempts.push(record)
    this.modelCalls += 1
    return true
  }

  recordEvent(sessionId, event) {
    if (!event || typeof event !== 'object') return
    const state = this.session(sessionId)
    if (state.baseline === undefined) {
      state.baseline = Number.isSafeInteger(event.seq) ? event.seq - 1 : -1
      addReason(state.reasons, 'session_baseline_missing')
    }
    if (Number.isSafeInteger(event.seq) && event.seq <= state.baseline) return

    const data = event.data ?? {}
    if (event.type === 'assistant/chunk') {
      const turn = data.turn
      const step = data.step
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) {
        addReason(state.reasons, 'model_usage_invalid')
        return
      }
      const current = this.currentAttempt(state, turn, step)
      current.sawChunk = true
      if (data.chunk?.type === 'usage') {
        const normalized = normalizeHarnessUsage(data.chunk.usage)
        if (normalized.ok) {
          current.usage = normalized.value
          current.usageReason = undefined
        } else {
          current.usage = undefined
          current.usageReason = normalized.reason
        }
      }
      if (data.chunk?.type === 'finish') {
        current.finishReason = data.chunk.reason
        this.commitAttempt(state, current)
      }
      return
    }

    if (event.type === 'assistant/message') {
      const turn = data.turn
      const step = data.step
      if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step)) {
        addReason(state.reasons, 'model_usage_invalid')
        return
      }
      const key = attemptKey(turn, step)
      const open = state.current.get(key)
      if (open) this.commitAttempt(state, open)
      let candidates = state.attempts.filter(attempt => attempt.turn === turn && attempt.step === step && attempt.awaitingMessage)
      const lastCandidate = candidates.at(-1)
      const previousAttemptFailed = ['error', 'aborted'].includes(lastCandidate?.finishReason?.kind)
      if (!candidates.length || previousAttemptFailed) {
        const normalized = normalizeHarnessUsage(data.usage)
        const record = {
          turn,
          step,
          usage: normalized.ok ? normalized.value : undefined,
          usageReason: normalized.ok ? undefined : normalized.reason,
          finishReason: undefined,
          provider: undefined,
          model: undefined,
          awaitingMessage: true,
        }
        if (!this.appendAttempt(state, record)) return
        candidates = [...candidates, record]
      } else {
        const last = candidates.at(-1)
        if (!last.usage) {
          const normalized = normalizeHarnessUsage(data.usage)
          last.usage = normalized.ok ? normalized.value : undefined
          last.usageReason = normalized.ok ? undefined : normalized.reason
        }
      }
      const provider = data.message?.source?.provider
      const model = data.message?.source?.model
      for (const attempt of candidates) {
        attempt.provider = provider
        attempt.model = model
        attempt.awaitingMessage = false
      }
      return
    }

    if (event.type === 'turn/end') {
      for (const current of [...state.current.values()]) {
        if (current.turn === data.turn) this.commitAttempt(state, current)
      }
    }
  }

  descendantsOf(rootSessionId = this.rootSessionId) {
    const descendants = new Set()
    for (const sessionId of this.sessions.keys()) {
      let current = sessionId
      const seen = new Set()
      while (this.lineage.has(current) && !seen.has(current)) {
        seen.add(current)
        const parent = this.lineage.get(current)
        if (parent === rootSessionId) {
          descendants.add(sessionId)
          break
        }
        current = parent
      }
    }
    return descendants
  }

  finalize({ rootTurn, descendantIds = new Set(), extraReasons = [] } = {}) {
    const reasons = new Set(extraReasons)
    const selected = new Set([this.rootSessionId, ...descendantIds, ...this.descendantsOf()])
    const totals = {
      uncachedInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      billedPromptTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    }
    const models = new Map()
    let modelCalls = 0
    let rootCalls = 0
    let selectedSessions = 0
    let selectedSubagents = 0

    for (const sessionId of selected) {
      const state = this.sessions.get(sessionId)
      if (!state) continue
      for (const reason of state.reasons) addReason(reasons, reason)
      for (const current of [...state.current.values()]) this.commitAttempt(state, current)
      const attempts = state.attempts.filter(attempt => sessionId !== this.rootSessionId || attempt.turn === rootTurn)
      if (attempts.length || sessionId === this.rootSessionId) {
        selectedSessions += 1
        if (sessionId !== this.rootSessionId && attempts.length) selectedSubagents += 1
      }
      if (sessionId === this.rootSessionId) rootCalls += attempts.length
      for (const attempt of attempts) {
        modelCalls += 1
        if (!attempt.usage) {
          addReason(reasons, attempt.usageReason || 'model_usage_missing')
          continue
        }
        for (const key of Object.keys(totals)) {
          const next = addSafe(totals[key], attempt.usage[key])
          if (next === undefined) addReason(reasons, 'model_usage_invalid')
          else totals[key] = next
        }
        if (attempt.model) {
          const provider = typeof attempt.provider === 'string' ? attempt.provider.slice(0, MAX_MODEL_ID_CHARS) : undefined
          const model = attempt.model.slice(0, MAX_MODEL_ID_CHARS)
          const key = modelKey(provider, model)
          const current = models.get(key) ?? { provider, model, calls: 0 }
          current.calls += 1
          models.set(key, current)
        }
      }
    }
    if (rootCalls === 0) addReason(reasons, 'model_usage_missing')
    if (addSafe(totals.billedPromptTokens, totals.outputTokens) === undefined) {
      addReason(reasons, 'model_usage_invalid')
    }
    const allModels = [...models.values()].sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`))
    const modelList = allModels.slice(0, MAX_REPORTED_MODELS)
    const incompleteReasons = [...reasons].sort()
    return {
      schemaVersion: USAGE_SCHEMA_VERSION,
      usageComplete: incompleteReasons.length === 0,
      incompleteReasons,
      sessionCount: selectedSessions,
      subagentCount: selectedSubagents,
      modelCalls,
      ...totals,
      models: modelList,
      modelCount: allModels.length,
      modelsTruncated: allModels.length > modelList.length,
      modelUsed: allModels.length === 1 ? allModels[0].model : allModels.length > 1 ? 'multiple' : undefined,
    }
  }
}

function textFromBlocks(blocks) {
  return (blocks ?? []).filter(block => block?.type === 'text').map(block => block.text ?? '').join('')
}

function imagesFromBlocks(blocks) {
  return (blocks ?? []).filter(block => block?.type === 'image' && block.attachment).map(block => block.attachment)
}

function abortableDelay(ms, signal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    function done() {
      signal.removeEventListener('abort', done)
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

function turnKey(sessionId, turn) {
  return `${sessionId}\0${turn}`
}

export function createHarnessRunCollector({ apiProxy, rootSessionId, runId, promptRpcId, timeoutMs, maxDescendants = DEFAULT_MAX_DESCENDANTS }) {
  const abort = new AbortController()
  const deadline = Date.now() + timeoutMs
  const timeout = setTimeout(() => abort.abort(new Error('Harness turn timed out')), timeoutMs)
  const accumulator = new HarnessUsageAccumulator(rootSessionId)
  const descendantIds = new Set()
  const trackedDescendantIds = new Set()
  const baselineDescendantIds = new Set()
  const extraReasons = new Set()
  const hostErrors = new Map()
  const subscriptionBaselines = new Map()
  const pendingEvents = new Map()
  const droppedPendingSessions = new Set()
  const maxPendingEvents = maxDescendants * 16
  let pendingEventCount = 0
  const rootTurns = new Map()
  let targetTurn
  let latestRootTurn
  let readySettled = false
  let resultSettled = false
  let readyResolve
  let readyReject
  let resultResolve
  let resultReject
  let closed = false
  let baselineCaptured = false

  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const result = new Promise((resolve, reject) => {
    resultResolve = resolve
    resultReject = reject
  })
  ready.catch(() => undefined)
  result.catch(() => undefined)

  function resolveReady(value) {
    if (readySettled) return
    readySettled = true
    readyResolve(value)
  }

  function rejectReady(error) {
    if (readySettled) return
    readySettled = true
    readyReject(error)
  }

  function rejectResult(error) {
    if (resultSettled) return
    resultSettled = true
    resultReject(error)
  }

  abort.signal.addEventListener('abort', () => {
    const error = abort.signal.reason instanceof Error ? abort.signal.reason : new Error('Harness event collection aborted')
    rejectReady(error)
    rejectResult(error)
  }, { once: true })

  function rootTurnState(turn) {
    const key = turnKey(rootSessionId, turn)
    let state = rootTurns.get(key)
    if (!state) {
      state = { lastText: '', images: [], reason: undefined }
      rootTurns.set(key, state)
    }
    return state
  }

  function usageRelevantEvent(event) {
    if (event?.type === 'assistant/message' || event?.type === 'turn/end') return true
    return event?.type === 'assistant/chunk' && ['usage', 'finish'].includes(event.data?.chunk?.type)
  }

  function bufferPendingEvent(sessionId, event) {
    if (!usageRelevantEvent(event)) return
    if (pendingEventCount >= maxPendingEvents) {
      droppedPendingSessions.add(sessionId)
      return
    }
    const events = pendingEvents.get(sessionId) ?? []
    events.push(event)
    pendingEvents.set(sessionId, events)
    pendingEventCount += 1
  }

  function replayPendingEvents(sessionId) {
    const events = pendingEvents.get(sessionId) ?? []
    for (const event of events) accumulator.recordEvent(sessionId, event)
    pendingEventCount -= events.length
    pendingEvents.delete(sessionId)
    if (droppedPendingSessions.has(sessionId)) {
      accumulator.addSessionReason(sessionId, 'lineage_event_buffer_overflow')
    }
  }

  function promoteKnownDescendants() {
    let changed = true
    while (changed) {
      changed = false
      for (const [sessionId, parentSessionId] of accumulator.lineage) {
        if (trackedDescendantIds.has(sessionId)) continue
        if (parentSessionId === rootSessionId || trackedDescendantIds.has(parentSessionId)) {
          trackedDescendantIds.add(sessionId)
          descendantIds.add(sessionId)
          if (subscriptionBaselines.has(sessionId)) accumulator.subscribe(sessionId, subscriptionBaselines.get(sessionId))
          replayPendingEvents(sessionId)
          changed = true
        }
      }
    }
  }

  function recordLineage(sessionId, parentSessionId) {
    accumulator.setLineage(sessionId, parentSessionId)
    promoteKnownDescendants()
  }

  function handleRootEvent(event) {
    const data = event.data ?? {}
    if (event.type === 'turn/start' && Number.isSafeInteger(data.turn)) {
      latestRootTurn = data.turn
      rootTurnState(data.turn)
      return
    }
    if (event.type === 'user/message' && data.source?.kind === 'user' && data.source.rpcId === promptRpcId) {
      if (Number.isSafeInteger(latestRootTurn)) targetTurn = latestRootTurn
      else addReason(extraReasons, 'root_turn_correlation_missing')
      return
    }
    if (event.type === 'assistant/message' && data.turn === targetTurn) {
      const state = rootTurnState(targetTurn)
      const text = textFromBlocks(data.message?.content)
      if (text) state.lastText = text
      const images = imagesFromBlocks(data.message?.content)
      if (images.length) state.images = images
      return
    }
    if (event.type === 'turn/end' && data.turn === targetTurn) {
      const state = rootTurnState(targetTurn)
      state.reason = data.reason
      if (!resultSettled) {
        resultSettled = true
        resultResolve({ ...state, turn: targetTurn })
      }
    }
  }

  const muxTask = (async () => {
    try {
      const stream = apiProxy.events.mux({ rpcId: rpcId('slashx-mux', runId), payload: {} }, abort.signal)
      for await (const envelope of stream) {
        const frame = envelope.payload
        if (frame?.type === 'session/subscribed') {
          subscriptionBaselines.set(frame.sessionId, frame.lastSeq)
          if (frame.sessionId === rootSessionId || trackedDescendantIds.has(frame.sessionId)) {
            accumulator.subscribe(frame.sessionId, frame.lastSeq)
          }
          if (frame.sessionId === rootSessionId) resolveReady(frame.lastSeq)
          continue
        }
        if (frame?.type === 'stream/error') throw new Error(frame.error?.message || 'Harness event stream failed')
        if (frame?.type !== 'session/event') continue
        if (frame.sessionId === rootSessionId) {
          accumulator.recordEvent(frame.sessionId, frame.event)
          handleRootEvent(frame.event)
        } else if (trackedDescendantIds.has(frame.sessionId)) {
          accumulator.recordEvent(frame.sessionId, frame.event)
        } else {
          bufferPendingEvent(frame.sessionId, frame.event)
        }
      }
      if (!abort.signal.aborted) throw new Error('Harness event stream ended unexpectedly')
    } catch (error) {
      if (!abort.signal.aborted) {
        addReason(extraReasons, 'mux_stream_error')
        rejectReady(error)
        rejectResult(error)
      }
    }
  })()

  const hostTask = (async () => {
    try {
      if (typeof apiProxy.events.host !== 'function') {
        addReason(extraReasons, 'host_stream_unavailable')
        return
      }
      const stream = apiProxy.events.host({ rpcId: rpcId('slashx-host', runId), payload: {} }, abort.signal)
      for await (const envelope of stream) {
        const frame = envelope.payload
        if (frame?.type === 'stream/error') throw new Error(frame.error?.message || 'Harness host stream failed')
        if (frame?.type === 'host/session-added' && frame.origin === 'subagent' && frame.parentSessionId) {
          recordLineage(frame.sessionId, frame.parentSessionId)
        }
        if (frame?.type === 'host/agent-error' && hostErrors.size < maxDescendants * 2) {
          hostErrors.set(frame.sessionId, frame.message)
        }
      }
      if (!abort.signal.aborted) addReason(extraReasons, 'host_stream_error')
    } catch {
      if (!abort.signal.aborted) addReason(extraReasons, 'host_stream_error')
    }
  })()

  async function snapshotDescendants() {
    if (typeof apiProxy.subagents?.list !== 'function') {
      addReason(extraReasons, 'subagent_catalog_unavailable')
      return { running: new Set(), signature: '' }
    }
    const queue = [rootSessionId]
    const visited = new Set()
    const running = new Set()
    while (queue.length) {
      const parentSessionId = queue.shift()
      if (visited.has(parentSessionId)) continue
      visited.add(parentSessionId)
      let catalog
      try {
        catalog = unwrap(await apiProxy.subagents.list({
          rpcId: rpcId('slashx-subagents', runId),
          payload: { parentSessionId },
        }, abort.signal), 'subagents.list')
      } catch {
        addReason(extraReasons, 'subagent_catalog_error')
        return { running, signature: [...descendantIds].sort().join('\0') }
      }
      for (const entry of catalog.entries ?? []) {
        if (entry?.kind !== 'child' || typeof entry.id !== 'string') {
          if (entry?.kind === 'diagnostic') addReason(extraReasons, 'subagent_catalog_diagnostic')
          continue
        }
        recordLineage(entry.id, parentSessionId)
        if (descendantIds.size > maxDescendants) {
          addReason(extraReasons, 'subagent_limit_exceeded')
          return { running, signature: [...descendantIds].sort().join('\0') }
        }
        if (entry.activity === 'running') running.add(entry.id)
        if (entry.hasChildren) queue.push(entry.id)
      }
    }
    return { running, signature: [...descendantIds].sort().join('\0') }
  }

  async function verifyRootIdleAtBaseline() {
    if (typeof apiProxy.sessions?.list !== 'function') {
      addReason(extraReasons, 'root_status_unavailable')
      return
    }
    try {
      const listing = unwrap(await apiProxy.sessions.list({
        rpcId: rpcId('slashx-sessions', runId),
        payload: {},
      }, abort.signal), 'sessions.list')
      const root = (listing.items ?? []).find(item => item?.sessionId === rootSessionId)
      if (!root) addReason(extraReasons, 'root_status_unavailable')
      else if (root.running) addReason(extraReasons, 'preexisting_root_running')
    } catch {
      addReason(extraReasons, 'root_status_error')
    }
  }

  async function captureBaseline() {
    await verifyRootIdleAtBaseline()
    const snapshot = await snapshotDescendants()
    for (const sessionId of descendantIds) baselineDescendantIds.add(sessionId)
    if (snapshot.running.size) addReason(extraReasons, 'preexisting_descendant_running')
    baselineCaptured = true
  }

  async function finalize() {
    if (!baselineCaptured) addReason(extraReasons, 'subagent_baseline_missing')
    let stablePolls = 0
    let previousSignature
    while (!abort.signal.aborted && Date.now() < deadline) {
      const snapshot = await snapshotDescendants()
      if (snapshot.running.size === 0 && snapshot.signature === previousSignature) stablePolls += 1
      else stablePolls = snapshot.running.size === 0 ? 1 : 0
      previousSignature = snapshot.signature
      if (stablePolls >= REQUIRED_STABLE_POLLS) break
      await abortableDelay(Math.min(QUIESCENCE_POLL_MS, Math.max(1, deadline - Date.now())), abort.signal)
    }
    if (stablePolls < REQUIRED_STABLE_POLLS) addReason(extraReasons, 'descendants_not_quiescent')
    for (const sessionId of accumulator.descendantsOf()) descendantIds.add(sessionId)
    for (const sessionId of baselineDescendantIds) {
      const state = accumulator.sessions.get(sessionId)
      if (state && (state.attempts.length || state.current.size)) {
        addReason(extraReasons, 'preexisting_descendant_activity')
      }
    }
    for (const sessionId of descendantIds) {
      if (hostErrors.has(sessionId)) accumulator.addSessionReason(sessionId, 'subagent_runtime_error')
    }
    await close()
    return accumulator.finalize({ rootTurn: targetTurn, descendantIds, extraReasons })
  }

  async function close() {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    abort.abort()
    await Promise.allSettled([muxTask, hostTask])
    if (!readySettled) rejectReady(new Error('Harness event stream closed before subscription'))
    if (!resultSettled) rejectResult(new Error('Harness event stream closed before the target turn ended'))
  }

  return { ready, result, captureBaseline, finalize, close, abort, accumulator }
}

export const usageMeterInternals = {
  USAGE_SCHEMA_VERSION,
  DEFAULT_MAX_DESCENDANTS,
  DEFAULT_MAX_MODEL_CALLS,
  addSafe,
}
