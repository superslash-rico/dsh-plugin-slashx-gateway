import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { materializeMediaPart, isBlockedAddress, requestSafeRemote, sniffMime, stageInputMedia } from '../lib/media.js'
import { ProtocolError } from '../lib/protocol.js'

test('blocks loopback, private, link-local, and mapped addresses', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.1.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1']) {
    assert.equal(isBlockedAddress(address), true, address)
  }
  assert.equal(isBlockedAddress('8.8.8.8'), false)
})

test('decodes canonical base64 and sniffs real MIME bytes', async () => {
  const png = Buffer.from('89504e470d0a1a0a00000000', 'hex')
  const media = await materializeMediaPart({ base64: png.toString('base64'), mimeType: 'application/octet-stream', fileName: 'x' }, 'images', 0, {
    maxMediaBytes: 1024,
    fetchTimeoutMs: 100,
    allowHttpMedia: false,
    privateMediaHosts: new Set(),
  })
  assert.equal(media.mimeType, 'image/png')
  assert.equal(sniffMime(png), 'image/png')
})

test('rejects private media URL before issuing fetch', async () => {
  await assert.rejects(
    materializeMediaPart({ url: 'http://127.0.0.1/private.png' }, 'images', 0, {
      maxMediaBytes: 1024,
      fetchTimeoutMs: 100,
      allowHttpMedia: true,
      privateMediaHosts: new Set(),
    }),
    error => error instanceof ProtocolError && error.code === 'MEDIA_SSRF_BLOCKED',
  )
})

test('pins the verified DNS address for the actual outbound socket', async t => {
  const server = createServer((_req, res) => res.end('pinned'))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  let resolutions = 0
  const response = await requestSafeRemote(`http://rebind.test:${port}/asset`, {
    maxMediaBytes: 1024,
    fetchTimeoutMs: 1000,
    allowHttpMedia: true,
    privateMediaHosts: new Set(['rebind.test']),
    async dnsLookup(host, options) {
      resolutions += 1
      assert.equal(host, 'rebind.test')
      assert.equal(options.all, true)
      return [{ address: '127.0.0.1', family: 4 }]
    },
  }, { maxResponseBytes: 1024 })
  assert.equal(response.buffer.toString(), 'pinned')
  assert.equal(resolutions, 1)
})

test('rejects a pre-planted symlink at the per-run inbox boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-media-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const principalRoot = join(root, 'principal')
  const conversationRoot = join(principalRoot, 'conversation')
  const outside = join(root, 'outside')
  const runId = '11111111-1111-4111-8111-111111111111'
  await mkdir(join(conversationRoot, 'inbox'), { recursive: true })
  await mkdir(outside)
  await symlink(outside, join(conversationRoot, 'inbox', runId))
  await assert.rejects(
    stageInputMedia({
      runId,
      input: { attachments: [{ base64: Buffer.from('secret').toString('base64'), fileName: 'x.txt' }] },
    }, conversationRoot, {
      workspaceRoot: root,
      principalRoot,
      maxMediaBytes: 1024,
      maxTotalMediaBytes: 1024,
      maxConversationBytes: 4096,
      maxPrincipalBytes: 4096,
      maxWorkspaceBytes: 4096,
      fetchTimeoutMs: 100,
      allowHttpMedia: false,
      privateMediaHosts: new Set(),
    }),
    error => error instanceof ProtocolError && error.code === 'MEDIA_PATH_CONFLICT',
  )
  await assert.rejects(access(join(outside, '01-2bb80d537b1d.txt')))
})
