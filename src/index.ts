import os from 'os'
import getPort from 'get-port'
import { KeyCertPair } from 'grpc'
import { EventEmitter } from 'events'
import { Etcd3, Namespace, Lease, IOptions, Watcher } from 'etcd3'

import { ApiDefinition, asyncCache, weightedRandom } from './utils'
import { GrpcServer, GrpcClient, GrpcMiddleware } from './grpc'

const DEFAULT_MESH_OPTS = {
    nodeName: '',
    etcdPrefix: process.env.KYKM_ETCD_PREFIX || 'etcd-mesh/',
    etcdOpts: {
        hosts: [process.env.KYKM_ETCD_URL || 'http://localhost:2379']
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

export type MeshOptions = typeof DEFAULT_MESH_OPTS

export interface CallTarget {
    host: string
    hash: string
    name: string
    weight?: number
}

export interface CallEntry {
    targets: Promise<{ [name: string]: CallTarget }>,
    watcher: Promise<Watcher>,
    lastaccess: number,
}

export default class KyokoMesh extends EventEmitter {
    readonly opts: MeshOptions
    private readonly etcd: Etcd3
    private readonly namespace: Namespace
    private readonly lease: Lease
    private readonly client: GrpcClient
    private readonly server: GrpcServer

    constructor(opts = { } as Partial<MeshOptions>) {
        super()
        this.opts = { ...DEFAULT_MESH_OPTS, ...opts }
        this.etcd = new Etcd3(this.opts.etcdOpts)
        this.namespace = this.etcd.namespace(this.opts.etcdPrefix)
        this.lease = this.namespace.lease(this.opts.etcdLease)

        this.client = new GrpcClient()
        this.server = new GrpcServer()

        // override selector
        this.client.select = this.select.bind(this)
    }

    init = asyncCache(async () => {
        this.opts.nodeName = this.opts.nodeName || Math.random().toString(16).slice(2, 10)
        this.opts.listenPort = this.opts.listenPort || await getPort({ port: this.opts.listenPort })
        this.server.start(`${this.opts.listenAddr}:${this.opts.listenPort}`, this.opts.grpcOpts)

        await this.poll()
        return this
    })

    private timer = null as null | NodeJS.Timer
    private async poll() {
        if (this.timer) {
            clearTimeout(this.timer)
        }
        try {
            await this.announce()
        } catch (err) {
            this.emit('error', err)
        }
        this.timer = setTimeout(() => this.poll(), this.opts.announceInterval * 1000)
        this.emit('poll')
    }

    private announced = { } as { [entry: string]: any }
    async announce() {
        const methods = this.server.methods,
            entries = Object.keys(methods).sort().join(';'),
            name = this.opts.nodeName,
            host = `${os.hostname()}:${this.opts.listenPort}`
        if (entries !== Object.keys(this.announced).sort().join(';')) {
            const toDel = Object.keys(this.announced).filter(entry => !methods[entry]),
                toPut = Object.entries(methods).filter(([entry]) => !this.announced[entry])
            await Promise.all([
                ...toDel.map(entry => this.namespace.delete()
                    .key(`rpc-entry/${entry}/$/${name}`).exec()) as Promise<any>[],
                ...toPut.map(([entry, { hash }]) => this.lease.put(`rpc-entry/${entry}/$/${name}`)
                    .value(JSON.stringify({ name, host, hash } as CallTarget)).exec()) as Promise<any>[],
                ...toPut.map(([, { hash, proto }]) => this.lease.put(`rpc-proto/${hash}/${name}`)
                    .value(JSON.stringify(proto)).exec()) as Promise<any>[],
            ])
            this.announced = { ...methods }
        } else {
            await this.lease.grant()
        }
    }

    private targets = { } as { [entry: string]: CallEntry }
    private async search(entry: string) {
        const cache = this.targets
        if (!cache[entry]) {
            const namespace = this.namespace.namespace(`rpc-entry/${entry}/$/`),
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

    private protos = { } as { [key: string]: any }
    private async select(entry: string) {
        const targets = await this.search(entry),
            index = weightedRandom(Object.values(targets).map(item => item.weight || 1)),
            selected = Object.values(targets)[index]
        if (!selected) {
            throw Error(`no targets found for entry ${entry}`)
        }
        const cache = this.protos,
            { name, host, hash } = selected,
            proto = await (cache[hash] || (cache[hash] = this.namespace.get(`rpc-proto/${hash}/${name}`).json()))
        return { host, proto }
    }

    query<T extends ApiDefinition>(api = { } as T) {
        return this.client.query(api)
    }

    register<T extends ApiDefinition>(api: string | T) {
        const exp  = typeof api === 'string' ? require(api).default : api,
            mod = typeof exp === 'function' ? exp(this) : exp,
            decl = typeof api === 'string' ? api : `${mod.__filename}`
        if (!decl) {
            throw Error(`the argument should be the module path or an object containing __filename attribute`)
        }
        return this.server.register(mod, decl), this
    }

    use(middleware: GrpcMiddleware) {
        return this.server.use(middleware), this
    }

    get entries() {
        return Object.keys(this.server.methods)
    }

    private async destroyEtcd() {
        await Promise.all(Object.values(this.targets).map(async target => {
            const req = await target.watcher
            await req.cancel()
        }))
        await this.lease.revoke()
        this.etcd.close()
    }

    async destroy(waiting = 30) {
        if (this.timer) {
            await new Promise(resolve => this.once('poll', resolve))
            clearTimeout(this.timer)
            this.timer = null
        }

        await Promise.all([
            this.server.destroy(waiting),
            this.client.destroy(),
            this.destroyEtcd(),
        ])
    }
}
