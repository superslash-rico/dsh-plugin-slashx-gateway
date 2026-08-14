import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactStore } from '../lib/artifact-store.js'
import { ActiveRunRegistry, createDeliveryTool, deliveryInternals } from '../lib/delivery.js'
import { ProtocolError } from '../lib/protocol.js'

test('degrades unsupported rich capabilities without dropping artifacts or actions', () => {
  const content = deliveryInternals.applyClientCapabilities({
    text: 'answer',
    videos: [{ url: 'https://cdn.example/v.mp4', mimeType: 'video/mp4', fileName: 'v.mp4' }],
    cards: [{ type: 'summary', title: 'Card', actions: [{ label: 'Open', kind: 'open_url', value: 'https://example.com' }] }],
    actions: [{ label: 'Copy', kind: 'copy', value: 'abc' }],
  }, new Set(['markdown']))
  assert.equal(content.videos, undefined)
  assert.equal(content.attachments[0].attachmentType, 'video')
  assert.match(content.text, /### Card/)
  assert.match(content.text, /\[Open\]/)
  assert.match(content.text, /Copy/)
})

test('slashx_deliver publishes only files inside the active conversation workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const conversationRoot = join(root, 'conversation')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(conversationRoot)
  await writeFile(join(conversationRoot, 'result.txt'), 'hello')
  await writeFile(join(root, 'secret.txt'), 'secret')
  const store = new ArtifactStore({
    root: artifactRoot,
    publicBaseUrl: 'https://gateway.example',
    secret: 'asset-secret',
    ttlSeconds: 3600,
    maxBytes: 1024,
  })
  await store.initialize()
  const registry = new ActiveRunRegistry()
  const runId = '11111111-1111-4111-8111-111111111111'
  registry.add({
    request: { runId },
    sessionId: 'session-1',
    conversationRoot,
    clientCapabilities: new Set(['markdown']),
  })
  const tool = createDeliveryTool({ registry, artifactStore: store })
  const accepted = await tool.execute({ runId, attachments: [{ localPath: 'result.txt', attachmentType: 'document' }] }, {
    signal: new AbortController().signal,
    agent: { session: { id: 'session-1' } },
  })
  assert.deepEqual(accepted, { accepted: true, publishedItems: 1 })
  assert.match(registry.get(runId).delivery.content.attachments[0].url, /^https:\/\/gateway\.example/)
  await assert.rejects(
    tool.execute({ runId, attachments: [{ localPath: join(root, 'secret.txt') }] }, {
      signal: new AbortController().signal,
      agent: { session: { id: 'session-1' } },
    }),
    error => error instanceof ProtocolError && error.code === 'ARTIFACT_PATH_REJECTED',
  )
})
