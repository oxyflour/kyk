import path from 'path'
import fs from 'fs'
import ts from 'typescript'
import crypto from 'crypto'
import grpc, { KeyCertPair, ServerCredentials } from 'grpc'

import { Readable, Writable } from 'stream'
import { EventIterator } from 'event-iterator'
import * as protobuf from 'protobufjs'

import { getProtoObject } from './parser'
import { ApiDefinition, wrapFunc, hookFunc, asyncCache, AsyncFunction, AsyncIteratorFunction, getSrvFuncName, metaQuery } from './utils'

export function md5(str: string) {
    return crypto.createHash('md5').update(str).digest('hex')
}

export function loadTsConfig(file: string) {
    const compilerOptionsJson = fs.readFileSync(file, 'utf8'),
        { config, error } = ts.parseConfigFileTextToJson('tsconfig.json', compilerOptionsJson)
    if (error) {
        throw Error(`load config from '${file}' failed`)
    }
    const basePath: string = process.cwd(),
        settings = ts.convertCompilerOptionsFromJson(config.compilerOptions, basePath)
    if (settings.errors.length) {
        for (const error of settings.errors) {
            console.error(error)
        }
        throw Error(`parse config in '${file}' failed`)
    }
    return settings.options
}

export function getModuleAndDeclaration(api: string | any, ...args: any[]) {
    const exp  = typeof api === 'string' ? require(api).default : api,
        mod = typeof exp === 'function' ? exp(...args) : exp,
        decl = typeof api === 'string' ? api.replace(/\.js$/i, '.d.ts') : `${mod.__filename}`
    if (!decl) {
        throw Error(`the argument should be the module path or an object containing __filename attribute`)
    }
    return { mod, decl }
}

function makeClient(proto: any, srvName: string, url: string) {
    const root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        Client = desc[srvName] as typeof grpc.Client
    return new Client(url, grpc.credentials.createInsecure())
}

function makeAsyncIterator(readable: Readable) {
    return new EventIterator(queue => {
        const ondata = ({ result }: any) => queue.push(result)
        readable.on('data', ondata)
        readable.on('end', queue.stop)
        readable.on('error', queue.fail)
        queue.on('highWater', () => readable.pause())
        queue.on('lowWater', () => readable.resume())
        return () => {
            readable.removeListener('data', ondata)
            readable.removeListener('end', queue.stop)
            readable.removeListener('error', queue.fail)
            readable.destroy()
        }
    })
}

async function startAsyncIterator(stream: Writable, iter: AsyncIterableIterator<any>) {
    for await (const result of iter) {
        stream.write({ result })
    }
    stream.end()
}

