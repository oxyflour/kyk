import * as os from 'os'
import getPort from 'get-port'
import grpc, { KeyCertPair, ServerCredentials } from 'grpc'
import { EventEmitter } from 'events'
import { Etcd3, Namespace, Lease, IOptions, Watcher } from 'etcd3'

import weightedRandom = require('weighted-random')

import { FunctionObject, hookFunc, wrapFunc, md5, callWithRetry } from './utils'
import { makeService, callService, getProtoObject } from './parser'

export const DEFAULT_MESH_OPTS = {
    nodeName: '',
    etcdPrefix: 'etcd-mesh/',
    etcdOpts: {
        hosts: ['http://localhost:2379']
    } as IOptions,
    etcdLease: 10,
    announceInterval: 5,
    grpcOpts: { } as {
        rootCerts: Buffer | null,
        keyCertPairs?: KeyCertPair[],
        checkClientCertificate?: boolean,
    },
    listenPort: 0,
    listenAddr: '0.0.0.0',
}

export interface CallTarget {
    host: string
    hash: string
    weight?: number
}

export interface CallEntry {
    targets: Promise<{ [name: string]: CallTarget }>,
    watcher: Promise<Watcher>,
    lastaccess: number,
}

export default class EtcdMesh extends EventEmitter {
    readonly opts: typeof DEFAULT_MESH_OPTS
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
        this.opts.nodeName = this.opts.nodeName || Math.random().toString(16).slice(2, 10)
        this.opts.listenPort = this.opts.listenPort || await getPort({ port: this.opts.listenPort })

        const { rootCerts, keyCertPairs, checkClientCertificate } = this.opts.grpcOpts,
            credentials = keyCertPairs ?
                ServerCredentials.createSsl(rootCerts, keyCertPairs, checkClientCertificate) :
                ServerCredentials.createInsecure()
        this.server.bind(`${this.opts.listenAddr}:${this.opts.listenPort}`, credentials)
        this.server.start()

        await this.poll()
        return this
    }

    private pollTimer = null as null | NodeJS.Timer
    private async poll() {
        if (this.pollTimer) {
            clearTimeout(this.pollTimer)
        }
        try {
            await this.announce()
        } catch (err) {
            this.emit('error', err)
        }
        this.pollTimer = setTimeout(() => this.poll(), this.opts.announceInterval * 1000)
        this.emit('poll')
    }

    private announcedEntries = { } as { [entry: string]: any }
    async announce() {
        const entries = Object.keys(this.methods).sort().join(';'),
            name = this.opts.nodeName,
            host = `${os.hostname()}:${this.opts.listenPort}`
        if (entries !== Object.keys(this.announcedEntries).sort().join(';')) {
            const toDel = Object.keys(this.announcedEntries).filter(entry => !this.methods[entry]),
                toPut = Object.entries(this.methods).filter(([entry]) => !this.announcedEntries[entry])
            await Promise.all([
                ...toDel.map(entry => this.etcd.delete()
                    .key(`rpc-entry/${entry}/$/${name}`).exec()) as Promise<any>[],
                ...toPut.map(([entry, { hash }]) => this.lease.put(`rpc-entry/${entry}/$/${name}`)
                    .value(JSON.stringify({ host, hash } as CallTarget)).exec()) as Promise<any>[],
                ...toPut.map(([, { hash, proto }]) => this.lease.put(`rpc-proto/${hash}`)
                    .value(JSON.stringify(proto)).exec()) as Promise<any>[],
            ])
            this.announcedEntries = { ...this.methods }
        } else {
            await this.lease.grant()
        }
    }

    private targetCache = { } as { [entry: string]: CallEntry }
    private async search(entry: string) {
        const cache = this.targetCache
        if (!cache[entry]) {
            const namespace = this.etcd.namespace(`rpc-entry/${entry}/$/`),
                watcher = namespace.watch().prefix('').create(),
                targets = namespace.getAll().json() as Promise<{ [name: string]: CallTarget }>,
                lastaccess = Date.now()
            cache[entry] = { lastaccess, targets, watcher }
            const dict = await targets
            watcher.then(watch => {
                watch.on('put', req => dict[req.key.toString()] = JSON.parse(req.value.toString()))
                watch.on('delete', req => delete dict[req.key.toString()])
            })
        }
        cache[entry].lastaccess = Date.now()
        return await cache[entry].targets
    }

    private protoCache = { } as { [key: string]: any }
    private async select(entry: string) {
        const targets = await this.search(entry),
            index = weightedRandom(Object.values(targets).map(item => item.weight || 1)),
            selected = Object.values(targets)[index]
        if (!selected) {
            throw Error(`no targets found for entry ${entry}`)
        }
        const cache = this.protoCache,
            { host, hash } = selected,
            proto = await (cache[hash] || (cache[hash] = this.etcd.get(`rpc-proto/${hash}`).json()))
        return { host, proto }
    }
    
    private clientCache = { } as { [key: string]: grpc.Client }
    query<T extends FunctionObject>(api = { } as T, opts = { } as { retry?: number }) {
        return hookFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const { host, proto } = await this.select(entry),
                    func = callWithRetry(callService, opts.retry),
                    cache = this.clientCache
                return await func(entry, host, args, proto, cache)
            }
        })
    }
    
    private methods = { } as { [entry: string]: { func: Function, proto: Object, hash: string } }
    register<T extends FunctionObject>(api: T) {
        const types = api.__filename && getProtoObject(api.__filename.toString(), api)
        return wrapFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack,
                func = target.bind(receiver),
                { proto, service, impl } = makeService(entry, func, types),
                hash = md5(JSON.stringify(proto))
            this.methods[entry] = { func, proto, hash }
            this.server.addService(service, impl)
            return func
        })
    }

    private async destroyGrpc(waiting: number) {
        setTimeout(() => this.server.forceShutdown(), waiting * 1000)
        new Promise(resolve => this.server.tryShutdown(resolve))
    }
    private async destroyEtcd() {
        await Promise.all(Object.values(this.targetCache).map(async target => {
            const req = await target.watcher
            await req.cancel()
        }))
        await this.lease.revoke()
        this.client.close()
    }

    async destroy(waiting = 30) {
        if (this.pollTimer) {
            await new Promise(resolve => this.once('poll', resolve))
            clearTimeout(this.pollTimer)
            this.pollTimer = null
        }

        await Promise.all([
            this.destroyGrpc(waiting),
            this.destroyEtcd(),
        ])
    }
}
