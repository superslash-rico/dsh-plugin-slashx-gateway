import { assertDeliveryDraft, ProtocolError } from './protocol.js'

function itemSchema({ attachment = false } = {}) {
  return {
    type: 'object',
    additionalProperties: true,
    properties: {
      url: { type: 'string' },
      localPath: { type: 'string' },
      mimeType: { type: 'string' },
      fileName: { type: 'string' },
      ...(attachment ? { attachmentType: { type: 'string' } } : {}),
      meta: { type: 'object' },
    },
  }
}

const actionSchema = {
  type: 'object',
  required: ['label', 'kind', 'value'],
  additionalProperties: true,
  properties: {
    label: { type: 'string' },
    kind: { type: 'string', enum: ['send_message', 'open_url', 'copy', 'feedback', 'custom'] },
    value: { type: 'string' },
    meta: { type: 'object' },
  },
}

const PARAMETERS = {
  type: 'object',
  required: ['runId'],
  additionalProperties: false,
  properties: {
    runId: { type: 'string', description: 'The exact SlashX run ID from the current prompt.' },
    text: { type: 'string', description: 'User-visible Markdown response.' },
    images: { type: 'array', items: itemSchema() },
    videos: { type: 'array', items: itemSchema() },
    audio: { type: 'array', items: itemSchema() },
    attachments: { type: 'array', items: itemSchema({ attachment: true }) },
    citations: { type: 'array', items: { type: 'object' } },
    cards: { type: 'array', items: { type: 'object' } },
    actions: { type: 'array', items: actionSchema },
    conversationUpdate: { type: 'object' },
    messageRole: { type: 'string', enum: ['assistant', 'thinking', 'tool', 'system', 'error'] },
    messageStatus: { type: 'string', enum: ['pending', 'streaming', 'success', 'error', 'cancelled'] },
  },
}

function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? exec?.agent?.sessionId ?? exec?.agent?.id
}

function fallbackName(kind, index) {
  const singular = kind === 'attachments' ? 'file' : kind.replace(/s$/, '')
  return `${singular}-${index + 1}`
}

async function publishItems(items, kind, state, artifactStore) {
  const published = []
  for (let index = 0; index < (items ?? []).length; index += 1) {
    const item = items[index]
    let media
    if (item.localPath) {
      media = await artifactStore.publishLocal({
        localPath: item.localPath,
        allowedRoot: state.conversationRoot,
        mimeType: item.mimeType,
        fileName: item.fileName || fallbackName(kind, index),
        runId: state.request.runId,
      })
    } else {
      media = {
        url: item.url,
        mimeType: item.mimeType || 'application/octet-stream',
        fileName: item.fileName || fallbackName(kind, index),
      }
    }
    published.push({
      ...media,
      ...(item.meta === undefined ? {} : { meta: item.meta }),
      ...(kind === 'attachments' && item.attachmentType ? { attachmentType: item.attachmentType } : {}),
    })
  }
  return published
}

function cardAsMarkdown(card) {
  const lines = []
  if (card.title) lines.push(`### ${card.title}`)
  if (card.subtitle) lines.push(card.subtitle)
  if (card.description) lines.push(card.description)
  for (const field of card.fields ?? []) lines.push(`- ${field.label}: ${field.value}`)
  return lines.join('\n')
}

function actionAsMarkdown(action) {
  if (action.kind === 'open_url') return `[${action.label}](${action.value})`
  if (action.kind === 'send_message') return `- ${action.label}: ${action.value}`
  if (action.kind === 'copy') return `- ${action.label}: \`${action.value.replace(/`/g, '\\`')}\``
  return `- ${action.label}`
}

