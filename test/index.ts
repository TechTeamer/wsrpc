
import 'mocha'

import * as protobuf from 'protobufjs'
import * as assert from 'assert'

import * as path from 'path'
import * as crypto from 'crypto'
import { ancestorWhere } from 'tslint'
import {Server, Client} from './../src'
import * as wsrpc_client from './../src/client'
import {waitForEvent, getFullName, lookupServices} from './../src/utils'
import {TestService, TextMessage, FakeMessage} from './../protocol/test'
import { testNamespaceWithSameMethods } from './../protocol/test-package'
import * as rpcproto from './../protocol/rpc'
import * as WebSocket from 'ws'

const testPort = 1234
const testAddr = `ws://localhost:${ testPort }`
const testProtoPath = path.join(__dirname, './../protocol/test.proto')
const testPackageProtoPath = path.join(__dirname, './../protocol/test-package.proto')
const testProto = protobuf.loadSync([testProtoPath, testPackageProtoPath])

const serverService = testProto.lookupService('TestService')
const packagedTestService = testProto.lookupService('testNamespaceWithSameMethods.TestService')
const serverOpts = {
    port: testPort,
    pingInterval: 0.05,
}

describe('utils', () => {
    it('getFullName works for services', function() {
        assert.equal(getFullName(serverService), 'TestService')
        assert.equal(getFullName(packagedTestService), 'testNamespaceWithSameMethods.TestService')
    })

    it('getFullName works for methods', function() {
        const upperMethod = serverService.methods['Upper']
        const otherUpperMethod = packagedTestService.methods['Upper']

        assert.equal(getFullName(upperMethod), 'TestService.Upper')
        assert.equal(getFullName(otherUpperMethod), 'testNamespaceWithSameMethods.TestService.Upper')
    })

    it('lookupServices works', function() {
        const services = lookupServices(testProto)
        assert.deepEqual(services, ['TestService', 'testNamespaceWithSameMethods.TestService'])
    })
})

