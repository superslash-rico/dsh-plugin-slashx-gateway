import { lookup } from 'node:dns/promises'
import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { ProtocolError } from './protocol.js'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function canonicalBase64(value, path) {
  const dataUrl = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  const raw = dataUrl ? dataUrl[2] : value
  const compact = raw.replace(/[\r\n\t ]/g, '')
  const buffer = Buffer.from(compact, 'base64')
  if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/, '') !== compact.replace(/=+$/, '')) {
    throw new ProtocolError('INVALID_MEDIA_BASE64', `${path}.base64 is not valid base64`)
  }
  return { buffer, dataUrlMime: dataUrl?.[1]?.toLowerCase() }
}

function isBlockedIpv4(address) {
  const octets = address.split('.').map(Number)
  const [a, b] = octets
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113)
    || a >= 224
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true
  if (normalized.startsWith('ff')) return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)
  if (mapped) return isBlockedIpv4(mapped[1])
  // Internet-reachable IPv6 unicast currently lives in 2000::/3. Rejecting
  // non-global ranges also closes hexadecimal IPv4-mapped forms such as
  // ::ffff:7f00:1, translation prefixes, and other special-purpose space.
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16)
  if (!Number.isFinite(first) || first < 0x2000 || first > 0x3fff) return true
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return true
  if (normalized.startsWith('2001:0:') || normalized.startsWith('2002:')) return true
  return false
}

export function isBlockedAddress(address) {
  const family = isIP(address)
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

async function resolveSafeRemoteTarget(rawUrl, options) {
  let url
  try { url = new URL(rawUrl) } catch { throw new ProtocolError('INVALID_MEDIA_URL', 'media URL is invalid') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProtocolError('INVALID_MEDIA_URL', 'media URL must use HTTP(S)')
  if (url.username || url.password) throw new ProtocolError('INVALID_MEDIA_URL', 'media URL must not contain credentials')
  if (url.protocol === 'http:' && !options.allowHttpMedia) {
    throw new ProtocolError('INSECURE_MEDIA_URL', 'HTTP media is disabled; use HTTPS or explicitly enable it')
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  const privateHostAllowed = options.privateMediaHosts.has(host)
  if (!privateHostAllowed && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))) {
    throw new ProtocolError('MEDIA_SSRF_BLOCKED', 'media host resolves to a local name')
  }
  const literalFamily = isIP(host)
  if (!privateHostAllowed && literalFamily && isBlockedAddress(host)) {
    throw new ProtocolError('MEDIA_SSRF_BLOCKED', 'media host is not publicly routable')
  }
  let addresses
  try {
    const dnsLookup = options.dnsLookup ?? lookup
    addresses = literalFamily ? [{ address: host, family: literalFamily }] : await dnsLookup(host, { all: true, verbatim: true })
  } catch {
    throw new ProtocolError('MEDIA_FETCH_FAILED', 'media host could not be resolved', 502)
  }
  if (addresses.length === 0 || (!privateHostAllowed && addresses.some(({ address }) => isBlockedAddress(address)))) {
    throw new ProtocolError('MEDIA_SSRF_BLOCKED', 'media host resolves to a private, loopback, or reserved address')
  }
  return {
    url,
    addresses: addresses.map(({ address, family }) => ({ address, family: Number(family) || isIP(address) })),
  }
}

export async function assertSafeRemoteUrl(rawUrl, options) {
  return (await resolveSafeRemoteTarget(rawUrl, options)).url
}

async function readLimitedBody(response, maxBytes) {
  const length = Number(response.headers['content-length'])
  if (Number.isFinite(length) && length > maxBytes) {
    throw new ProtocolError('MEDIA_TOO_LARGE', `media exceeds ${maxBytes} bytes`, 413)
  }
  const chunks = []
  let total = 0
  for await (const chunk of response) {
    total += chunk.length
    if (total > maxBytes) {
      response.destroy()
      throw new ProtocolError('MEDIA_TOO_LARGE', `media exceeds ${maxBytes} bytes`, 413)
    }
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks, total)
}

export async function requestSafeRemote(rawUrl, options, requestOptions = {}) {
  const controller = new AbortController()
  let timeout
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error('remote request timed out')
      error.code = 'ETIMEDOUT'
      controller.abort(error)
      reject(error)
    }, options.fetchTimeoutMs)
  })
  const operation = (async () => {
    const target = await resolveSafeRemoteTarget(rawUrl, options)
    const pinned = target.addresses[0]
    const body = requestOptions.body === undefined ? undefined : Buffer.from(requestOptions.body)
    const response = await new Promise((resolve, reject) => {
      const transport = target.url.protocol === 'https:' ? httpsRequest : httpRequest
      const request = transport(target.url, {
        method: requestOptions.method ?? 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'dsh-plugin-slashx-gateway/0.1',
          ...requestOptions.headers,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
        },
        // Pin the already-vetted address so a second DNS answer cannot redirect the
        // actual socket to loopback or a private network (DNS rebinding / TOCTOU).
        lookup: (_hostname, lookupOptions, callback) => {
          if (lookupOptions?.all) callback(null, [pinned])
          else callback(null, pinned.address, pinned.family)
        },
      }, resolve)
      request.on('error', reject)
      request.end(body)
    })
    const buffer = await readLimitedBody(response, requestOptions.maxResponseBytes ?? options.maxMediaBytes)
    return {
      status: response.statusCode ?? 0,
      headers: response.headers,
      buffer,
      finalUrl: target.url.toString(),
    }
  })()
  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchRemote(rawUrl, options) {
  let current = rawUrl
  for (let redirect = 0; redirect <= 3; redirect += 1) {
    let response
    try {
      response = await requestSafeRemote(current, options, { maxResponseBytes: options.maxMediaBytes })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location
        if (!location || redirect === 3) throw new ProtocolError('MEDIA_REDIRECT_REJECTED', 'media URL has too many or invalid redirects', 502)
        current = new URL(location, response.finalUrl).toString()
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        throw new ProtocolError('MEDIA_FETCH_FAILED', `media origin returned HTTP ${response.status}`, 502)
      }
      return {
        buffer: response.buffer,
        contentType: String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() || undefined,
        finalUrl: response.finalUrl,
      }
    } catch (error) {
      if (error instanceof ProtocolError) throw error
      if (error?.code === 'ETIMEDOUT') throw new ProtocolError('MEDIA_FETCH_TIMEOUT', 'media download timed out', 504)
      throw new ProtocolError('MEDIA_FETCH_FAILED', `media download failed: ${error instanceof Error ? error.message : String(error)}`, 502)
    }
  }
  throw new ProtocolError('MEDIA_REDIRECT_REJECTED', 'media URL redirect loop', 502)
}

