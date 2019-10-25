import * as WebSocket from 'ws'

/**
 * RPC Server options
 * ------------------
 * Server options, extends the WebSocket server options.
 * Note that `WebSocket.ServerOptions.perMessageDeflate` defaults
 * to `false` if omitted.
 */
export interface IServerOptions extends WebSocket.ServerOptions {
    /**
     * How often to send a ping frame, in seconds. Set to 0 to disable. Default = 10.
     */
    pingInterval?: number
}
