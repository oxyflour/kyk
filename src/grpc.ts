import path from 'path'
import fs from 'fs'
import grpc, { KeyCertPair, ServerCredentials } from 'grpc'
import ts from 'typescript'
import * as protobuf from 'protobufjs'

import { getProtoObject } from './parser'
import { ApiDefinition, wrapFunc, md5, hookFunc, asyncCache, readableToAsyncIterator } from './utils'

const QUERY_PROTO = require(path.join(__dirname, '..', 'proto.json')),
    QUERY_SERVICE = '_query_proto'

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

function makeClient(proto: any, srvName: string, host: string) {
    const root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        Client = desc[srvName] as typeof grpc.Client
    return new Client(host, grpc.credentials.createInsecure())
}

const clientCache = { } as { [key: string]: any }
export function callService(entry: string, host: string, args: any[], proto: any, cache = clientCache) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        cacheKey = `${srvName}/$/${host}`,
        client = cache[cacheKey] || (cache[cacheKey] = makeClient(proto, srvName, host)),
        { requestType, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        request = Object.keys(fields).reduce((all, key, idx) => ({ ...all, [key]: args[idx] }), { })
    return responseStream ?
        readableToAsyncIterator(client[funcName](request)) :
        new Promise((resolve, reject) => {
            client[funcName](request, (err: Error, ret: any) => err ? reject(err) : resolve(ret.result))
        })
}

export function makeService(entry: string, func: (...args: any[]) => Promise<any> | AsyncIterableIterator<any>, proto: any) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = (desc[srvName] as any).service,
        { requestType, responseStream } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        argKeys = Object.keys(fields).sort((a, b) => fields[a].id - fields[b].id),
        makeArgs = (request: any) => argKeys.map(key => request[key]),
        fn = responseStream ?
        async (stream: grpc.ServerWriteableStream<any>) => {
            const iter = func(...makeArgs(stream.request)) as AsyncIterableIterator<any>
            for await (const result of iter) {
                stream.write({ result })
            }
            stream.end()
        } :
        (call: grpc.ServerUnaryCall<any>, callback: grpc.sendUnaryData<any>) => {
            const promise = func(...makeArgs(call.request)) as Promise<any>
            promise
                .then(result => callback(null, { result }))
                .catch(error => callback(error, null))
        }
    return { proto, service, impl: { [funcName]: fn } }
}

export interface GrpcOptions {
    rootCerts: Buffer | null,
    keyCertPairs?: KeyCertPair[],
    checkClientCertificate?: boolean,
}

export class GrpcServer {
    constructor(addr: string, apis: ApiDefinition | ApiDefinition[],
            opts = { } as GrpcOptions,
            private readonly server = new grpc.Server()) {
        const { rootCerts, keyCertPairs, checkClientCertificate } = opts,
            credentials = keyCertPairs ?
                ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate) :
                ServerCredentials.createInsecure(),
            { service, impl } = makeService(QUERY_SERVICE, this.protos.bind(this), QUERY_PROTO)
        server.addService(service, impl)
        for (const api of Array.isArray(apis) ? apis : [apis]) {
            this.register(api)
        }
        server.bind(addr, credentials)
        server.start()
    }

    async protos(entry: string) {
        if (entry) {
            return JSON.stringify(this.methodMap[entry].proto)
        }
        const protos = { } as any
        for (const [entry, { proto }] of Object.entries(this.methodMap)) {
            protos[entry] = proto
        }
        return JSON.stringify(protos)
    }
    
    private methodMap = { } as { [entry: string]: { func: Function, proto: Object, hash: string } }
    private register<T extends ApiDefinition>(api: T | string, config?: ts.CompilerOptions) {
        const opts = config || loadTsConfig(path.join(__dirname, '..', 'tsconfig.json')),
            decl = typeof api === 'string' ? api : `${api.__filename}`,
            mod  = typeof api === 'string' ? require(api).default : api,
            types = decl && getProtoObject(decl, mod, opts)
        return wrapFunc(mod, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack,
                func = target.bind(receiver),
                { proto, service, impl } = makeService(entry, func, types),
                hash = md5(JSON.stringify(proto))
            this.methodMap[entry] = { func, proto, hash }
            this.server.addService(service, impl)
            return func
        })
    }

    async destroy(waiting = 30) {
        setTimeout(() => this.server.forceShutdown(), waiting * 1000)
        await new Promise(resolve => this.server.tryShutdown(resolve))
    }
}

export class GrpcClient {
    constructor(private host: string) {
        this.init(host)
    }

    private clientCache = { } as { [key: string]: grpc.Client }
    query<T extends ApiDefinition>(def = { } as T, host = this.host) {
        return hookFunc(def, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return (...args: any[]) => {
                const proto = this.protoCache[entry],
                    cache = this.clientCache
                return callService(entry, host, args, proto, cache)
            }
        })
    }

    private protoCache = { } as { [key: string]: any }
    init = asyncCache(async (host = this.host) => {
        const json = await callService(QUERY_SERVICE, host, [''], QUERY_PROTO, this.clientCache)
        this.protoCache = JSON.parse(`${json}`)
    })
}
