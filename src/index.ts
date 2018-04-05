import * as os from 'os'
import * as path from 'path'
import * as protobuf from 'protobufjs'

//@ts-ignore
import serializeError from 'serialize-error'

import getPort from 'get-port'
import grpc from 'grpc'
import { EventEmitter } from 'events'
import { Etcd3, Namespace, Lease, IOptions, Watcher } from 'etcd3'

import { FunctionObject, hookFunc, wrapFunc } from './utils'
import { getProtoObject } from './parser'

export const DEFAULT_MESH_OPTS = {
    nodeName: '',
    etcdPrefix: 'etcd-mesh/',
    etcdOpts: { } as IOptions,
    etcdLease: 10,
    announceInterval: 5,
    listenPort: 3000,
    listenAddr: '0.0.0.0',
    destroyed: false,
}

export interface CallTarget {
    host: string,
    proto: any,
}

async function callService(entry: string, target: CallTarget, args: any[],
        cache = { } as { [key: string]: grpc.Client }) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()),
        funcName = entry.split('/').pop() || '',
        { proto, host } = target

    const cacheKey = `${entry}/$/${host}`
    let client = cache[cacheKey]
    if (!client) {
        const root = protobuf.Root.fromJSON(proto),
            desc = grpc.loadObject(root),
            Client = desc[srvName] as typeof grpc.Client
        client = cache[cacheKey] = new Client(host, grpc.credentials.createInsecure())
    }

    const reqFields = proto.nested[`${srvName}KykReq`].fields,
        resFields = proto.nested[`${srvName}KykRes`].fields,
        request = resFields.json ? { json: JSON.stringify(args) } :
            Object.keys(reqFields).reduce((req, key, index) => Object.assign(req, { [key]: args[index] }), { })
    return await new Promise((resolve, reject) => {
        (client as any)[funcName](request, (err: Error, ret: any) => {
            err ? reject(err) : resolve(resFields.json ? JSON.parse(ret.json) : ret.result)
        })
    })
}

const JSON_TYPE = { fields: { json: { type: 'string', id: 1 } } }
function makeService(entry: string, func: (...args: any[]) => Promise<any>, types?: any) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()),
        funcName = entry.split('/').pop() || '',
        requestType = `${srvName}KykReq`,
        responseType = `${srvName}KykRes`,
        rpc = { methods: { [funcName]: { requestType, responseType } } },
        proto = types || { nested: { [requestType]: JSON_TYPE, [responseType]: JSON_TYPE, [srvName]: rpc } },
        root = protobuf.Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = (desc[srvName] as any).service,
        resFields = proto.nested[responseType].fields
    const fn = async ({ request }: grpc.ServerUnaryCall, callback: grpc.sendUnaryData) => {
        try {
            const result = await func(...(resFields.json ? JSON.parse(request.json) : Object.values(request)))
            callback(null, resFields.json ? { json: JSON.stringify(result) } : { result })
        } catch (err) {
            callback(err, undefined)
        }
    }
    return { proto, service, impl: { [funcName]: fn } }
}

export default class EtcdMesh extends EventEmitter {
    private readonly opts: typeof DEFAULT_MESH_OPTS
    private readonly client: Etcd3
    private readonly etcd: Namespace
    private readonly lease: Lease
    private readonly server: grpc.Server

    constructor(opts = { } as Partial<typeof DEFAULT_MESH_OPTS>, api = { } as FunctionObject) {
        super()
        this.opts = { ...DEFAULT_MESH_OPTS, ...opts }
        this.client = new Etcd3(this.opts.etcdOpts)
        this.etcd = this.client.namespace(this.opts.etcdPrefix)
        this.lease = this.etcd.lease(this.opts.etcdLease)
        this.server = new grpc.Server()
        this.register(api)
    }

    async init() {
        const name = this.opts.nodeName || (this.opts.nodeName = Math.random().toString(16).slice(2, 10)),
            port = this.opts.listenPort = await getPort({ port: this.opts.listenPort }),
            credentials = grpc.ServerCredentials.createInsecure()
        this.server.bind(`${this.opts.listenAddr}:${this.opts.listenPort}`, credentials)
        this.server.start()
        await this.poll()
        return this
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
    
    private clientCache = { } as { [key: string]: grpc.Client }
    query<T extends FunctionObject>(api: T, opts = { } as { target?: string }) {
        return hookFunc(api || { }, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const targets = await this.list(entry),
                    target = Object.values(targets).pop() // TODO
                if (!target) {
                    throw Error(`no target found for entry "${entry}"`)
                }
                return await callService(entry, target, args, this.clientCache)
            }
        })
    }
    
    private methods = { } as { [entry: string]: { func: Function, proto: Object } }
    register<T extends FunctionObject>(api: T) {
        const types = api.__filename && getProtoObject(api.__filename.toString())
        return wrapFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target, propKey }] = stack,
                func = target.bind(receiver),
                { proto, service, impl } = makeService(entry, func, types)
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