function applyClientCapabilities(content, capabilities) {
  const result = { ...content }
  const cardActions = (result.cards ?? []).flatMap(card => card.actions ?? [])
  const attachments = [...(result.attachments ?? [])]
  for (const [key, capability, attachmentType] of [
    ['images', 'image', 'image'],
    ['videos', 'video', 'video'],
    ['audio', 'audio', 'audio'],
  ]) {
    if (capabilities.has(capability)) continue
    for (const media of result[key] ?? []) attachments.push({ ...media, attachmentType })
    delete result[key]
  }
  if (attachments.length) result.attachments = attachments
  const fallbackText = []
  if (!capabilities.has('card') && result.cards?.length) {
    fallbackText.push(...result.cards.map(cardAsMarkdown).filter(Boolean))
    delete result.cards
  }
  if (!capabilities.has('action')) {
    const allActions = [
      ...(result.actions ?? []),
      ...cardActions,
    ]
    if (allActions.length) fallbackText.push(allActions.map(actionAsMarkdown).join('\n'))
    delete result.actions
    if (result.cards) {
      result.cards = result.cards.map(card => {
        const sanitized = { ...card }
        delete sanitized.actions
        return sanitized
      })
    }
  }
  if (fallbackText.length) result.text = [result.text, ...fallbackText].filter(Boolean).join('\n\n')
  return result
}

export class ActiveRunRegistry {
  constructor() {
    this.runs = new Map()
  }

  add(state) {
    if (this.runs.has(state.request.runId)) throw new ProtocolError('RUN_CONFLICT', 'runId is already active', 409)
    this.runs.set(state.request.runId, state)
  }

  get(runId) {
    return this.runs.get(runId)
  }

  delete(runId) {
    this.runs.delete(runId)
  }
}

export function createDeliveryTool({ registry, artifactStore }) {
  return {
    name: 'slashx_deliver',
    description: [
      'Deliver the final user-visible response for a request that originated from SlashX.',
      'Use the exact runId from the prompt. text is Markdown.',
      'For generated files, provide localPath inside the active conversation workspace; the gateway publishes a signed URL.',
      'Cards and actions are validated against slashx.response.v1. Call this once after all artifacts are complete and do not repeat its text afterward.',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: {
        type: 'object',
        required: ['accepted', 'publishedItems'],
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean' },
          publishedItems: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accepted
          ? `SlashX response accepted (${value.publishedItems} rich items). Do not repeat the delivered content.`
          : 'SlashX response was not accepted.',
      }],
    },
    async execute(rawArgs, exec) {
      const draft = assertDeliveryDraft(rawArgs)
      const state = registry.get(draft.runId)
      if (!state) throw new ProtocolError('RUN_NOT_ACTIVE', 'runId is not active in this gateway process')
      if (String(sessionIdOf(exec)) !== state.sessionId) {
        throw new ProtocolError('RUN_SESSION_MISMATCH', 'runId belongs to another Harness session')
      }
      if (exec.signal?.aborted) throw new ProtocolError('DELIVERY_CANCELLED', 'delivery was cancelled')
      const [images, videos, audio, attachments] = await Promise.all([
        publishItems(draft.images, 'images', state, artifactStore),
        publishItems(draft.videos, 'videos', state, artifactStore),
        publishItems(draft.audio, 'audio', state, artifactStore),
        publishItems(draft.attachments, 'attachments', state, artifactStore),
      ])
      const content = applyClientCapabilities({
        text: draft.text ?? '',
        ...(images.length ? { images } : {}),
        ...(videos.length ? { videos } : {}),
        ...(audio.length ? { audio } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(draft.citations?.length ? { citations: draft.citations } : {}),
        ...(draft.cards?.length ? { cards: draft.cards } : {}),
        ...(draft.actions?.length ? { actions: draft.actions } : {}),
      }, state.clientCapabilities)
      state.delivery = {
        content,
        ...(draft.conversationUpdate ? { conversationUpdate: draft.conversationUpdate } : {}),
        messageRole: draft.messageRole ?? 'assistant',
        messageStatus: draft.messageStatus ?? 'success',
      }
      const publishedItems = images.length + videos.length + audio.length + attachments.length
        + (draft.citations?.length ?? 0) + (draft.cards?.length ?? 0) + (draft.actions?.length ?? 0)
      return { accepted: true, publishedItems }
    },
  }
}

export const deliveryInternals = { applyClientCapabilities, sessionIdOf, cardAsMarkdown, actionAsMarkdown }
