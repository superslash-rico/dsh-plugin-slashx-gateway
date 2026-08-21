import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { mkdir, open, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ProtocolError } from './protocol.js'
import { sniffMime } from './media.js'

function safeFileName(value, fallback = 'artifact.bin') {
  const raw = basename(typeof value === 'string' && value.trim() ? value.trim() : fallback)
  const clean = Array.from(raw.normalize('NFKC'), character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f || '/\\:"'.includes(character)
      ? '_'
      : character
  }).join('').slice(0, 180)
  return clean && clean !== '.' && clean !== '..' ? clean : fallback
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function constantTimeTextEqual(left, right) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

const INLINE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/ogg',
  'video/mp4', 'application/pdf',
])

function normalizeMimeType(value) {
  const candidate = String(value || 'application/octet-stream').trim().toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate)
    ? candidate
    : 'application/octet-stream'
}

function disposition(mimeType) {
  return INLINE_MIME_TYPES.has(mimeType) ? 'inline' : 'attachment'
}

function parseRange(value, size) {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!match) return null
  if (!match[1] && !match[2]) return null
  let start
  let end
  if (!match[1]) {
    const suffix = Number(match[2])
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Number(match[2]) : size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null
  return { start, end: Math.min(end, size - 1) }
}

async function openVerifiedSource(candidate, root) {
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const handleStat = await handle.stat()
    if (!handleStat.isFile()) throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'localPath must resolve to a regular file')
    const currentStat = await stat(candidate)
    if (currentStat.dev !== handleStat.dev || currentStat.ino !== handleStat.ino) {
      throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'localPath changed while it was being opened')
    }
    let descriptorPath
    for (const prefix of ['/proc/self/fd', '/dev/fd']) {
      try {
        const alias = join(prefix, String(handle.fd))
        const resolved = await realpath(alias)
        if (resolved !== alias && !resolved.startsWith(`${prefix}${sep}`)) {
          descriptorPath = resolved
          break
        }
      } catch { /* platform does not expose this descriptor alias */ }
    }
    if (descriptorPath && !isInside(root, descriptorPath)) {
      throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'the opened file cannot be proven to remain inside the conversation workspace')
    }
    return { handle, stat: handleStat, descriptorPath }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function revalidateOpenSource(source, candidate, root) {
  const currentPath = await realpath(candidate)
  if (!isInside(root, currentPath)) throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'localPath left the conversation workspace')
  const currentStat = await stat(currentPath)
  if (currentStat.dev !== source.stat.dev || currentStat.ino !== source.stat.ino) {
    throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'localPath changed while it was being copied')
  }
}

async function copyOpenFile(source, destination, bytes) {
  const target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, bytes)))
  let position = 0
  try {
    while (position < bytes) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, bytes - position), position)
      if (bytesRead === 0) throw new ProtocolError('ARTIFACT_CHANGED', 'local artifact changed while it was being published', 409)
      let written = 0
      while (written < bytesRead) {
        const result = await target.write(buffer, written, bytesRead - written, position + written)
        written += result.bytesWritten
      }
      position += bytesRead
    }
  } finally {
    await target.close()
  }
}

export class ArtifactStore {
  constructor({
    root,
    publicBaseUrl,
    secret,
    ttlSeconds,
    maxBytes,
    maxTotalBytes = 2 * 1024 * 1024 * 1024,
    maxArtifacts = 10_000,
    maxBytesPerRun = 100 * 1024 * 1024,
    maxArtifactsPerRun = 20,
  }) {
    this.root = root
    this.publicBaseUrl = publicBaseUrl ? new URL(publicBaseUrl).toString().replace(/\/$/, '') : undefined
    this.secret = secret
    this.ttlSeconds = ttlSeconds
    this.maxBytes = maxBytes
    this.maxTotalBytes = maxTotalBytes
    this.maxArtifacts = maxArtifacts
    this.maxBytesPerRun = maxBytesPerRun
    this.maxArtifactsPerRun = maxArtifactsPerRun
    this.storageLock = Promise.resolve()
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.realRoot = await realpath(this.root)
    const names = await readdir(this.realRoot)
    const dataNames = names.filter(name => /^[0-9a-f-]{36}\.data$/i.test(name))
    this.storedBytes = 0
    this.runUsage = new Map()
    for (const name of dataNames) {
      try {
        const bytes = (await stat(join(this.realRoot, name))).size
        this.storedBytes += bytes
        const id = name.slice(0, -5)
        const metadata = await this.readMetadata(id)
        if (metadata?.runId) {
          const usage = this.runUsage.get(metadata.runId) ?? { bytes: 0, count: 0 }
          usage.bytes += bytes
          usage.count += 1
          this.runUsage.set(metadata.runId, usage)
        }
      } catch { /* concurrently removed */ }
    }
    this.artifactCount = dataNames.length
  }

