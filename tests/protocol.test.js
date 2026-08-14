import assert from 'node:assert/strict'
import test from 'node:test'
import { assertDeliveryDraft, assertRequestV1, gatewayCapabilities, makeResponse, ProtocolError } from '../lib/protocol.js'

function request(overrides = {}) {
  return {
    schemaVersion: 'slashx.request.v1',
    event: 'action_click',
    runId: '11111111-1111-4111-8111-111111111111',
    traceId: '22222222-2222-4222-8222-222222222222',
    conversationId: '33333333-3333-4333-8333-333333333333',
    userId: 'user-1',
    agent: { id: 'agent-1', name: 'Agent', config: { systemPrompt: 'Be useful', temperature: 0.2, tags: ['support'] } },
    client: {
      platform: 'pc-web',
      capabilities: ['image', 'video', 'audio', 'card', 'action', 'stream', 'markdown', 'async_callback'],
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      viewport: { width: 1280, height: 800 },
    },
    input: {
      text: 'hello',
      images: [{ base64: 'aGVsbG8=', mimeType: 'image/png', fileName: 'a.png' }],
      audio: [{ url: 'https://media.example/a.mp3', mimeType: 'audio/mpeg' }],
      videos: [{ url: 'https://media.example/v.mp4', mimeType: 'video/mp4' }],
      attachments: [{ url: 'https://media.example/a.pdf', mimeType: 'application/pdf', attachmentType: 'document' }],
      quotes: [{ kind: 'quote', text: 'prior', quotedRole: 'assistant' }],
      actionClick: { kind: 'send_message', value: 'continue', label: '继续' },
    },
    history: [{ role: 'assistant', content: { text: 'prior answer' } }],
    historyTruncated: false,
    extensions: {
      slashxAsync: {
        callbackUrl: 'https://slashx.example/api/providers/callback/1',
        callbackRunId: '11111111-1111-4111-8111-111111111111',
        callbackToken: 'x'.repeat(32),
        callbackExpiresAt: Date.now() + 60_000,
        idempotencyKey: 'run-1',
      },
    },
    ...overrides,
  }
}

test('accepts the complete slashx.request.v1 input surface', () => {
  const parsed = assertRequestV1(request())
  assert.equal(parsed.input.videos[0].mimeType, 'video/mp4')
  assert.equal(parsed.input.attachments[0].attachmentType, 'document')
  assert.equal(parsed.input.actionClick.label, '继续')
})

test('rejects media items without URL or base64', () => {
  const value = request()
  value.input.images = [{}]
  assert.throws(() => assertRequestV1(value), error => error instanceof ProtocolError && error.code === 'INVALID_REQUEST')
})

test('rejects deeply nested extension data before idempotency hashing', () => {
  const value = request()
  let nested = {}
  value.extensions.untrusted = nested
  for (let index = 0; index < 32; index += 1) {
    nested.next = {}
    nested = nested.next
  }
  assert.throws(
    () => assertRequestV1(value),
    error => error instanceof ProtocolError && /nesting depth/.test(error.message),
  )
})

test('validates every rich response delivery family', () => {
  const draft = assertDeliveryDraft({
    runId: '11111111-1111-4111-8111-111111111111',
    text: '# Markdown',
    images: [{ localPath: 'out/a.png', mimeType: 'image/png' }],
    videos: [{ url: 'https://cdn.example/a.mp4', mimeType: 'video/mp4' }],
    audio: [{ url: 'https://cdn.example/a.mp3' }],
    attachments: [{ localPath: 'out/report.pdf', attachmentType: 'document' }],
    citations: [{ index: 1, title: 'Source', url: 'https://example.com/source' }],
    cards: [{ type: 'summary', title: 'Result', fields: [{ label: 'status', value: 'ok' }], actions: [{ label: 'Open', kind: 'open_url', value: 'https://example.com' }] }],
    actions: [{ label: 'Continue', kind: 'send_message', value: 'continue' }],
    conversationUpdate: { title: 'New title', modeTag: 'done' },
  })
  assert.equal(draft.cards[0].actions[0].kind, 'open_url')
})

test('capabilities distinguish transport compatibility from Harness semantics', () => {
  const withoutPublisher = gatewayCapabilities({ publicBaseUrlConfigured: false })
  assert.equal(withoutPublisher.request.videos.transport, true)
  assert.equal(withoutPublisher.request.videos.semantic, 'workspace_file')
  assert.equal(withoutPublisher.response.videos.semantic, 'remote_url_only')
  const withPublisher = gatewayCapabilities({ publicBaseUrlConfigured: true })
  assert.equal(withPublisher.response.attachments.semantic, 'delivery_tool_and_asset_publisher')
  assert.deepEqual(withPublisher.billing.modes, ['flat_per_run', 'pass_through'])
  assert.equal(withPublisher.billing.tokenUsage.retriesIncluded, true)
  assert.equal(withPublisher.billing.tokenUsage.incompleteBehavior, 'omit_settlement_usage')
})

test('no-op events can acknowledge without creating an empty chat bubble', () => {
  const response = makeResponse({ request: request(), emitMessage: false })
  assert.equal(response.runStatus, 'success')
  assert.deepEqual(response.messages, [])
})
