import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore, artifactInternals } from '../lib/artifact-store.js'

test('normalizes unsafe MIME values and never renders active formats inline', () => {
  assert.equal(artifactInternals.normalizeMimeType('text/html\r\nX-Evil: yes'), 'application/octet-stream')
  assert.equal(artifactInternals.disposition('image/svg+xml'), 'attachment')
  assert.equal(artifactInternals.disposition('image/png'), 'inline')
})

test('serves signed artifacts with sandbox headers, HEAD, and byte ranges', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-artifact-http-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'clip.mp4'), Buffer.concat([
    Buffer.from('000000186674797069736f6d', 'hex'),
    Buffer.from('0123456789'),
  ]))
  const store = new ArtifactStore({
    root: join(root, 'artifacts'),
    publicBaseUrl: 'http://127.0.0.1',
    secret: 'artifact-secret',
    ttlSeconds: 3600,
    maxBytes: 1024,
  })
  await store.initialize()
  const server = createServer((req, res) => {
    const match = /^\/assets\/([0-9a-f-]{36})/.exec(new URL(req.url, 'http://local').pathname)
    store.handle(req, res, match?.[1] ?? '').catch(() => res.destroy())
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  const port = server.address().port
  store.publicBaseUrl = `http://127.0.0.1:${port}`
  const published = await store.publishLocal({
    localPath: 'clip.mp4',
    allowedRoot: workspace,
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
    runId: '11111111-1111-4111-8111-111111111111',
  })
  const assetUrl = published.url.replace('/slashx-provider/v1/assets/', '/assets/')
  const head = await fetch(assetUrl, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.match(head.headers.get('content-disposition'), /^inline;/)
  const partial = await fetch(assetUrl, { headers: { Range: 'bytes=4-7' } })
  assert.equal(partial.status, 206)
  assert.equal((await partial.arrayBuffer()).byteLength, 4)
  const unsigned = await fetch(new URL(assetUrl).origin + new URL(assetUrl).pathname)
  assert.equal(unsigned.status, 403)
})

test('enforces aggregate artifact byte and count quotas', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-artifact-quota-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'a.txt'), '12345')
  await writeFile(join(workspace, 'b.txt'), '67890')
  const store = new ArtifactStore({
    root: join(root, 'artifacts'),
    publicBaseUrl: 'https://gateway.example',
    secret: 'artifact-secret',
    ttlSeconds: 3600,
    maxBytes: 1024,
    maxTotalBytes: 9,
    maxArtifacts: 2,
  })
  await store.initialize()
  await store.publishLocal({ localPath: 'a.txt', allowedRoot: workspace, runId: 'run-1' })
  await assert.rejects(
    store.publishLocal({ localPath: 'b.txt', allowedRoot: workspace, runId: 'run-2' }),
    error => error.code === 'ARTIFACT_STORAGE_QUOTA' && error.status === 507,
  )
})