export function callService(client: grpc.Client, entry: string, args: any[], proto: any) {
    const [srvName, funcName] = getSrvFuncName(entry),
        { requestType, requestStream, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        request = Object.keys(fields).reduce((all, key, idx) => ({ ...all, [key]: args[idx] }), { }),
        func = (client as any)[funcName].bind(client)
    if (requestStream && responseStream) {
        const stream = func() as grpc.ClientDuplexStream<any, any>
        startAsyncIterator(stream, args[0])
        return makeAsyncIterator(stream)
    } else if (requestStream) {
        return new Promise((resolve, reject) => {
            const callback = (err: Error, ret: any) => err ? reject(err) : resolve(ret.result),
                stream = func(callback) as grpc.ClientWritableStream<any>
            startAsyncIterator(stream, args[0])
        })
    } else if (responseStream) {
        const stream = func(request) as grpc.ClientReadableStream<any>
        return makeAsyncIterator(stream)
    } else {
        return new Promise((resolve, reject) => {
            const callback = (err: Error, ret: any) => err ? reject(err) : resolve(ret.result)
            func(request, callback)
        })
    }
}

export function makeService(entry: string,
        func: AsyncFunction<any> | AsyncIteratorFunction<any>, proto: any) {
    const [srvName, funcName] = getSrvFuncName(entry),
        root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root)
    if (!desc[srvName]) {
        throw Error(`service ${srvName} not found`)
    }
    const service = (desc[srvName] as any).service,
        { requestType, requestStream, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        argKeys = Object.keys(fields).sort((a, b) => fields[a].id - fields[b].id),
        makeArgs = (request: any) => argKeys.map(key => request[key])
    let fn: AsyncFunction<any>
    if (requestStream && responseStream) {
        fn = (stream: grpc.ServerDuplexStream<any, any>) => {
            const arg = makeAsyncIterator(stream),
                iter = func(arg) as AsyncIterableIterator<any>
            return startAsyncIterator(stream, iter)
        }
    } else if (requestStream) {
        fn = async (stream: grpc.ServerReadableStream<any>, callback: grpc.sendUnaryData<any>) => {
            try {
                const arg = makeAsyncIterator(stream),
                    result = await func(arg) as Promise<any>
                callback(null, { result });
            } catch (err) {
                callback(err, null);
            }
        }
    } else if (responseStream) {
        fn = (stream: grpc.ServerWriteableStream<any>) => {
            const iter = func(...makeArgs(stream.request)) as AsyncIterableIterator<any>
            return startAsyncIterator(stream, iter)
        }
    } else {
        fn = async (call: grpc.ServerUnaryCall<any>, callback: grpc.sendUnaryData<any>) => {
            try {
                const result = await func(...makeArgs(call.request)) as Promise<any>
                return callback(null, { result });
            } catch (err) {
                return callback(err, null);
            }
        }
    }
    return { service, impl: { [funcName]: fn } }
}

export interface GrpcOptions {
    rootCerts: Buffer | null,
    keyCertPairs?: KeyCertPair[],
    checkClientCertificate?: boolean,
}

export interface GrpcContext {
    server: GrpcServer
    entry: string
    func: AsyncFunction<any>
    call: any
    callback?: any
    err?: any
    ret?: any
}

export interface GrpcMiddleware {
    (ctx: GrpcContext, next: AsyncFunction<any>): Promise<any>
}

export class GrpcServer {
    constructor() {
    }

    private cachedServer = null as null | grpc.Server
    private get server() {
        if (!this.cachedServer) {
            const func = async (entry: string) => JSON.stringify(this.methods[entry].proto),
                { service, impl } = makeService(metaQuery.entry, func, metaQuery.proto),
                server = this.cachedServer = new grpc.Server()
            server.addService(service, impl)
        }
        return this.cachedServer
    }

    start(addr: string, opts = { } as GrpcOptions) {
        const { rootCerts, keyCertPairs, checkClientCertificate } = opts,
            credentials = keyCertPairs ?
                ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate) :
                ServerCredentials.createInsecure()
        this.server.bind(addr, credentials)
        this.server.start()
    }

    private middlewares = [ ] as GrpcMiddleware[]
    use(middleware: GrpcMiddleware) {
        this.middlewares.push(middleware)
        return this
    }

    private async call(ctx: GrpcContext, middlewares: GrpcMiddleware[]): Promise<any> {
        const [current, ...rest] = middlewares
        if (current) {
            await current(ctx, () => this.call(ctx, rest))
        } else {
            await ctx.func(ctx.call, (err?: any, ret?: any) => {
                ctx.err = err
                ctx.ret = ret
                ctx.callback && ctx.callback(err, ret)
            })
        }
    }

    private warp(entry: string, func: AsyncFunction<any>) {
        const server = this
        return async (call: any, callback?: any) => {
            if (this.middlewares.length) {
                this.call({ entry, server, func, call, callback }, this.middlewares)
            } else {
                func(call, callback)
            }
        }
    }
    
    readonly methods = { } as { [entry: string]: { func: Function, proto: Object, hash: string } }
    register<T extends ApiDefinition>(mod: T, decl: string, config?: ts.CompilerOptions) {
        const opts = config || loadTsConfig(path.join(__dirname, '..', 'tsconfig.json')),
            proto = getProtoObject(decl, mod, opts)
        return wrapFunc(mod, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack,
                func = target.bind(receiver),
                { service, impl } = makeService(entry, func, proto),
                hash = md5(JSON.stringify(proto))
            for (const key of Object.keys(impl)) {
                impl[key] = this.warp(entry, impl[key])
            }
            this.methods[entry] = { func, proto, hash }
            this.server.addService(service, impl)
            return func
        })
    }

    serve(src: string, args = [ ] as any[], config?: ts.CompilerOptions) {
        const { mod, decl } = getModuleAndDeclaration(src, ...args)
        return this.register(mod, decl, config)
    }

    async destroy(waiting = 30) {
        if (this.cachedServer) {
            setTimeout(() => this.server.forceShutdown(), waiting * 1000)
            await new Promise(resolve => this.server.tryShutdown(resolve))
        }
    }
}

export class GrpcClient {
    constructor(private url = 'localhost:3456') {
    }

    private clients = { } as { [key: string]: grpc.Client }
    private getClient(proto: any, entry: string) {
        const [srvName] = getSrvFuncName(entry)
        return this.clients[srvName] || (this.clients[srvName] = makeClient(proto, srvName, this.url))
    }

    private proto = asyncCache(async (entry: string) => {
        const client = this.getClient(metaQuery.proto, metaQuery.entry),
            json = await callService(client, metaQuery.entry, [entry], metaQuery.proto)
        return JSON.parse(`${json}`)
    })

    private call(entry: string, args: any[]) {
        // for async functions
        const then = async (resolve: Function, reject: Function) => {
            try {
                const proto = await this.proto(entry),
                    client = this.getClient(proto, entry),
                    ret = callService(client, entry, args, proto)
                resolve(ret)
            } catch (err) {
                reject(err)
            }
        }
        // for async iterators
        let proxy: AsyncIterableIterator<any>
        const next = async () => {
            if (!proxy) {
                const proto = await this.proto(entry),
                    client = this.getClient(proto, entry),
                    ret = callService(client, entry, args, proto) as any
                proxy = ret[Symbol.asyncIterator]()
            }
            return await proxy.next()
        }
        return { then, [Symbol.asyncIterator]: () => ({ next }) }
    }

    query<T extends ApiDefinition>(def = { } as T) {
        return hookFunc(def, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return (...args: any[]) => this.call(entry, args)
        })
    }

    destroy() {
        for (const client of Object.values(this.clients)) {
            client.close()
        }
        this.clients = { }
    }
}
