const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const REQUEST_EVENTS = new Set([
  'user_message',
  'action_click',
  'conversation_open',
  'cancel',
  'retract',
  'idle',
])

const CLIENT_CAPABILITIES = new Set([
  'image', 'video', 'audio', 'card', 'action', 'stream', 'markdown', 'async_callback',
])

const CLIENT_PLATFORMS = new Set(['h5', 'ios', 'android', 'miniprogram', 'pc-web', 'pc-app'])
const ACTION_KINDS = new Set(['send_message', 'open_url', 'copy', 'feedback', 'custom'])
const MESSAGE_ROLES = new Set(['assistant', 'thinking', 'tool', 'system', 'error'])
const MESSAGE_STATUSES = new Set(['pending', 'streaming', 'success', 'error', 'cancelled'])

export class ProtocolError extends Error {
  constructor(code, message, status = 422, details = undefined) {
    super(message)
    this.name = 'ProtocolError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolError('INVALID_REQUEST', `${path} must be an object`)
  }
  return value
}

function string(value, path, { allowEmpty = false, max = 100_000 } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new ProtocolError('INVALID_REQUEST', `${path} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${max} characters`)
  }
  return value
}

function uuid(value, path) {
  const result = string(value, path, { max: 64 })
  if (!UUID_RE.test(result)) throw new ProtocolError('INVALID_REQUEST', `${path} must be a UUID`)
  return result
}

function array(value, path, max) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) {
    throw new ProtocolError('INVALID_REQUEST', `${path} must be an array with at most ${max} items`)
  }
  return value
}

function optionalRecord(value, path) {
  return value === undefined ? undefined : record(value, path)
}

function validateMeta(value, path) {
  if (value !== undefined) {
    record(value, path)
    validateJsonTree(value, path)
  }
}

function validateJsonTree(value, path, { maxDepth = 16, maxNodes = 20_000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  let bytes = 0
  while (stack.length) {
    const current = stack.pop()
    nodes += 1
    if (nodes > maxNodes) throw new ProtocolError('INVALID_REQUEST', `${path} is too complex`)
    if (current.depth > maxDepth) throw new ProtocolError('INVALID_REQUEST', `${path} exceeds the maximum nesting depth`)
    const item = current.value
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item)
      if (bytes > maxBytes) throw new ProtocolError('INVALID_REQUEST', `${path} exceeds the aggregate data limit`)
      continue
    }
    if (item === null || typeof item === 'boolean') continue
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new ProtocolError('INVALID_REQUEST', `${path} contains a non-finite number`)
      continue
    }
    if (typeof item !== 'object') throw new ProtocolError('INVALID_REQUEST', `${path} contains a non-JSON value`)
    if (!Array.isArray(item)) {
      for (const key of Object.keys(item)) bytes += Buffer.byteLength(key)
      if (bytes > maxBytes) throw new ProtocolError('INVALID_REQUEST', `${path} exceeds the aggregate data limit`)
    }
    const values = Array.isArray(item) ? item : Object.values(item)
    for (const child of values) stack.push({ value: child, depth: current.depth + 1 })
  }
}

function validateMediaPart(value, path, attachment = false) {
  const item = record(value, path)
  const hasUrl = typeof item.url === 'string' && item.url.length > 0
  const hasBase64 = typeof item.base64 === 'string' && item.base64.length > 0
  if (!hasUrl && !hasBase64) {
    throw new ProtocolError('INVALID_REQUEST', `${path} must contain url or base64`)
  }
  if (hasUrl) {
    let parsed
    try { parsed = new URL(item.url) } catch { throw new ProtocolError('INVALID_REQUEST', `${path}.url must be an absolute URL`) }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ProtocolError('INVALID_REQUEST', `${path}.url must use HTTP(S)`)
    }
  }
  if (hasBase64) string(item.base64, `${path}.base64`, { max: 100_000_000 })
  if (item.mimeType !== undefined) string(item.mimeType, `${path}.mimeType`, { max: 255 })
  if (item.fileName !== undefined) string(item.fileName, `${path}.fileName`, { allowEmpty: true, max: 512 })
  if (attachment && item.attachmentType !== undefined) {
    string(item.attachmentType, `${path}.attachmentType`, { max: 128 })
  }
  validateMeta(item.meta, `${path}.meta`)
  return item
}

