import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ProtocolError } from './protocol.js'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const output = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      if (key === 'callbackToken') continue
      output[key] = stable(value[key])
    }
    return output
  }
  return value
}

export function requestDigest(request) {
  return createHash('sha256').update(JSON.stringify(stable(request))).digest('hex')
}

function principalKey(request) {
  return createHash('sha256').update(`${request.userId}\0${request.agent.id}`).digest('hex').slice(0, 24)
}

export class RunLedger {
  constructor(root, { maxEntries = 100_000, maxEntriesPerPrincipal = 10_000, retentionMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    this.root = root
    this.maxEntries = maxEntries
    this.maxEntriesPerPrincipal = maxEntriesPerPrincipal
    this.retentionMs = retentionMs
    this.mutationLock = Promise.resolve()
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const names = (await readdir(this.root)).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
    this.entryCount = names.length
    this.principalCounts = new Map()
    for (const name of names) {
      try {
        const entry = JSON.parse(await readFile(join(this.root, name), 'utf8'))
        if (entry?.principalKey) this.principalCounts.set(entry.principalKey, (this.principalCounts.get(entry.principalKey) ?? 0) + 1)
      } catch { /* corrupt entries remain counted globally and are handled operationally */ }
    }
  }

  async withMutationLock(operation) {
    const previous = this.mutationLock
    let release
    this.mutationLock = new Promise(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  path(runId) {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new ProtocolError('INVALID_RUN_ID', 'runId is invalid')
    return join(this.root, `${runId}.json`)
  }

  async read(runId) {
    try {
      const value = JSON.parse(await readFile(this.path(runId), 'utf8'))
      return value?.version === 1 && value.runId === runId ? value : undefined
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(entry) {
    const target = this.path(entry.runId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(entry), { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  }

  async begin(request) {
    return this.withMutationLock(async () => {
      const digest = requestDigest(request)
      const existing = await this.read(request.runId)
      if (existing) {
        if (existing.requestDigest !== digest) throw new ProtocolError('RUN_ID_REUSED', 'runId was reused with a different request', 409)
        if (existing.status === 'final' && existing.response) return { kind: 'replay', response: existing.response }
        return { kind: 'uncertain', entry: existing }
      }
      if (this.entryCount >= this.maxEntries) {
        throw new ProtocolError('RUN_LEDGER_QUOTA', 'run ledger quota is exhausted', 507)
      }
      const owner = principalKey(request)
      if ((this.principalCounts.get(owner) ?? 0) >= this.maxEntriesPerPrincipal) {
        throw new ProtocolError('RUN_LEDGER_PRINCIPAL_QUOTA', 'user and agent run-ledger quota is exhausted', 429)
      }
      await this.write({
        version: 1,
        runId: request.runId,
        traceId: request.traceId,
        conversationId: request.conversationId,
        principalKey: owner,
        requestDigest: digest,
        status: 'running',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      })
      this.entryCount += 1
      this.principalCounts.set(owner, (this.principalCounts.get(owner) ?? 0) + 1)
      return { kind: 'started' }
    })
  }

  async finish(request, response) {
    await this.withMutationLock(async () => {
      await this.write({
        version: 1,
        runId: request.runId,
        traceId: request.traceId,
        conversationId: request.conversationId,
        principalKey: principalKey(request),
        requestDigest: requestDigest(request),
        status: 'final',
        startedAt: (await this.read(request.runId))?.startedAt ?? Date.now(),
        updatedAt: Date.now(),
        response,
      })
    })
  }

  callbackKey(request) {
    const grant = request.extensions?.slashxAsync
    if (!grant) return undefined
    return createHash('sha256').update(JSON.stringify({
      callbackUrl: grant.callbackUrl,
      callbackRunId: grant.callbackRunId,
      idempotencyKey: grant.idempotencyKey,
    })).digest('hex')
  }

  async claimCallback(request) {
    return this.withMutationLock(async () => {
      const key = this.callbackKey(request)
      const entry = await this.read(request.runId)
      if (!key || !entry || entry.status !== 'final') return { kind: 'unavailable' }
      if (entry.requestDigest !== requestDigest(request)) throw new ProtocolError('RUN_ID_REUSED', 'runId was reused with a different request', 409)
      if (entry.callback?.key === key) return { kind: 'already_claimed', status: entry.callback.status }
      entry.callback = { key, status: 'sending', updatedAt: Date.now() }
      entry.updatedAt = Date.now()
      await this.write(entry)
      return { kind: 'claimed' }
    })
  }

  async finishCallback(request, result) {
    return this.withMutationLock(async () => {
      const key = this.callbackKey(request)
      const entry = await this.read(request.runId)
      if (!key || !entry || entry.callback?.key !== key) return
      entry.callback = {
        key,
        status: result.delivered ? 'delivered' : 'failed',
        updatedAt: Date.now(),
        ...(result.delivered ? {} : { reason: String(result.reason || 'callback failed').slice(0, 256) }),
      }
      entry.updatedAt = Date.now()
      await this.write(entry)
    })
  }

  async cleanup(now = Date.now()) {
    return this.withMutationLock(async () => {
      const names = await readdir(this.root)
      let removed = 0
      for (const name of names) {
        if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue
        const runId = name.slice(0, -5)
        const entry = await this.read(runId)
        if (!entry || entry.status !== 'final' || Number(entry.updatedAt) + this.retentionMs >= now) continue
        try {
          await unlink(this.path(runId))
          this.entryCount = Math.max(0, this.entryCount - 1)
          if (entry.principalKey) {
            const count = Math.max(0, (this.principalCounts.get(entry.principalKey) ?? 0) - 1)
            if (count === 0) this.principalCounts.delete(entry.principalKey)
            else this.principalCounts.set(entry.principalKey, count)
          }
          removed += 1
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      return removed
    })
  }
}

export const ledgerInternals = { stable, principalKey }
