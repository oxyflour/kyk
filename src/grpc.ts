import path from 'path'
import grpc, { KeyCertPair, ServerCredentials } from 'grpc'
import ts from 'typescript'
import * as protobuf from 'protobufjs'

import { getProtoObject } from './parser'
import { GrpcStream, ApiDefinition, wrapFunc, md5, hookFunc, callWithRetry, asyncCache } from './utils'

const QUERY_PROTO = require(path.join(__dirname, '..', 'proto.json')),
    QUERY_SERVICE = '_query_proto'

function makeClient(proto: any, srvName: string, host: string) {
    const root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        Client = desc[srvName] as typeof grpc.Client
    return new Client(host, grpc.credentials.createInsecure())
}

const clientCache = { } as { [key: string]: any }
export async function callService(entry: string, host: string, args: any[], proto: any, cache = clientCache) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        cacheKey = `${srvName}/$/${host}`,
        client = cache[cacheKey] || (cache[cacheKey] = makeClient(proto, srvName, host)),
        { requestType, streamFunc } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        request = Object.keys(fields).reduce((all, key, idx) => ({ ...all, [key]: args[idx] }), { }),
        ret = await new Promise((resolve, reject) => {
            client[funcName](request, (err: Error, ret: any) => err ? reject(err) : resolve(ret.result))
        })
    if (streamFunc) {
        const stream = client[streamFunc]()
        return new GrpcStream().flush(stream).bind(stream)
    } else {
        return ret
    }
}

export function makeService(entry: string, func: (...args: any[]) => Promise<any>, proto: any) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        root = (protobuf as any).Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = (desc[srvName] as any).service,
        { requestType, streamFunc } = proto.nested[srvName].methods[funcName],
        fields = proto.nested[requestType].fields,
        argKeys = Object.keys(fields).sort((a, b) => fields[a].id - fields[b].id),
        makeArgs = (request: any) => argKeys.map(key => request[key]),
        streams = [] as GrpcStream[],
        fn = ({ request }: grpc.ServerUnaryCall<any>, callback: grpc.sendUnaryData<any>) => {
            func(...makeArgs(request))
                .then(result => { callback(null, { result }); streamFunc && streams.push(result) })
                .catch(error => callback(error, undefined))
        }
    const impl = { [funcName]: fn } as any
    if (streamFunc) {
        impl[streamFunc] = (stream: any) => streams.length && (streams.pop() as any).flush(stream).bind(stream)
    }
    return { proto, service, impl }
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
            fn = async (entry: string) => JSON.stringify(this.methodMap[entry].proto),
            { service, impl } = makeService(QUERY_SERVICE, fn, QUERY_PROTO)
        server.addService(service, impl)
        for (const api of Array.isArray(apis) ? apis : [apis]) {
            this.register(api)
        }
        server.bind(addr, credentials)
        server.start()
    }
    
    private methodMap = { } as { [entry: string]: { func: Function, proto: Object, hash: string } }
    private register<T extends ApiDefinition>(api: T | string, opts = {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2017,
        } as ts.CompilerOptions) {
        const decl = typeof api === 'string' ? api : `${api.__filename}`,
            mod = typeof api === 'string' ? require(api).default : api,
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
    constructor(readonly host: string) {
    }

    private clientCache = { } as { [key: string]: grpc.Client }
    query<T extends ApiDefinition>(api = { } as T, opts = { } as { retry?: number }) {
        return hookFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const { host } = this,
                    proto = await this.proto(entry),
                    func = callWithRetry(callService, opts.retry),
                    cache = this.clientCache
                return await func(entry, host, args, proto, cache)
            }
        })
    }

    private proto = asyncCache(async (entry: string) => {
        const json = await callService(QUERY_SERVICE, this.host, [entry], QUERY_PROTO, this.clientCache)
        return JSON.parse(`${json}`)
    })
}