function validateInput(value) {
  const input = record(value, 'input')
  string(input.text ?? '', 'input.text', { allowEmpty: true, max: 1_000_000 })
  for (const [key, limit] of [['images', 20], ['audio', 20], ['videos', 20]]) {
    array(input[key], `input.${key}`, limit).forEach((item, index) => validateMediaPart(item, `input.${key}[${index}]`))
  }
  array(input.attachments, 'input.attachments', 50)
    .forEach((item, index) => validateMediaPart(item, `input.attachments[${index}]`, true))
  array(input.quotes, 'input.quotes', 20).forEach((value, index) => {
    const quote = record(value, `input.quotes[${index}]`)
    if (quote.kind !== 'quote') throw new ProtocolError('INVALID_REQUEST', `input.quotes[${index}].kind must be quote`)
    string(quote.text, `input.quotes[${index}].text`, { max: 100_000 })
    if (quote.messageId !== undefined) string(quote.messageId, `input.quotes[${index}].messageId`, { max: 256 })
    if (quote.quotedRole !== undefined && !['user', 'assistant'].includes(quote.quotedRole)) {
      throw new ProtocolError('INVALID_REQUEST', `input.quotes[${index}].quotedRole is invalid`)
    }
    if (quote.excerpt !== undefined) string(quote.excerpt, `input.quotes[${index}].excerpt`, { allowEmpty: true, max: 100_000 })
  })
  if (input.actionClick !== undefined && input.actionClick !== null) {
    const action = record(input.actionClick, 'input.actionClick')
    string(action.kind, 'input.actionClick.kind', { max: 128 })
    string(action.value, 'input.actionClick.value', { max: 100_000 })
    if (action.label !== undefined) string(action.label, 'input.actionClick.label', { allowEmpty: true, max: 512 })
    if (action.sourceMessageId !== undefined) string(action.sourceMessageId, 'input.actionClick.sourceMessageId', { max: 256 })
  }
  return input
}

function validateClient(value) {
  const client = record(value, 'client')
  if (!CLIENT_PLATFORMS.has(client.platform)) throw new ProtocolError('INVALID_REQUEST', 'client.platform is invalid')
  array(client.capabilities ?? [], 'client.capabilities', 32).forEach((capability, index) => {
    if (!CLIENT_CAPABILITIES.has(capability)) {
      throw new ProtocolError('INVALID_REQUEST', `client.capabilities[${index}] is invalid`)
    }
  })
  string(client.locale ?? 'zh-CN', 'client.locale', { max: 64 })
  if (client.timezone !== undefined) string(client.timezone, 'client.timezone', { max: 128 })
  if (client.viewport !== undefined) {
    const viewport = record(client.viewport, 'client.viewport')
    if (!Number.isSafeInteger(viewport.width) || viewport.width <= 0) throw new ProtocolError('INVALID_REQUEST', 'client.viewport.width is invalid')
    if (viewport.height !== undefined && (!Number.isSafeInteger(viewport.height) || viewport.height <= 0)) {
      throw new ProtocolError('INVALID_REQUEST', 'client.viewport.height is invalid')
    }
  }
  return client
}

