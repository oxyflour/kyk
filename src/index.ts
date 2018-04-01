import * as os from 'os'
import * as path from 'path'
import * as fs from 'mz/fs'
import * as protobuf from 'protobufjs'

//@ts-ignore
import serializeError from 'serialize-error'

import getPort from 'get-port'
import grpc from 'grpc'
import { EventEmitter } from 'events'
import { Etcd3, Namespace, Lease, IOptions, Watcher } from 'etcd3'
import { AsyncFunctions, AsyncFunction, hookFunc, wrapFunc } from './utils'

export const DEFAULT_MESH_OPTS = {
    nodeName: '',
    etcdPrefix: 'etcd-mesh/',
    etcdOpts: { } as IOptions,
    etcdLease: 10,
    announceInterval: 5,
    callTimeout: 5 * 60,
    destroyed: false,
    listenPort: 3000,
    listenAddr: '0.0.0.0',
}

export const BUILDIN_TYPES = {
    EmptyType: { fields: { } },
    JsonType: { fields: { json: { type: 'string', id: 1 } } },
}

export const CALLTYPE_JSON = {
    ServiceRequest: { ...BUILDIN_TYPES.JsonType },
    ServiceResponse: { ...BUILDIN_TYPES.JsonType },
}

export interface CallTarget {
    host: string,
    proto: any,
}

export interface CallTypes {
    ServiceRequest: { [name: string]: string },
    ServiceResponse: { result: string },
}

function parseTypes(annotation: string) {
    const [, args, result] = annotation.match(/\(([^\)]*)\)\s*=>\s*(.*)/) || ['', '', 'EmptyType'],
        ServiceRequest = { fields: { } } as { fields: { [name: string]: { rule?: string, type: string, id: number } } },
        ServiceResponse = { fields: { result: { type: result, id: 1 } } },
        pairs = args.split(',').map(pair => pair.match(/(\w+)\s*:\s*(\w+)/) || ['', '', ''])
    let id = 1
    for (const [, name, type] of pairs.filter(([match]) => match)) {
        id = id + 1
        ServiceRequest.fields[name] = { type, id }
    }
    return { ServiceRequest, ServiceResponse }
}

async function callService(entry: string, target: CallTarget, args: any[],
        cache = { } as { [key: string]: grpc.Client }) {
    const keys = entry.split('/'),
        [srvName, funcName] = [keys.slice(0, -1).join('_') || 'root', keys.slice(-1).pop() || 'unamed'],
        { proto, host } = target,
        useJson = !!proto.nested.ServiceResponse.fields.json,
        key = `${entry}/$/${host}`
    
    const request = { } as any
    if (useJson) {
        request.json = JSON.stringify(args)
    } else {
        Object.keys(proto.nested.ServiceRequest.fields)
            .forEach((key, index) => request[key] = args[index])
    }

    let client = cache[key]
    if (!client) {
        const root = protobuf.Root.fromJSON(proto),
            desc = grpc.loadObject(root),
            Client = desc[srvName] as typeof grpc.Client
        client = cache[key] = new Client(host, grpc.credentials.createInsecure())
    }

    return await new Promise<{ result: any }>((resolve, reject) => {
        (client as any)[funcName](request, (err: Error, ret: any) => {
            err ? reject(err) : resolve(useJson ? JSON.parse(ret.json) : ret.result)
        })
    })
}

function makeService(entry: string, func: (...args: any[]) => Promise<any>, all: any, types: CallTypes) {
    const keys = entry.split('/'),
        [srvName, funcName] = [keys.slice(0, -1).join('_') || 'root', keys.slice(-1).pop() || 'unamed'],
        methods = { [funcName]: { requestType: 'ServiceRequest', responseType: 'ServiceResponse' } },
        nested = { ...BUILDIN_TYPES, ...(all.nested || { }), ...types, [srvName]: { methods } },
        proto = { ...all, nested },
        root = protobuf.Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = desc[srvName].service,
        useJson = !!proto.nested.ServiceResponse.fields.json,
        impl = {
            [funcName]: (call: grpc.ServerUnaryCall, callback: grpc.sendUnaryData) => {
                func(...(useJson ? JSON.parse(call.request.json) : Object.values(call.request)))
                    .then((result: any) => callback(null, useJson ? { json: JSON.stringify(result) } : { result }))
                    .catch((error: any) => callback(error, undefined))
            }
        }
    return { proto, service, impl }
}

export default class EtcdMesh extends EventEmitter {
    private readonly opts: typeof DEFAULT_MESH_OPTS
    private readonly client: Etcd3
    private readonly etcd: Namespace
    private readonly lease: Lease
    private readonly server: grpc.Server