  async withStorageLock(operation) {
    const previous = this.storageLock
    let release
    this.storageLock = new Promise(resolve => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  async reserveStorage(bytes, runId) {
    return this.withStorageLock(() => {
      if (this.storedBytes + bytes > this.maxTotalBytes || this.artifactCount + 1 > this.maxArtifacts) {
        throw new ProtocolError('ARTIFACT_STORAGE_QUOTA', 'artifact store quota is exhausted', 507)
      }
      const usage = this.runUsage.get(runId) ?? { bytes: 0, count: 0 }
      if (usage.bytes + bytes > this.maxBytesPerRun || usage.count + 1 > this.maxArtifactsPerRun) {
        throw new ProtocolError('ARTIFACT_RUN_QUOTA', 'this run exceeds its artifact publication quota', 413)
      }
      this.storedBytes += bytes
      this.artifactCount += 1
      this.runUsage.set(runId, { bytes: usage.bytes + bytes, count: usage.count + 1 })
    })
  }

  async releaseStorage(bytes, runId) {
    return this.withStorageLock(() => {
      this.storedBytes = Math.max(0, this.storedBytes - bytes)
      this.artifactCount = Math.max(0, this.artifactCount - 1)
      const usage = this.runUsage.get(runId)
      if (usage) {
        const next = { bytes: Math.max(0, usage.bytes - bytes), count: Math.max(0, usage.count - 1) }
        if (next.bytes === 0 && next.count === 0) this.runUsage.delete(runId)
        else this.runUsage.set(runId, next)
      }
    })
  }

  signature(id, expiresAt) {
    return createHmac('sha256', this.secret).update(`${id}.${expiresAt}`).digest('base64url')
  }

  publicUrl(id, fileName, expiresAt) {
    if (!this.publicBaseUrl) throw new ProtocolError('ASSET_PUBLISHER_DISABLED', 'local artifact publishing requires SLASHX_GATEWAY_PUBLIC_BASE_URL')
    const url = new URL(`${this.publicBaseUrl}/slashx-provider/v1/assets/${id}/${encodeURIComponent(fileName)}`)
    url.searchParams.set('exp', String(expiresAt))
    url.searchParams.set('sig', this.signature(id, expiresAt))
    return url.toString()
  }

  async publishLocal({ localPath, allowedRoot, mimeType, fileName, runId }) {
    if (!this.publicBaseUrl) throw new ProtocolError('ASSET_PUBLISHER_DISABLED', 'local artifact publishing is not configured')
    const root = await realpath(allowedRoot)
    const candidate = await realpath(isAbsolute(localPath) ? localPath : resolve(root, localPath))
    if (!isInside(root, candidate)) throw new ProtocolError('ARTIFACT_PATH_REJECTED', 'localPath is outside the active SlashX conversation workspace')
    const id = randomUUID()
    const dataPath = join(this.realRoot, `${id}.data`)
    const metaPath = join(this.realRoot, `${id}.json`)
    let source
    let reserved = false
    try {
      source = await openVerifiedSource(candidate, root)
      if (source.stat.size <= 0 || source.stat.size > this.maxBytes) {
        throw new ProtocolError('ARTIFACT_TOO_LARGE', `artifact must be between 1 and ${this.maxBytes} bytes`, 413)
      }
      await this.reserveStorage(source.stat.size, runId)
      reserved = true
      await copyOpenFile(source.handle, dataPath, source.stat.size)
      await revalidateOpenSource(source, candidate, root)
      const head = Buffer.alloc(Math.min(source.stat.size, 32))
      await source.handle.read(head, 0, head.length, 0)
      const resolvedMime = normalizeMimeType(sniffMime(head, normalizeMimeType(mimeType)))
      const resolvedName = safeFileName(fileName, basename(candidate))
      const expiresAt = Math.floor(Date.now() / 1000) + this.ttlSeconds
      const metadata = {
        version: 1,
        id,
        runId,
        fileName: resolvedName,
        mimeType: resolvedMime,
        bytes: source.stat.size,
        expiresAt,
      }
      await writeFile(metaPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
      reserved = false
      return { url: this.publicUrl(id, resolvedName, expiresAt), mimeType: resolvedMime, fileName: resolvedName }
    } catch (error) {
      await unlink(dataPath).catch(() => undefined)
      await unlink(metaPath).catch(() => undefined)
      if (reserved) await this.releaseStorage(source?.stat.size ?? 0, runId)
      throw error
    } finally {
      await source?.handle.close().catch(() => undefined)
    }
  }

  async publishImageAttachment({ apiProxy, sessionId, attachment, runId }) {
    const rpcId = `slashx-attachment-${randomUUID()}`
    const result = await apiProxy.sessions.attachment({
      rpcId,
      payload: { sessionId, attachmentId: attachment.attachmentId },
    })
    if (!result.result.ok) throw new ProtocolError('HARNESS_ATTACHMENT_READ_FAILED', result.result.error.message, 502)
    const encoded = result.result.value.data
    if (typeof encoded !== 'string' || encoded.length > Math.ceil(this.maxBytes / 3) * 4 + 4) {
      throw new ProtocolError('ARTIFACT_TOO_LARGE', `Harness attachment exceeds ${this.maxBytes} bytes`, 413)
    }
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.length === 0 || decoded.length > this.maxBytes) {
      throw new ProtocolError('ARTIFACT_TOO_LARGE', `Harness attachment must be between 1 and ${this.maxBytes} bytes`, 413)
    }
    const temporaryRoot = join(this.realRoot, '.tmp')
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 })
    const temporaryPath = join(temporaryRoot, randomUUID())
    await writeFile(temporaryPath, decoded, { flag: 'wx', mode: 0o600 })
    try {
      return await this.publishLocal({
        localPath: temporaryPath,
        allowedRoot: temporaryRoot,
        mimeType: result.result.value.attachment.mediaType,
        fileName: result.result.value.attachment.name || 'harness-image',
        runId,
      })
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  async readMetadata(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined
    try {
      const parsed = JSON.parse(await readFile(join(this.realRoot, `${id}.json`), 'utf8'))
      if (parsed?.version !== 1 || parsed.id !== id) return undefined
      return parsed
    } catch {
      return undefined
    }
  }

  async handle(req, res, id) {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, { Allow: 'GET, HEAD' })
      res.end()
      return
    }
    const url = new URL(req.url || '/', 'http://gateway.invalid')
    const expiresAt = Number(url.searchParams.get('exp'))
    const signature = url.searchParams.get('sig') || ''
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(Date.now() / 1000) || !constantTimeTextEqual(signature, this.signature(id, expiresAt))) {
      res.writeHead(403, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const metadata = await this.readMetadata(id)
    if (!metadata) {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    if (metadata.expiresAt < Math.floor(Date.now() / 1000) || expiresAt > metadata.expiresAt) {
      res.writeHead(410, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const path = join(this.realRoot, `${id}.data`)
    let fileStat
    try { fileStat = await stat(path) } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' })
      res.end()
      return
    }
    const range = parseRange(req.headers.range, fileStat.size)
    if (range === null) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileStat.size}`, 'Cache-Control': 'private, max-age=60' })
      res.end()
      return
    }
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=60',
      'Content-Type': metadata.mimeType,
      'Content-Disposition': `${disposition(metadata.mimeType)}; filename*=UTF-8''${encodeURIComponent(metadata.fileName)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Content-Type-Options': 'nosniff',
    }
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${fileStat.size}`
      headers['Content-Length'] = String(range.end - range.start + 1)
      res.writeHead(206, headers)
    } else {
      headers['Content-Length'] = String(fileStat.size)
      res.writeHead(200, headers)
    }
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(path, range || undefined)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }

  async cleanup(nowSeconds = Math.floor(Date.now() / 1000)) {
    const names = await readdir(this.realRoot)
    let removed = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -5)
      const metadata = await this.readMetadata(id)
      if (!metadata || metadata.expiresAt >= nowSeconds) continue
      const results = await Promise.allSettled([
        unlink(join(this.realRoot, `${id}.json`)),
        unlink(join(this.realRoot, `${id}.data`)),
      ])
      if (results[1].status === 'fulfilled') await this.releaseStorage(Number(metadata.bytes) || 0, metadata.runId)
      removed += 1
    }
    return removed
  }
}

export const artifactInternals = {
  isInside,
  parseRange,
  safeFileName,
  constantTimeTextEqual,
  normalizeMimeType,
  disposition,
  openVerifiedSource,
  revalidateOpenSource,
}
