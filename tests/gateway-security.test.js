import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewayServer, serverInternals } from '../lib/gateway-server.js'
import { HarnessBridge, harnessInternals } from '../lib/harness-bridge.js'
import { makeResponse } from '../lib/protocol.js'

function request(runId, conversationId) {
  return {
    schemaVersion: 'slashx.request.v1',
    event: 'user_message',
    runId,
    traceId: '22222222-2222-4222-8222-222222222222',
    conversationId,
    userId: 'user-1',
    agent: { id: 'agent-1', name: 'Agent' },
    client: { platform: 'pc-web', capabilities: ['markdown'], locale: 'zh-CN' },
    input: { text: 'hello' },
    history: [],
    extensions: {},
  }
}

test('async callback uses the one-time token over a DNS-pinned connection', async t => {
  let received
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    received = {
      token: req.headers['x-slashx-callback-token'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    }
    res.writeHead(204)
    res.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const value = request(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  )
  value.client.capabilities.push('async_callback')
  value.extensions.slashxAsync = {
    callbackUrl: `http://callback.test:${server.address().port}/complete`,
    callbackRunId: '44444444-4444-4444-8444-444444444444',
    callbackToken: 'c'.repeat(32),
    callbackExpiresAt: Date.now() + 60_000,
  }
  const result = await serverInternals.callback(makeResponse({ request: value, content: { text: 'done' } }), value, {
    fetchTimeoutMs: 1000,
    maxMediaBytes: 64 * 1024,
    allowHttpMedia: true,
    privateMediaHosts: new Set(['callback.test']),
    dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }],
  })
  assert.deepEqual(result, { delivered: true })
  assert.equal(received.token, 'c'.repeat(32))
  assert.equal(received.body.runId, value.extensions.slashxAsync.callbackRunId)
})

test('global admission limit returns a retryable protocol error without starting another turn', async t => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'slashx-gateway-capacity-'))
  t.after(() => rm(stateRoot, { recursive: true, force: true }))
  const gateway = new GatewayServer({
    apiProxy: {},
    tools: {},
    config: {
      token: 't'.repeat(32),
      stateRoot,
      maxConcurrentRuns: 1,
      maxQueuedRuns: 0,
    },
  })
  await gateway.ledger.initialize()
  let release
  let startedResolve
  const started = new Promise(resolve => { startedResolve = resolve })
  gateway.bridge = {
    async run(value) {
      startedResolve()
      await new Promise(resolve => { release = resolve })
      return makeResponse({ request: value, content: { text: 'done' } })
    },
  }
  const firstRequest = request(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  )
  const first = gateway.execute(firstRequest)
  await started
  assert.throws(
    () => gateway.execute({ ...firstRequest, input: { text: 'conflicting payload' } }),
    error => error.code === 'RUN_ID_REUSED' && error.status === 409,
  )
  assert.throws(
    () => gateway.execute(request(
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
    )),
    error => error.code === 'GATEWAY_BUSY' && error.status === 503,
  )
  release()
  assert.equal((await first).runStatus, 'success')
})

test('conversation sessions are bound to user and agent identity', () => {
  const base = request(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  )
  assert.notEqual(
    harnessInternals.sessionIdFor(base),
    harnessInternals.sessionIdFor({ ...base, userId: 'user-2' }),
  )
  assert.notEqual(
    harnessInternals.sessionIdFor(base),
    harnessInternals.sessionIdFor({ ...base, agent: { ...base.agent, id: 'agent-2' } }),
  )
})

test('idle and retract acknowledgements do not allocate conversation directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-gateway-noop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspaceRoot = join(root, 'conversations')
  const bridge = new HarnessBridge({
    apiProxy: {},
    registry: {},
    artifactStore: {},
    options: { workspaceRoot },
  })
  const value = request(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  )
  value.event = 'idle'
  assert.deepEqual((await bridge.run(value)).messages, [])
  await assert.rejects(access(workspaceRoot))
})