export function sniffMime(buffer, fallback = 'application/octet-stream') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf'
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4'
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg'
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'audio/mpeg'
  if (buffer.length >= 4 && buffer.subarray(0, 2).equals(Buffer.from('504b', 'hex'))) return 'application/zip'
  return fallback || 'application/octet-stream'
}

function normalizedMime(declared, downloaded, dataUrlMime, buffer) {
  const candidate = (declared || dataUrlMime || downloaded || 'application/octet-stream').toLowerCase()
  return sniffMime(buffer, candidate)
}

function safeFileName(value, fallback) {
  const raw = basename(typeof value === 'string' && value.trim() ? value.trim() : fallback)
  const clean = raw.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:]/g, '_').slice(0, 180)
  return clean && clean !== '.' && clean !== '..' ? clean : fallback
}

function extensionForMime(mimeType) {
  return {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
    'audio/ogg': '.ogg', 'text/plain': '.txt', 'application/json': '.json',
  }[mimeType] ?? ''
}

export async function materializeMediaPart(part, kind, index, options) {
  let buffer
  let downloadedMime
  let dataUrlMime
  let source
  if (typeof part.base64 === 'string' && part.base64.length > 0) {
    const decoded = canonicalBase64(part.base64, `${kind}[${index}]`)
    buffer = decoded.buffer
    dataUrlMime = decoded.dataUrlMime
    source = 'base64'
  } else {
    const fetched = await fetchRemote(part.url, options)
    buffer = fetched.buffer
    downloadedMime = fetched.contentType
    source = fetched.finalUrl
  }
  if (buffer.length > options.maxMediaBytes) throw new ProtocolError('MEDIA_TOO_LARGE', `${kind}[${index}] exceeds the per-file limit`, 413)
  const mimeType = normalizedMime(part.mimeType, downloadedMime, dataUrlMime, buffer)
  if (kind === 'images' && !IMAGE_TYPES.has(mimeType)) {
    throw new ProtocolError('IMAGE_TYPE_REJECTED', `${kind}[${index}] is not a supported PNG, JPEG, GIF, or WebP image`)
  }
  const fallback = `${kind.slice(0, -1) || 'file'}-${index + 1}${extensionForMime(mimeType)}`
  const fileName = safeFileName(part.fileName, fallback)
  return {
    buffer,
    mimeType,
    fileName,
    attachmentType: part.attachmentType,
    meta: part.meta,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    source,
  }
}

