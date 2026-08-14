import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { assertRequestV1, gatewayCapabilities, makeErrorResponse, makeResponse, ProtocolError } from './protocol.js'
import { requestSafeRemote } from './media.js'
import { ArtifactStore } from './artifact-store.js'
import { ActiveRunRegistry, createDeliveryTool } from './delivery.js'
import { conversationKeyFor, HarnessBridge } from './harness-bridge.js'
import { requestDigest, RunLedger } from './run-ledger.js'

function positiveInteger(value, fallback, min, max, label) {
  const number = Number(value ?? fallback)
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
  }
  return number
}

function normalizeHost(value) {
  if (value === undefined || value === '127.0.0.1') return '127.0.0.1'
  if (value === '0.0.0.0') return value
  throw new Error('host must be 127.0.0.1 or 0.0.0.0')
}

export function normalizeConfig(config = {}) {
  const token = typeof config.token === 'string' ? config.token : ''
  if (token.length < 32) throw new Error('SLASHX_GATEWAY_TOKEN must contain at least 32 characters')
  const stateRoot = typeof config.stateRoot === 'string' && config.stateRoot.trim()
    ? config.stateRoot
    : join(process.cwd(), '.deepseek-harness', 'slashx-gateway')
  let publicBaseUrl
  if (typeof config.publicBaseUrl === 'string' && config.publicBaseUrl.trim()) {
    const parsed = new URL(config.publicBaseUrl)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('SLASHX_GATEWAY_PUBLIC_BASE_URL must be an HTTP(S) URL without credentials')
    }
    publicBaseUrl = parsed.toString().replace(/\/$/, '')
  }
  const privateMediaHosts = new Set(
    Array.isArray(config.privateMediaHosts)
      ? config.privateMediaHosts
        .map(value => String(value).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
        .filter(Boolean)
      : [],
  )
  return {
    host: normalizeHost(config.host),
    port: positiveInteger(config.port, 3090, 0, 65535, 'port'),
    token,
    publicBaseUrl,
    stateRoot,
    agentPreset: typeof config.agentPreset === 'string' && config.agentPreset.trim() ? config.agentPreset.trim() : undefined,
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, 300_000, 1_000, 3_600_000, 'requestTimeoutMs'),
    maxRequestBytes: positiveInteger(config.maxRequestBytes, 16 * 1024 * 1024, 1024, 100 * 1024 * 1024, 'maxRequestBytes'),
    maxMediaBytes: positiveInteger(config.maxMediaBytes, 25 * 1024 * 1024, 1024, 1024 * 1024 * 1024, 'maxMediaBytes'),
    maxTotalMediaBytes: positiveInteger(config.maxTotalMediaBytes, 50 * 1024 * 1024, 1024, 2 * 1024 * 1024 * 1024, 'maxTotalMediaBytes'),
    maxConversationBytes: positiveInteger(config.maxConversationBytes, 1024 * 1024 * 1024, 1024, 1024 * 1024 * 1024 * 1024, 'maxConversationBytes'),
    maxPrincipalBytes: positiveInteger(config.maxPrincipalBytes, 5 * 1024 * 1024 * 1024, 1024, 1024 * 1024 * 1024 * 1024, 'maxPrincipalBytes'),
    maxWorkspaceBytes: positiveInteger(config.maxWorkspaceBytes, 20 * 1024 * 1024 * 1024, 1024, 1024 * 1024 * 1024 * 1024, 'maxWorkspaceBytes'),
    maxArtifactStoreBytes: positiveInteger(config.maxArtifactStoreBytes, 2 * 1024 * 1024 * 1024, 1024, 1024 * 1024 * 1024 * 1024, 'maxArtifactStoreBytes'),
    maxStoredArtifacts: positiveInteger(config.maxStoredArtifacts, 10_000, 1, 1_000_000, 'maxStoredArtifacts'),
    maxArtifactBytesPerRun: positiveInteger(config.maxArtifactBytesPerRun, 100 * 1024 * 1024, 1024, 100 * 1024 * 1024 * 1024, 'maxArtifactBytesPerRun'),
    maxArtifactsPerRun: positiveInteger(config.maxArtifactsPerRun, 20, 1, 1000, 'maxArtifactsPerRun'),
    assetTtlSeconds: positiveInteger(config.assetTtlSeconds, 86_400, 60, 31_536_000, 'assetTtlSeconds'),
    maxConcurrentRuns: positiveInteger(config.maxConcurrentRuns, 4, 1, 256, 'maxConcurrentRuns'),
    maxQueuedRuns: positiveInteger(config.maxQueuedRuns, 100, 0, 10_000, 'maxQueuedRuns'),
    maxRunLedgerEntries: positiveInteger(config.maxRunLedgerEntries, 100_000, 1, 10_000_000, 'maxRunLedgerEntries'),
    maxRunLedgerEntriesPerPrincipal: positiveInteger(config.maxRunLedgerEntriesPerPrincipal, 10_000, 1, 1_000_000, 'maxRunLedgerEntriesPerPrincipal'),
    runRetentionSeconds: positiveInteger(config.runRetentionSeconds, 30 * 24 * 60 * 60, 3600, 10 * 365 * 24 * 60 * 60, 'runRetentionSeconds'),
    allowHttpMedia: config.allowHttpMedia === true,
    privateMediaHosts,
  }
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

function authorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const supplied = Buffer.from(header.slice(7))
  const expected = Buffer.from(token)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

async function readJson(req, maxBytes) {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) throw new ProtocolError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415)
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProtocolError('REQUEST_TOO_LARGE', `request exceeds ${maxBytes} bytes`, 413)
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) throw new ProtocolError('REQUEST_TOO_LARGE', `request exceeds ${maxBytes} bytes`, 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')) } catch {
    throw new ProtocolError('INVALID_JSON', 'request body is not valid JSON', 400)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function callback(response, request, network) {
  const grant = request.extensions?.slashxAsync
  if (!grant || Date.now() >= grant.callbackExpiresAt) return { delivered: false, reason: 'expired' }
  const payload = {
    ...response,
    runId: grant.callbackRunId,
    traceId: request.traceId,
  }
  let lastError
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (Date.now() >= grant.callbackExpiresAt) return { delivered: false, reason: 'expired' }
    try {
      const result = await requestSafeRemote(grant.callbackUrl, network, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SlashX-Callback-Token': grant.callbackToken,
          ...(grant.idempotencyKey ? { 'Idempotency-Key': grant.idempotencyKey } : {}),
        },
        body: JSON.stringify(payload),
        maxResponseBytes: 64 * 1024,
      })
      if (result.status >= 200 && result.status < 300) return { delivered: true }
      lastError = `HTTP ${result.status}`
      if (result.status >= 400 && result.status < 500 && result.status !== 429) break
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(250 * (2 ** attempt))
  }
  return { delivered: false, reason: lastError || 'callback failed' }
}

function pendingResponse(request, publicBaseUrl) {
  const base = publicBaseUrl ? `${publicBaseUrl}/slashx-provider/v1/runs/${request.runId}` : undefined
  const response = makeResponse({
    request,
    runStatus: 'running',
    progress: 0.01,
    content: {},
    extensions: {
      externalRunId: request.runId,
      ...(base ? { cancelUrl: base } : {}),
    },
  })
  if (base) response.nextPoll = { afterMs: 3000, url: base }
  return response
}

export class GatewayServer {
  constructor({ apiProxy, tools, logger = console, config }) {
    this.apiProxy = apiProxy
    this.tools = tools
    this.logger = logger
    this.config = normalizeConfig(config)
    this.registry = new ActiveRunRegistry()
    const assetSecret = createHash('sha256').update(`asset:${this.config.token}`).digest()
    this.artifactStore = new ArtifactStore({
      root: join(this.config.stateRoot, 'artifacts'),
      publicBaseUrl: this.config.publicBaseUrl,
      secret: assetSecret,
      ttlSeconds: this.config.assetTtlSeconds,
      maxBytes: this.config.maxMediaBytes,
      maxTotalBytes: this.config.maxArtifactStoreBytes,
      maxArtifacts: this.config.maxStoredArtifacts,
      maxBytesPerRun: this.config.maxArtifactBytesPerRun,
      maxArtifactsPerRun: this.config.maxArtifactsPerRun,
    })
    this.ledger = new RunLedger(join(this.config.stateRoot, 'runs'), {
      maxEntries: this.config.maxRunLedgerEntries,
      maxEntriesPerPrincipal: this.config.maxRunLedgerEntriesPerPrincipal,
      retentionMs: this.config.runRetentionSeconds * 1000,
    })
    this.running = new Map()
    this.conversationTails = new Map()
    this.activeExecutions = 0
    this.capacityWaiters = []
  }

