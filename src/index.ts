import * as os from 'os'
import * as path from 'path'

//@ts-ignore
import serializeError from 'serialize-error'

import getPort from 'get-port'
import grpc from 'grpc'
import { EventEmitter } from 'events'
import { Etcd3, Namespace, Lease, IOptions, Watcher } from 'etcd3'

import { FunctionObject, hookFunc, wrapFunc } from './utils'
import { makeService, callService, getProtoObject } from './parser'

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
                ...toPut.map(entry => this.lease.put(`rpc-entry/${entry}/$/${name}`)
                    .value(JSON.stringify({ host })).exec()) as Promise<any>[],
                ...toPut.map(entry => this.lease.put(`rpc-proto/${entry}/$/${name}`)
                    .value(JSON.stringify(this.methods[entry].proto)).exec()) as Promise<any>[],
            ])
            this.announcedEntries = { ...this.methods }
        } else {
            await this.lease.grant()
        }
    }
    
    private clientCache = { } as { [key: string]: grpc.Client }
    private protoCache = { } as { [key: string]: any }
    query<T extends FunctionObject>(api: T, opts = { } as { target?: string }) {
        return hookFunc(api || { }, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const targets = await this.etcd.namespace(`rpc-entry/${entry}/$/`).getAll().json(),
                    [target] = Object.entries(targets as { [name: string]: CallTarget })
                if (!target) {
                    throw Error(`no target found for entry "${entry}"`)
                }
                const [name, { host }] = target
                let proto = this.protoCache[entry]
                if (!proto) {
                    proto = this.protoCache[entry] = await this.etcd.get(`rpc-proto/${entry}/$/${name}`).json()
                }
                return await callService(entry, host, args, proto, this.clientCache)
            }
        })
    }
    
    private methods = { } as { [entry: string]: { func: Function, proto: Object } }
    register<T extends FunctionObject>(api: T) {
        const types = api.__filename && getProtoObject(api.__filename.toString(), api)
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
        ] as Promise<any>[])

        this.client.close()
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
    }
}