function validateAsyncGrant(value) {
  if (value === undefined) return
  const grant = record(value, 'extensions.slashxAsync')
  let callback
  try { callback = new URL(grant.callbackUrl) } catch { throw new ProtocolError('INVALID_REQUEST', 'extensions.slashxAsync.callbackUrl must be a URL') }
  if (!['http:', 'https:'].includes(callback.protocol)) throw new ProtocolError('INVALID_REQUEST', 'callbackUrl must use HTTP(S)')
  uuid(grant.callbackRunId, 'extensions.slashxAsync.callbackRunId')
  string(grant.callbackToken, 'extensions.slashxAsync.callbackToken', { max: 512 })
  if (grant.callbackToken.length < 32) throw new ProtocolError('INVALID_REQUEST', 'callbackToken must have at least 32 characters')
  if (!Number.isSafeInteger(grant.callbackExpiresAt) || grant.callbackExpiresAt <= 0) {
    throw new ProtocolError('INVALID_REQUEST', 'callbackExpiresAt must be a positive integer')
  }
  if (grant.idempotencyKey !== undefined) string(grant.idempotencyKey, 'extensions.slashxAsync.idempotencyKey', { max: 256 })
}

export function assertRequestV1(value) {
  const request = record(value, 'request')
  validateJsonTree(request, 'request', { maxBytes: 32 * 1024 * 1024 })
  if (request.schemaVersion !== 'slashx.request.v1') {
    throw new ProtocolError('UNSUPPORTED_SCHEMA', 'schemaVersion must be slashx.request.v1')
  }
  if (!REQUEST_EVENTS.has(request.event ?? 'user_message')) throw new ProtocolError('INVALID_REQUEST', 'event is invalid')
  uuid(request.runId, 'runId')
  uuid(request.traceId, 'traceId')
  uuid(request.conversationId, 'conversationId')
  string(request.userId, 'userId', { max: 256 })
  const agent = record(request.agent, 'agent')
  string(agent.id, 'agent.id', { max: 256 })
  string(agent.name, 'agent.name', { max: 512 })
  if (agent.config !== undefined) {
    const config = record(agent.config, 'agent.config')
    if (config.systemPrompt !== undefined) string(config.systemPrompt, 'agent.config.systemPrompt', { allowEmpty: true, max: 200_000 })
    if (config.model !== undefined) string(config.model, 'agent.config.model', { max: 512 })
    if (config.temperature !== undefined && (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2)) {
      throw new ProtocolError('INVALID_REQUEST', 'agent.config.temperature must be between 0 and 2')
    }
    array(config.tags, 'agent.config.tags', 100).forEach((tag, index) => string(tag, `agent.config.tags[${index}]`, { max: 128 }))
  }
  validateClient(request.client)
  validateInput(request.input)
  array(request.history ?? [], 'history', 500).forEach((value, index) => {
    const item = record(value, `history[${index}]`)
    if (!['user', 'assistant', 'system', 'tool'].includes(item.role)) throw new ProtocolError('INVALID_REQUEST', `history[${index}].role is invalid`)
    const content = record(item.content, `history[${index}].content`)
    if (content.text !== undefined) string(content.text, `history[${index}].content.text`, { allowEmpty: true, max: 1_000_000 })
  })
  if (request.historyTruncated !== undefined && typeof request.historyTruncated !== 'boolean') {
    throw new ProtocolError('INVALID_REQUEST', 'historyTruncated must be a boolean')
  }
  const extensions = optionalRecord(request.extensions, 'extensions') ?? {}
  validateJsonTree(extensions, 'extensions')
  validateAsyncGrant(extensions.slashxAsync)
  const eventPayload = optionalRecord(request.eventPayload, 'eventPayload')
  if (eventPayload) validateJsonTree(eventPayload, 'eventPayload')
  return request
}

function assertHttpUrl(value, path) {
  const raw = string(value, path, { max: 16_384 })
  let url
  try { url = new URL(raw) } catch { throw new ProtocolError('INVALID_DELIVERY', `${path} must be an absolute URL`) }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProtocolError('INVALID_DELIVERY', `${path} must use HTTP(S)`)
  return raw
}