    constructor(opts = { } as Partial<typeof DEFAULT_MESH_OPTS>, api = { } as any) {
        super()
        this.opts = { ...DEFAULT_MESH_OPTS, ...opts }
        this.client = new Etcd3(this.opts.etcdOpts)
        this.etcd = this.client.namespace(this.opts.etcdPrefix)
        this.lease = this.etcd.lease(this.opts.etcdLease)
        this.server = new grpc.Server()
        this.register(api)
        this.init()
    }

    private async init() {
        const name = this.opts.nodeName || (this.opts.nodeName = Math.random().toString(16).slice(2, 10)),
            port = this.opts.listenPort = await getPort({ port: this.opts.listenPort }),
            credentials = grpc.ServerCredentials.createInsecure()
        this.server.bind(`${this.opts.listenAddr}:${this.opts.listenPort}`, credentials)
        this.server.start()
        await this.poll()
        this.emit('ready')
    }

    private onceReady = new Promise<EtcdMesh>(resolve => this.once('ready', () => resolve(this)))
    ready() {
        return this.onceReady
    }

    private pollTimeout = null as null | NodeJS.Timer
    private async poll() {
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
        try {
            await this.announce()
        } catch (err) {
            this.emit('error', err)
        }
        if (!this.opts.destroyed) {
            this.pollTimeout = setTimeout(() => this.poll(), this.opts.announceInterval * 1000)
        }
    }

    private announcedEntries = { } as { [entry: string]: any }
    async announce() {
        const entries = Object.keys(this.methods).sort().join(';'),
            name = this.opts.nodeName,
            host = `${os.hostname()}:${this.opts.listenPort}`
        if (entries !== Object.keys(this.announcedEntries).sort().join(';')) {
            const toDel = Object.keys(this.announcedEntries).filter(entry => !this.methods[entry]),
                toPut = Object.keys(this.methods).filter(entry => !this.announcedEntries[entry])
            await Promise.all([
                ...toDel.map(entry => this.etcd.delete()
                    .key(`rpc-entry/${entry}/$/${name}`).exec()) as Promise<any>[],
                ...toPut.map(entry => this.lease
                    .put(`rpc-entry/${entry}/$/${name}`)
                    .value(JSON.stringify({ proto: this.methods[entry].proto, host })).exec()) as Promise<any>[],
            ])
            this.announcedEntries = { ...this.methods }
        } else {
            await this.lease.grant()
        }
    }

    private entryCache = { } as { [entry: string]: { targets: { [name: string]: CallTarget }, watcher: Watcher } }
    async list(entry: string) {
        let cache = this.entryCache[entry]
        if (!cache) {
            const namespace = this.etcd.namespace(`rpc-entry/${entry}/$/`),
                watcher = await namespace.watch().prefix('').create(),
                targets = await namespace.getAll().json() as any
            cache = this.entryCache[entry] = { targets, watcher }
            watcher.on('connected', async () => cache.targets = await namespace.getAll().json() as any)
            watcher.on('put', kv => cache.targets[kv.key.toString()] = JSON.parse(kv.value.toString()))
            watcher.on('delete', kv => delete cache.targets[kv.key.toString()])
        }
        return cache.targets
    }

    async select(entry: string) {
        const targets = await this.list(entry)
        return Object.values(targets).pop() // TODO
    }
    
    private clientCache = { } as { [key: string]: grpc.Client }
    query<T extends AsyncFunctions>(api: T, opts = { } as { target?: string }) {
        return hookFunc(api || { }, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const target = await this.select(entry)
                if (!target) {
                    throw Error(`no target found for entry "${entry}"`)
                }
                return await callService(entry, target, args, this.clientCache)
            }
        })
    }
    
    private methods = { } as { [entry: string]: { func: Function, proto: Object } }
    register<T extends AsyncFunctions>(api: T, opts = { } as { proto?: object }) {
        return wrapFunc(api, (...stack) => {
            const keys = stack.map(({ propKey }) => propKey).reverse(),
                entry = keys.join('/'),
                [{ receiver, target, propKey }] = stack,
                func = target.bind(receiver),
                annotation = receiver[propKey + '#type'],
                types = typeof annotation === 'string' ? parseTypes(annotation) : annotation,
                { proto, service, impl } = makeService(entry, func, opts.proto || { }, types || { ...CALLTYPE_JSON })
            this.methods[entry] = { func, proto }
            this.server.addService(service, impl)
            return func
        })
    }

    async destroy() {
        this.opts.destroyed = true

        await Promise.all([
            this.lease.revoke(),
            new Promise(resolve => this.server.tryShutdown(resolve)),
            ... Object.values(this.entryCache).map(({ watcher }) => watcher.cancel()),
        ] as Promise<any>[])

        this.client.close()
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
    }
}