  async initialize() {
    await Promise.all([this.artifactStore.initialize(), this.ledger.initialize()])
    this.bridge = new HarnessBridge({
      apiProxy: this.apiProxy,
      registry: this.registry,
      artifactStore: this.artifactStore,
      options: {
        workspaceRoot: join(this.config.stateRoot, 'conversations'),
        requestTimeoutMs: this.config.requestTimeoutMs,
        agentPreset: this.config.agentPreset,
        media: {
          maxMediaBytes: this.config.maxMediaBytes,
          maxTotalMediaBytes: this.config.maxTotalMediaBytes,
          maxConversationBytes: this.config.maxConversationBytes,
          maxPrincipalBytes: this.config.maxPrincipalBytes,
          maxWorkspaceBytes: this.config.maxWorkspaceBytes,
          fetchTimeoutMs: 30_000,
          allowHttpMedia: this.config.allowHttpMedia,
          privateMediaHosts: this.config.privateMediaHosts,
        },
      },
    })
    this.unregisterTool = this.tools.register(createDeliveryTool({ registry: this.registry, artifactStore: this.artifactStore }))
    this.cleanupTimer = setInterval(() => {
      this.artifactStore.cleanup().catch(error => this.logger.warn?.(`slashx-gateway artifact cleanup failed: ${String(error)}`))
      this.ledger.cleanup().catch(error => this.logger.warn?.(`slashx-gateway run-ledger cleanup failed: ${String(error)}`))
    }, Math.min(this.config.assetTtlSeconds * 500, 3_600_000))
    this.cleanupTimer.unref?.()
  }