function validateOutputItem(value, path, { attachment = false } = {}) {
  const item = record(value, path)
  const hasUrl = typeof item.url === 'string' && item.url.length > 0
  const hasPath = typeof item.localPath === 'string' && item.localPath.length > 0
  if (hasUrl === hasPath) throw new ProtocolError('INVALID_DELIVERY', `${path} must contain exactly one of url or localPath`)
  if (hasUrl) assertHttpUrl(item.url, `${path}.url`)
  if (hasPath) string(item.localPath, `${path}.localPath`, { max: 4096 })
  if (item.mimeType !== undefined) string(item.mimeType, `${path}.mimeType`, { max: 255 })
  if (item.fileName !== undefined) string(item.fileName, `${path}.fileName`, { allowEmpty: true, max: 512 })
  if (attachment && item.attachmentType !== undefined) string(item.attachmentType, `${path}.attachmentType`, { max: 128 })
  validateMeta(item.meta, `${path}.meta`)
  return item
}

function validateAction(value, path) {
  const action = record(value, path)
  string(action.label, `${path}.label`, { max: 512 })
  if (!ACTION_KINDS.has(action.kind)) throw new ProtocolError('INVALID_DELIVERY', `${path}.kind is invalid`)
  string(action.value, `${path}.value`, { max: 100_000 })
  if (action.kind === 'open_url') assertHttpUrl(action.value, `${path}.value`)
  validateMeta(action.meta, `${path}.meta`)
  return action
}

export function assertDeliveryDraft(value) {
  const draft = record(value, 'slashx_deliver arguments')
  validateJsonTree(draft, 'slashx_deliver arguments')
  uuid(draft.runId, 'runId')
  if (draft.text !== undefined) string(draft.text, 'text', { allowEmpty: true, max: 1_000_000 })
  for (const [key, max] of [['images', 50], ['videos', 20], ['audio', 20]]) {
    array(draft[key], key, max).forEach((item, index) => validateOutputItem(item, `${key}[${index}]`))
  }
  array(draft.attachments, 'attachments', 50)
    .forEach((item, index) => validateOutputItem(item, `attachments[${index}]`, { attachment: true }))
  array(draft.citations, 'citations', 100).forEach((value, index) => {
    const citation = record(value, `citations[${index}]`)
    if (citation.index !== undefined && (!Number.isSafeInteger(citation.index) || citation.index <= 0)) {
      throw new ProtocolError('INVALID_DELIVERY', `citations[${index}].index is invalid`)
    }
    string(citation.title, `citations[${index}].title`, { max: 1024 })
    if (citation.url !== undefined) assertHttpUrl(citation.url, `citations[${index}].url`)
    if (citation.snippet !== undefined) string(citation.snippet, `citations[${index}].snippet`, { allowEmpty: true, max: 20_000 })
    validateMeta(citation.meta, `citations[${index}].meta`)
  })
  array(draft.actions, 'actions', 50).forEach((item, index) => validateAction(item, `actions[${index}]`))
  array(draft.cards, 'cards', 50).forEach((value, index) => {
    const card = record(value, `cards[${index}]`)
    string(card.type, `cards[${index}].type`, { max: 128 })
    for (const key of ['title', 'subtitle', 'description']) {
      if (card[key] !== undefined) string(card[key], `cards[${index}].${key}`, { allowEmpty: true, max: 20_000 })
    }
    if (card.imageUrl !== undefined) assertHttpUrl(card.imageUrl, `cards[${index}].imageUrl`)
    array(card.fields, `cards[${index}].fields`, 100).forEach((value, fieldIndex) => {
      const field = record(value, `cards[${index}].fields[${fieldIndex}]`)
      string(field.label, `cards[${index}].fields[${fieldIndex}].label`, { max: 1024 })
      string(field.value, `cards[${index}].fields[${fieldIndex}].value`, { max: 20_000 })
    })
    array(card.actions, `cards[${index}].actions`, 20).forEach((item, actionIndex) => validateAction(item, `cards[${index}].actions[${actionIndex}]`))
    validateMeta(card.meta, `cards[${index}].meta`)
  })
  if (draft.conversationUpdate !== undefined) {
    const update = record(draft.conversationUpdate, 'conversationUpdate')
    if (update.title !== undefined) string(update.title, 'conversationUpdate.title', { allowEmpty: true, max: 1024 })
    if (update.modeTag !== undefined) string(update.modeTag, 'conversationUpdate.modeTag', { allowEmpty: true, max: 256 })
  }
  if (draft.messageRole !== undefined && !MESSAGE_ROLES.has(draft.messageRole)) {
    throw new ProtocolError('INVALID_DELIVERY', 'messageRole is invalid')
  }
  if (draft.messageStatus !== undefined && !MESSAGE_STATUSES.has(draft.messageStatus)) {
    throw new ProtocolError('INVALID_DELIVERY', 'messageStatus is invalid')
  }
  return draft
}