describe('rpc', () => {

    let planError = false
    let unplannedError = false

    let server = new Server(testProto, serverOpts)

    server.implement('Echo', async (request: TextMessage) => {
        if (request.text === 'throw-string') {
            throw 'You should always trow an error object'
        }
        if (request.text === 'throw') {
            throw new Error('Since you asked for it')
        }
        return {text: request.text}
    })

    server.implement(serverService.methods['Upper'], (request: TextMessage) => {
        return new Promise((resolve, reject) => {
            const text = request.text.toUpperCase()
            setTimeout(() => {
                resolve({text})
            }, 50)
        })
    })

    server.implement(packagedTestService.methods['Upper'], async (request: TextMessage) => {
        return { text: 'Upper: ' + request.text.toUpperCase() }
    })

    server.implement('testNamespaceWithSameMethods.TestService.lower', async (request: TextMessage) => {
        return { text: 'lower: ' + request.text.toLowerCase() }
    })

    server.on('error', (error: Error) => {
        if (planError) {
            return
        }

        unplannedError = true
        console.warn('unplanned server error', error.message)
    })

    const client = new Client(testAddr, testProto, {
        sendTimeout: 100,
        autoConnect: true,
        eventTypes: {
            'text': TextMessage
        }
    })

    let clientWithoutAutoConnect = new Client(testAddr, testProto, {
        autoConnect: false
    })

    client.on('error', (error: Error) => {
        if (planError) {
            return
        }

        unplannedError = true
        console.warn('unplanned client error', error.message)
    })

    after(async () => await client.disconnect())

    it('should throw when implementing invalid method', function() {
        assert.throws(() => {
            server.implement('kek', async () => { return {}})
        })
        assert.throws(() => {
            const orphanMethod = new protobuf.Method('Keke', 'foo', 'bar', 'baz')
            server.implement(orphanMethod, async () => { return {}})
        })
    })

    it('client without autoConnect should connect manually', async function() {
        assert.equal(clientWithoutAutoConnect.isConnected(), false)
        await clientWithoutAutoConnect.connect()
        assert.equal(clientWithoutAutoConnect.isConnected(), true)
        // Clean up connection...
        await clientWithoutAutoConnect.disconnect()
        assert.equal(clientWithoutAutoConnect.isConnected(), false)
    })

    it('should run echo rpc method', async function() {
        // @ts-ignore
        const response = await client.service('TestService').echo({text: 'hello world'})
        assert.equal(response.text, 'hello world')
    })

    it('should run upper rpc method', async function() {
        this.slow(150)

        // @ts-ignore
        const response = await client.service('TestService').upper({text: 'hello world'})
        assert.equal(response.text, 'HELLO WORLD')
    })

    it('should run upper rpc method in namespaced service', async function() {
        // @ts-ignore
        const response = await client.service('testNamespaceWithSameMethods.TestService').upper({text: 'hello world'})
        assert.equal(response.text, 'Upper: HELLO WORLD')
    })

    it('should run lower rpc method in namespaced service', async function() {
        // @ts-ignore
        const response = await client.service('testNamespaceWithSameMethods.TestService').lower({text: 'Hello World'})
        assert.equal(response.text, 'lower: hello world')
    })

    it('should run without @ts-ignore if the type is specified...', async function() {
        const service: testNamespaceWithSameMethods.TestService = client.service('testNamespaceWithSameMethods.TestService')
        const response = await service.lower({text: 'Hello World'})
        assert.equal(response.text, 'lower: hello world')
    })

    it('should handle thrown errors in implementation handler', async function() {
        planError = true
        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'throw'})
            assert(false, 'should not be reached')
        } catch (error) {
            assert.equal(error.name, 'RPCError')
            assert.equal(error.message, 'Since you asked for it')
        }
    })

    it('should handle thrown strings in implementation handler', async function() {
        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'throw-string'})
            assert(false, 'should not be reached')
        } catch (error) {
            assert.equal(error.name, 'RPCError')
            assert.equal(error.message, 'You should always trow an error object')
        }
    })

    it('should handle unimplemented methods', async function() {
        try {
            // @ts-ignore
            await client.service('TestService').notImplemented({})
            assert(false, 'should throw')
        } catch (error) {
            assert.equal(error.name, 'RPCError')
            assert.equal(error.message, 'Not implemented')
        }
    })

    it('request handler should throw if missing request type', async function() {
        // @ts-ignore
        const method: protobuf.Method = server.root.lookup('TestService.Echo')
        const originalRequestType = method.resolvedRequestType
        method.resolvedRequestType = null

        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'something'})
        } catch (error) {
            assert.equal(error.name, 'RPCError')
            assert.equal(error.jse_shortmsg, 'Unable to resolve method types')
            assert.equal(error.message, 'Unable to resolve method types')
            method.resolvedRequestType = originalRequestType
        }
    })

    it('request handler should throw if missing response type', async function() {
        // @ts-ignore
        const method: protobuf.Method = server.root.lookup('TestService.Echo')
        const originalResponseType = method.resolvedResponseType
        method.resolvedResponseType = null

        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'something'})
        } catch (error) {
            assert.equal(error.name, 'RPCError')
            assert.equal(error.jse_shortmsg, 'Unable to resolve method types')
            assert.equal(error.message, 'Unable to resolve method types')
            method.resolvedResponseType = originalResponseType
        }
    })

    it('should handle message without a request object', function(done) {
        const c = client as any
        const msg = FakeMessage.encode({
            type: FakeMessage.Type.REQUEST,
        }).finish()

        server.once('error', (error: any) => {
            assert.equal(error.name, 'ConnectionError')
            assert.equal(error.jse_cause.message, 'could not decode message: Message request missing')
            done()
        })

        c.socket.send(msg)
    })

    it('should handle bogus request message', function(done) {
        const c = client as any
        const msg = rpcproto.Message.encode({
            type: rpcproto.Message.Type.REQUEST,
            request: {
                seq: 0,
                method: crypto.pseudoRandomBytes(1e4).toString('utf8'),
            }
        }).finish()
        c.socket.send(msg)
        server.once('error', (error: any) => {
            assert.equal(error.message, 'connection error: Invalid method')
            done()
        })
    })

    it('should handle bogus message', function(done) {
        const c = client as any
        const msg = rpcproto.Message.encode({
            type: rpcproto.Message.Type.EVENT,
            response: {
                seq: -100,
                ok: false,
                payload: crypto.pseudoRandomBytes(1e6),
            }
        }).finish()
        c.socket.send(msg)
        server.once('error', (error: any) => {
            assert.equal(error.message, 'connection error: could not decode message: Invalid message type')
            done()
        })
    })

    it('should handle garbled data from client', function(done) {
        planError = true
        const c = client as any
        c.socket.send(crypto.pseudoRandomBytes(512))
        server.once('error', (error: any) => {
            assert.equal(error.jse_cause.name, 'RequestError')
            assert.equal(error.jse_cause.jse_shortmsg, 'could not decode message')
            done()
        })
    })

    it('should handle garbled data from server', function(done) {
        assert.equal(server.connections.length, 1)
        let conn = server.connections[0] as any
        conn.socket.send(crypto.pseudoRandomBytes(1024))
        client.once('error', (error: any) => {
            assert.equal(error.name, 'MessageError')
            assert.equal(error.jse_shortmsg, 'got invalid message')
            done()
        })
    })

    it('should handle missing response data from server', function(done) {
        assert.equal(server.connections.length, 1)
        const conn = server.connections[0] as any

        const msg = rpcproto.Message.encode({
            type: rpcproto.Message.Type.RESPONSE,
        }).finish()

        conn.socket.send(msg)
        client.once('error', (error: any) => {
            assert.equal(error.name, 'MessageError')
            assert.equal(error.jse_cause.message, 'Response data missing')
            done()
        })
    })

    it('should handle missing event data from server', function(done) {
        assert.equal(server.connections.length, 1)
        const conn = server.connections[0] as any

        const msg = rpcproto.Message.encode({
            type: rpcproto.Message.Type.EVENT,
        }).finish()

        conn.socket.send(msg)
        client.once('error', (error: any) => {
            assert.equal(error.name, 'MessageError')
            assert.equal(error.jse_cause.message, 'Event data missing')
            done()
        })
    })

    it('should emit event', function(done) {
        planError = false
        assert.equal(server.connections.length, 1)
        const data = crypto.pseudoRandomBytes(42)
        server.connections[0].send('marvin', data)
        client.once('event', (name: string, payload?: Uint8Array) => {
            assert.equal(name, 'marvin')
            assert.deepEqual(payload, data)
            done()
        })
    })

    it('should emit typed event', function(done) {
        const text = 'I like les turlos'
        server.broadcast('text', TextMessage.encode({text}).finish())
        client.once('event', (name: string, payload: TextMessage) => {
            assert.equal(name, 'text')
            assert.equal(payload.text, text)
            done()
        })
    })

    it('should handle garbled event data', function(done) {
        planError = true
        server.broadcast('text', crypto.pseudoRandomBytes(42))
        client.once('error', (error: any) => {
            assert.equal(error.name, 'EventError')
            assert.equal(error.jse_shortmsg, 'could not decode event payload')
            done()
        })
    })

    it('should timeout messages', async function() {
        this.slow(300)
        // @ts-ignore
        const response = client.service('TestService').echo({text: 'foo'})
        await client.disconnect()
        try {
            await response
            assert(false, 'should throw')
        } catch (error) {
            assert.equal(error.name, 'TimeoutError')
        }
    })

    it('should reconnect', async function() {
        planError = false
        await client.connect()
        // @ts-ignore
        const response = await client.service('TestService').echo({text: 'baz'})
        assert(response.text, 'baz')
    })

    it('should ignore double reconnect', async function() {
        await client.connect()
    })

    it('should handle server disconnection', async function() {
        this.slow(300)
        const c = client as any
        c.sendTimeout = 1000

        assert.equal(server.connections.length, 1)
        server.connections[0].close()
        await waitForEvent(client, 'close')

        // @ts-ignore
        const buzz = client.service('TestService').echo({text: 'fizz'})
        // @ts-ignore
        const fizz = client.service('TestService').echo({text: 'buzz'})
        const response = await Promise.all([buzz, fizz])
        assert.deepEqual(response.map((msg) => msg.text), ['fizz', 'buzz'])
    })

    it('should throw when trying to write without socket', async function() {
        this.slow(300)
        const c = client as any
        const originalSocket = c.socket
        const originalIsConnected = c.isConnected
        c.socket = undefined
        c.isConnected = () => true

        try {
            // @ts-ignore
            const response = await c.service('TestService').echo({text: 'fail write...'})
        } catch (error) {
            assert.equal(error.message, 'No socket')
            c.socket = originalSocket
            c.isConnected = originalIsConnected
        }
    })

    it('should handle failed writes', async function() {
        this.slow(300)
        const c = client as any
        c.sendTimeout = 1000
        const originalWrite = c.writeMessage
        c.writeMessage = () => { throw new Error('Failed to write message...') }

        assert.equal(server.connections.length, 1)
        server.connections[0].close()
        await waitForEvent(client, 'close')

        try {
            // @ts-ignore
            const response = await client.service('TestService').echo({text: 'fail write...'})
        } catch (error) {
            assert.equal(error.message, 'Failed to write message...')
            c.writeMessage = originalWrite
        }
    })

    it('should handle socket.send error', async function() {
        const c = client as any
        const originalSend = c.socket.send
        c.socket.send = (message: any, cb: any) => {
            cb(new Error('socket.send callback got error'))
        }

        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'boom'})
            assert(false, 'should not be reached')
        } catch (error) {
            assert.equal(error.message, 'socket.send callback got error')
            c.socket.send = originalSend
        }
    })

    it('should retry', async function() {
        this.slow(300)
        server.close()
        await waitForEvent(client, 'close')
        planError = true
        // force a connection failure to simulate server being down for a bit
        await client.connect()
        planError = false
        server = new Server(testProto, serverOpts)
        await waitForEvent(client, 'open')
    })

    it('should handle failed writes', async function() {
        (<any> client).socket.send = () => { throw new Error('boom') }
        try {
            // @ts-ignore
            await client.service('TestService').echo({text: 'boom'})
            assert(false, 'should not be reached')
        } catch (error) {
            assert.equal(error.message, 'boom')
        }
    })

    it('should catch server errors', async function(done) {
        planError = true
        server.once('error', (error: any) => {
            assert.equal(error.name, 'WebSocketError')
            assert.equal(error.jse_shortmsg, 'server error')
            assert.equal(error.message, 'server error: stuff happened in websocket server...')
            done()
        })
        server.server.emit('error', new Error('stuff happened in websocket server...'))
    })

    it('should catch socket errors', async function(done) {
        const connection = server.connections[0]

        server.once('error', (error: any) => {
            assert.equal(error.name, 'ConnectionError')
            assert.equal(error.jse_shortmsg, 'connection error')
            assert.equal(error.message, 'connection error: socket error...')
            done()
        })
        connection.socket.emit('error', new Error('socket error...'))
    })

    it('should reject when connection.socket.send fails', async function() {
        const connection = server.connections[0]
        const originalSend = connection.socket.send
        connection.socket.send = (message: any, cb: any) => {
            cb(new Error('sending failed...'))
        }

        try {
            await server.broadcast('randomEvent', TextMessage.encode({text: 'testing fail'}).finish())
            assert(false, 'should not be reached')
        } catch (error) {
            assert.equal(error.message, 'sending failed...')
            connection.socket.send = originalSend
        }
    })

    it('should close server', async function() {
        server.close()
        await waitForEvent(client, 'close')
    })

    it('should not have any unplanned error', async function() {
        assert.equal(false, unplannedError)
    })
})

describe('rpc browser client', function() {
    // simulated browser test using the ws module

    let server: Server
    let client: Client

    before(async function() {
        (<any>wsrpc_client).WS = WebSocket
        process.title = 'browser'
        server = new Server(testProto, serverOpts)
        server.implement('TestService.Echo', async (request: TextMessage) => {
            return {text: request.text}
        })
        client = new Client(testAddr, testProto)
    })

    after(async function() {
        await client.disconnect()
        server.close()
    })

    it('should work', async function() {
        // @ts-ignore
        const response = await client.service('TestService').echo({text: 'foo'})
        assert.equal(response.text, 'foo')
    })

    it('should throw when trying to write without socket', async function() {
        this.slow(300)
        const c = client as any
        const originalSocket = c.socket
        const originalIsConnected = c.isConnected
        c.socket = undefined
        c.isConnected = () => true

        try {
            // @ts-ignore
            const response = await c.service('TestService').echo({text: 'fail write...'})
        } catch (error) {
            assert.equal(error.message, 'No socket')
            c.socket = originalSocket
            c.isConnected = originalIsConnected
        }
    })
})