  queueConversation(conversationId, operation) {
    const previous = this.conversationTails.get(conversationId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.conversationTails.set(conversationId, current)
    current.finally(() => {
      if (this.conversationTails.get(conversationId) === current) this.conversationTails.delete(conversationId)
    }).catch(() => undefined)
    return current
  }

  async withCapacity(operation) {
    if (this.activeExecutions >= this.config.maxConcurrentRuns) {
      await new Promise(resolve => this.capacityWaiters.push(resolve))
    }
    this.activeExecutions += 1
    try {
      return await operation()
    } finally {
      this.activeExecutions -= 1
      this.capacityWaiters.shift()?.()
    }
  }

  execute(request) {
    const active = this.running.get(request.runId)
    const digest = requestDigest(request)
    if (active) {
      if (active.digest !== digest) throw new ProtocolError('RUN_ID_REUSED', 'runId was reused with a different request', 409)
      return active.task
    }
    if (this.running.size >= this.config.maxConcurrentRuns + this.config.maxQueuedRuns) {
      throw new ProtocolError('GATEWAY_BUSY', 'DeepSeek Harness 网关当前任务过多，请稍后重试。', 503)
    }
    const task = this.queueConversation(conversationKeyFor(request), () => this.withCapacity(async () => {
      const admission = await this.ledger.begin(request)
      if (admission.kind === 'replay') return admission.response
      if (admission.kind === 'uncertain') {
        return makeErrorResponse(request, 'RUN_OUTCOME_UNCERTAIN', '该 runId 之前已开始，但网关重启后无法确认远端结果；为避免重复执行，本次不会自动重试。', false)
      }
      let response
      try {
        response = await this.bridge.run(request)
      } catch (error) {
        response = error instanceof ProtocolError
          ? makeErrorResponse(request, error.code, error.message, error.status >= 500)
          : makeErrorResponse(request, 'GATEWAY_INTERNAL_ERROR', 'Harness 网关执行失败。', true)
      }
      await this.ledger.finish(request, response)
      return response
    }))
    this.running.set(request.runId, { digest, task })
    task.finally(() => {
      if (this.running.get(request.runId)?.task === task) this.running.delete(request.runId)
    }).catch(() => undefined)
    return task
  }

  async handleRun(req, res) {
    const request = assertRequestV1(await readJson(req, this.config.maxRequestBytes))
    const asyncGrant = request.extensions?.slashxAsync
    if (asyncGrant && request.client.capabilities.includes('async_callback') && request.event !== 'cancel') {
      const task = this.execute(request)
      task.then(async response => {
        const claim = await this.ledger.claimCallback(request)
        if (claim.kind !== 'claimed') return { delivered: false, suppressed: true, reason: claim.kind }
        const result = await callback(response, request, {
          fetchTimeoutMs: 15_000,
          maxMediaBytes: 64 * 1024,
          allowHttpMedia: this.config.allowHttpMedia,
          privateMediaHosts: this.config.privateMediaHosts,
        })
        await this.ledger.finishCallback(request, result)
        return result
      }).then(result => {
        if (!result.delivered && !result.suppressed) this.logger.warn?.(`slashx-gateway callback not delivered for run ${request.runId}: ${result.reason}`)
      }).catch(error => this.logger.warn?.(`slashx-gateway callback failed for run ${request.runId}: ${String(error)}`))
      json(res, 202, pendingResponse(request, this.config.publicBaseUrl), { 'Retry-After': '3' })
      return
    }
    json(res, 200, await this.execute(request))
  }

  async handleRunStatus(req, res, runId) {
    const entry = await this.ledger.read(runId)
    if (!entry) {
      json(res, 404, { error: { code: 'RUN_NOT_FOUND', message: 'run not found' } })
      return
    }
    if (req.method === 'DELETE') {
      const active = this.registry.get(runId)
      if (!active) {
        json(res, 409, { error: { code: 'RUN_NOT_ACTIVE', message: 'run is not active in this process' } })
        return
      }
      const response = await this.bridge.cancel(active.request)
      json(res, 200, response)
      return
    }
    if (entry.status === 'final') {
      json(res, 200, entry.response)
      return
    }
    json(res, 200, {
      schemaVersion: 'slashx.response.v1',
      runId: entry.runId,
      traceId: entry.traceId,
      runStatus: 'running',
      progress: 0.05,
      messages: [],
      extensions: { externalRunId: entry.runId },
    })
  }

  async handle(req, res) {
    const pathname = new URL(req.url || '/', 'http://gateway.invalid').pathname
    if (pathname === '/healthz' && req.method === 'GET') {
      json(res, 200, { status: 'ok', service: 'dsh-plugin-slashx-gateway', protocol: 'slashx.request.v1' })
      return
    }
    const assetMatch = /^\/slashx-provider\/v1\/assets\/([0-9a-f-]{36})(?:\/[^/]*)?$/.exec(pathname)
    if (assetMatch) {
      await this.artifactStore.handle(req, res, assetMatch[1])
      return
    }
    if (!authorized(req.headers.authorization, this.config.token)) {
      json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } }, { 'WWW-Authenticate': 'Bearer' })
      return
    }
    if (pathname === '/slashx-provider/v1/capabilities' && req.method === 'GET') {
      json(res, 200, gatewayCapabilities({ publicBaseUrlConfigured: Boolean(this.config.publicBaseUrl) }))
      return
    }
    if (pathname === '/slashx-provider/v1/run' && req.method === 'POST') {
      await this.handleRun(req, res)
      return
    }
    const runMatch = /^\/slashx-provider\/v1\/runs\/([0-9a-f-]{36})$/.exec(pathname)
    if (runMatch && ['GET', 'DELETE'].includes(req.method || '')) {
      await this.handleRunStatus(req, res, runMatch[1])
      return
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } })
  }

  async start() {
    if (!this.bridge) await this.initialize()
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (res.headersSent) {
          res.destroy()
          return
        }
        const status = error instanceof ProtocolError ? error.status : 500
        const code = error instanceof ProtocolError ? error.code : 'INTERNAL_ERROR'
        const message = error instanceof ProtocolError ? error.message : 'gateway internal error'
        json(res, status, { error: { code, message } })
      })
    })
    this.server.headersTimeout = 15_000
    this.server.requestTimeout = 60_000
    this.server.keepAliveTimeout = 5_000
    this.server.maxHeadersCount = 100
    await new Promise((resolve, reject) => {
      const onError = error => reject(error)
      this.server.once('error', onError)
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', onError)
        resolve()
      })
    })
    const address = this.server.address()
    this.port = typeof address === 'object' && address ? address.port : this.config.port
    return { host: this.config.host, port: this.port }
  }

  async stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    this.unregisterTool?.()
    if (!this.server) return
    await new Promise(resolve => {
      this.server.close(() => resolve())
      this.server.closeAllConnections?.()
    })
  }
}

export const serverInternals = { authorized, readJson, pendingResponse, callback }