export function makeResponse({ request, content = {}, runStatus = 'success', usage, error, progress, conversationUpdate, extensions = {}, emitMessage = true }) {
  const message = {
    id: request.runId,
    role: error ? 'error' : 'assistant',
    status: error ? 'error' : runStatus === 'cancelled' ? 'cancelled' : 'success',
    delta: false,
    done: true,
    content: { text: '', ...content },
  }
  return {
    schemaVersion: 'slashx.response.v1',
    runId: request.runId,
    traceId: request.traceId,
    runStatus,
    ...(progress === undefined ? {} : { progress }),
    messages: !emitMessage || runStatus === 'pending' || runStatus === 'running' ? [] : [message],
    ...(conversationUpdate === undefined ? {} : { conversationUpdate }),
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error }),
    extensions,
  }
}

export function makeErrorResponse(request, code, message, retryable = false) {
  return makeResponse({
    request,
    runStatus: 'error',
    error: { code, message, userVisible: true, retryable },
    content: { text: message },
  })
}

export function gatewayCapabilities({ publicBaseUrlConfigured }) {
  return {
    schemaVersion: 'slashx.gateway-capabilities.v1',
    request: {
      text: { transport: true, semantic: 'native' },
      images: { transport: true, semantic: 'native_if_selected_model_supports_image' },
      audio: { transport: true, semantic: 'workspace_file' },
      videos: { transport: true, semantic: 'workspace_file' },
      attachments: { transport: true, semantic: 'workspace_file' },
      quotes: { transport: true, semantic: 'structured_prompt_context' },
      actionClick: { transport: true, semantic: 'structured_prompt_context' },
      history: { transport: true, semantic: 'harness_session_is_authoritative' },
      events: {
        user_message: 'native',
        action_click: 'prompt',
        cancel: 'native',
        conversation_open: 'prompt',
        retract: 'acknowledged_no_history_rewrite',
        idle: 'acknowledged_noop',
      },
    },
    response: {
      markdown: { transport: true, semantic: 'assistant_text' },
      images: { transport: true, semantic: publicBaseUrlConfigured ? 'delivery_tool_and_asset_publisher' : 'remote_url_only' },
      videos: { transport: true, semantic: publicBaseUrlConfigured ? 'delivery_tool_and_asset_publisher' : 'remote_url_only' },
      audio: { transport: true, semantic: publicBaseUrlConfigured ? 'delivery_tool_and_asset_publisher' : 'remote_url_only' },
      attachments: { transport: true, semantic: publicBaseUrlConfigured ? 'delivery_tool_and_asset_publisher' : 'remote_url_only' },
      citations: { transport: true, semantic: 'delivery_tool' },
      cards: { transport: true, semantic: 'delivery_tool' },
      actions: { transport: true, semantic: 'delivery_tool' },
      streaming: { transport: false, semantic: 'final_response_or_async_callback' },
    },
    billing: {
      modes: ['flat_per_run', 'pass_through'],
      tokenUsage: {
        promptTokens: 'root_and_subagent_uncached_input_plus_cache_read_plus_cache_write',
        completionTokens: 'root_and_subagent_output',
        retriesIncluded: true,
        completenessMarker: 'extensions.slashxHarness.metering.usageComplete',
        incompleteBehavior: 'omit_settlement_usage',
      },
    },
    degradationIsExplicit: true,
  }
}

export const protocolInternals = {
  UUID_RE,
  ACTION_KINDS,
  CLIENT_CAPABILITIES,
  validateJsonTree,
}
