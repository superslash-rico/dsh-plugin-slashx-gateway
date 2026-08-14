import { GatewayServer } from './lib/gateway-server.js'

export const name = 'slashx-gateway'
export const inject = ['apiProxy', 'tools']

export function apply(ctx, config = {}) {
  ctx.effect(async () => {
    const gateway = new GatewayServer({
      apiProxy: ctx.apiProxy,
      tools: ctx.tools,
      logger: ctx.logger ?? console,
      config,
    })
    const address = await gateway.start()
    ctx.logger?.info?.(`SlashX gateway listening on http://${address.host}:${address.port}/slashx-provider/v1/run`)
    return async () => gateway.stop()
  }, 'slashx-gateway.listen')
}

export { GatewayServer } from './lib/gateway-server.js'
export { ArtifactStore } from './lib/artifact-store.js'
export { ActiveRunRegistry, createDeliveryTool } from './lib/delivery.js'
export { HarnessBridge } from './lib/harness-bridge.js'
export { RunLedger } from './lib/run-ledger.js'
export * from './lib/protocol.js'