export async function stageInputMedia(request, conversationRoot, options) {
  const nativeImages = []
  const staged = []
  let totalBytes = 0
  const groups = [
    ['images', request.input.images ?? []],
    ['audio', request.input.audio ?? []],
    ['videos', request.input.videos ?? []],
    ['attachments', request.input.attachments ?? []],
  ]
  const inbox = join(conversationRoot, 'inbox', request.runId)
  const existingBytes = await directoryBytes(conversationRoot)
  const principalBytes = await directoryBytes(options.principalRoot)
  const workspaceBytes = await directoryBytes(options.workspaceRoot)
  let inboxCreated = false
  let realInbox
  try {
    for (const [kind, items] of groups) {
      for (let index = 0; index < items.length; index += 1) {
        const media = await materializeMediaPart(items[index], kind, index, options)
        totalBytes += media.buffer.length
        if (totalBytes > options.maxTotalMediaBytes) {
          throw new ProtocolError('MEDIA_TOTAL_TOO_LARGE', `request media exceeds ${options.maxTotalMediaBytes} bytes`, 413)
        }
        if (existingBytes + totalBytes > options.maxConversationBytes) {
          throw new ProtocolError('CONVERSATION_STORAGE_QUOTA', `conversation workspace exceeds ${options.maxConversationBytes} bytes`, 413)
        }
        if (principalBytes + totalBytes > options.maxPrincipalBytes) {
          throw new ProtocolError('PRINCIPAL_STORAGE_QUOTA', `user and agent workspace exceeds ${options.maxPrincipalBytes} bytes`, 413)
        }
        if (workspaceBytes + totalBytes > options.maxWorkspaceBytes) {
          throw new ProtocolError('WORKSPACE_STORAGE_QUOTA', `gateway conversation storage exceeds ${options.maxWorkspaceBytes} bytes`, 507)
        }
        if (kind === 'images') {
          nativeImages.push({
            type: 'image',
            mediaType: media.mimeType,
            data: media.buffer.toString('base64'),
            name: media.fileName,
          })
          continue
        }
        const stem = `${String(staged.length + 1).padStart(2, '0')}-${media.sha256.slice(0, 12)}`
        const extension = extname(media.fileName) || extensionForMime(media.mimeType)
        if (!inboxCreated) {
          realInbox = await createIsolatedInbox(conversationRoot, inbox)
          inboxCreated = true
        }
        const path = join(realInbox, `${stem}${extension}`)
        await writeFile(path, media.buffer, { flag: 'wx', mode: 0o600 })
        if (!isInside(realInbox, await realpath(path))) {
          throw new ProtocolError('MEDIA_PATH_REJECTED', 'staged input escaped its isolated inbox')
        }
        staged.push({
          kind,
          path,
          mimeType: media.mimeType,
          fileName: media.fileName,
          bytes: media.buffer.length,
          sha256: media.sha256,
          ...(media.attachmentType ? { attachmentType: media.attachmentType } : {}),
        })
      }
    }
  } catch (error) {
    if (inboxCreated) await rm(realInbox ?? inbox, { recursive: true, force: true })
    throw error
  }
  return { nativeImages, staged, totalBytes }
}

function isInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function createIsolatedInbox(conversationRoot, inbox) {
  const root = await realpath(conversationRoot)
  const parent = join(root, 'inbox')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const realParent = await realpath(parent)
  if (!isInside(root, realParent)) throw new ProtocolError('MEDIA_PATH_REJECTED', 'conversation inbox is outside its workspace')
  const target = join(realParent, basename(inbox))
  try {
    await mkdir(target, { recursive: false, mode: 0o700 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new ProtocolError('MEDIA_PATH_CONFLICT', 'run inbox already exists', 409)
    throw error
  }
  const isolated = await realpath(target)
  if (!isInside(realParent, isolated)) throw new ProtocolError('MEDIA_PATH_REJECTED', 'run inbox escaped its conversation workspace')
  return isolated
}

async function directoryBytes(root, maxEntries = 100_000) {
  const stack = [root]
  let entries = 0
  let bytes = 0
  while (stack.length) {
    const directory = stack.pop()
    let children
    try { children = await readdir(directory, { withFileTypes: true }) } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const child of children) {
      entries += 1
      if (entries > maxEntries) throw new ProtocolError('CONVERSATION_STORAGE_QUOTA', 'conversation workspace contains too many entries', 413)
      const path = join(directory, child.name)
      if (child.isDirectory()) stack.push(path)
      else if (child.isFile()) bytes += (await lstat(path)).size
      // Symbolic links and special files are not followed or counted.
    }
  }
  return bytes
}

export const mediaInternals = {
  canonicalBase64,
  assertSafeRemoteUrl,
  resolveSafeRemoteTarget,
  safeFileName,
  extensionForMime,
  directoryBytes,
  createIsolatedInbox,
}
