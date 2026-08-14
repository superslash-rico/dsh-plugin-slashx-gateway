import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RunLedger } from '../lib/run-ledger.js'

const request = {
  runId: '11111111-1111-4111-8111-111111111111',
  traceId: '22222222-2222-4222-8222-222222222222',
  conversationId: '33333333-3333-4333-8333-333333333333',
  userId: 'user-1',
  agent: { id: 'agent-1' },
  extensions: {
    slashxAsync: {
      callbackUrl: 'https://slashx.example/callback',
      callbackRunId: '44444444-4444-4444-8444-444444444444',
      callbackToken: 'do-not-persist',
      idempotencyKey: 'run-1',
    },
  },
}

test('persists idempotent final responses without persisting callback tokens', async t => {
  const root = await mkdtemp(join(tmpdir(), 'slashx-ledger-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ledger = new RunLedger(root)
  await ledger.initialize()
  assert.deepEqual(await ledger.begin(request), { kind: 'started' })
  const running = await ledger.read(request.runId)
  assert.equal(JSON.stringify(running).includes('do-not-persist'), false)
  const response = { schemaVersion: 'slashx.response.v1', runStatus: 'success', messages: [] }
  await ledger.finish(request, response)
  const replay = await ledger.begin(request)
  assert.equal(replay.kind, 'replay')
  assert.deepEqual(replay.response, response)
  const claims = await Promise.all([ledger.claimCallback(request), ledger.claimCallback(request)])
  assert.deepEqual(claims.map(value => value.kind).sort(), ['already_claimed', 'claimed'])
  await ledger.finishCallback(request, { delivered: true })
  assert.deepEqual(await ledger.claimCallback(request), { kind: 'already_claimed', status: 'delivered' })
  assert.equal(JSON.stringify(await ledger.read(request.runId)).includes('do-not-persist'), false)
})
