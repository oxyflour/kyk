import * as os from 'os'
//@ts-ignore
import serializeError from 'serialize-error'
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
}

export default class EtcdMesh extends EventEmitter {
    private readonly opts: typeof DEFAULT_MESH_OPTS
    private readonly client: Etcd3
    private readonly etcd: Namespace
    private readonly lease: Lease

    private calls = { } as { [id: string]: { resolve: Function, reject: Function, addedAt: number } }
    private methods = { } as { [entry: string]: Function }

    constructor(opts = { } as Partial<typeof DEFAULT_MESH_OPTS>, api = { } as any) {
        super()
        this.opts = { ...DEFAULT_MESH_OPTS, ...opts }
        this.client = new Etcd3(this.opts.etcdOpts)
        this.etcd = this.client.namespace(this.opts.etcdPrefix)
        this.lease = this.etcd.lease(this.opts.etcdLease),
        this.register(api)
        this.init()
    }

    private callWatchers = { } as { req: Watcher, res: Watcher }
    private async init() {
        const name = this.opts.nodeName || (this.opts.nodeName = Math.random().toString(16).slice(2, 10))

        const reqns = this.etcd.namespace(`rpc-req/${name}/`),
            req = this.callWatchers.req = await reqns.watch().prefix('').create()
        req.on('put', async kv => {
            const id = kv.key.toString(),
                { name, entry, args } = JSON.parse(kv.value.toString()),
                res = { ret: null as null | any, err: null as null | Error }
            try {
                res.ret = await this.onRemoteCall(name, entry, args)
            } catch (err) {
                res.err = serializeError(err)
            }
            await this.lease.put(`rpc-res/${name}/${id}`).value(JSON.stringify(res))
            await reqns.delete().key(id)
        })

        const resns = this.etcd.namespace(`rpc-res/${name}/`),
            res = this.callWatchers.res = await resns.watch().prefix('').create()
        res.on('put', async kv => {
            const id = kv.key.toString(),
                { err, ret } = JSON.parse(kv.value.toString())
            if (this.calls[id]) {
                const { resolve, reject } = this.calls[id]
                err ? reject(err) : resolve(ret)
                delete this.calls[id]
            } else {
                console.error(`call id "${id}" not found`)
            }
            await resns.delete().key(id)
        })

        await this.poll()
        this.emit('ready')
    }

    private pollTimeout = null as null | NodeJS.Timer
    private async poll() {
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
        try {
            await this.recycle()
            await this.announce()
        } catch (err) {
            this.emit('error', err)
        }
        this.pollTimeout = this.opts.destroyed ? null : setTimeout(() => {
            this.poll()
        }, this.opts.announceInterval * 1000)
    }

    private async onRemoteCall(from: string, entry: string, args: any[]) {
        if (this.methods[entry]) {
            return await this.methods[entry](...args)
        } else {
            throw Error(`entry "${entry}" not found on node "${this.opts.nodeName}"`)
        }
    }
    
    private async doCallRemote(target: string, entry: string, args: any[]) {
        if (target) {
            const id = Math.random().toString(16).slice(2, 10) + '@' + os.hostname(),
                name = this.opts.nodeName,
                addedAt = Date.now()
            return await new Promise(async (resolve, reject) => {
                this.calls[id] = { resolve, reject, addedAt }
                const req = JSON.stringify({ name, entry, args })
                await this.lease.put(`rpc-req/${target}/${id}`).value(req)
            })
        } else {
            throw Error(`no targets for entry "${target}"`)
        }
    }

    async recycle() {
        const timeout = Date.now() - (this.opts.destroyed ? 0 : this.opts.callTimeout * 1000)
        for (const key in this.calls) {
            const { addedAt, reject } = this.calls[key]
            if (addedAt < timeout) {
                reject(Error(`call timeout`))
                delete this.calls[key]
            }
        }
    }

    private announcedEntries = { } as { [entry: string]: Function }
    async announce() {
        const entries = Object.keys(this.methods).sort().join(';'),
            name = this.opts.nodeName
        if (entries !== Object.keys(this.announcedEntries).sort().join(';')) {
            const value = JSON.stringify({ }),
                toDel = Object.keys(this.announcedEntries).filter(entry => !this.methods[entry]),
                toPut = Object.keys(this.methods).filter(entry => !this.announcedEntries[entry])
            await Promise.all([
                ...toDel.map(entry => this.etcd.delete().key(`rpc-entry/${entry}/$/${name}`)) as any[],
                ...toPut.map(entry => this.lease.put(`rpc-entry/${entry}/$/${name}`).value(value)) as any[],
            ])
            this.announcedEntries = { ...this.methods }
        } else {
            await this.lease.grant()
        }
    }

    private entryCache = { } as { [entry: string]: { targets: any, watcher: Watcher } }
    async list(entry: string) {
        let cache = this.entryCache[entry]
        if (!cache) {
            const namespace = this.etcd.namespace(`rpc-entry/${entry}/$/`),
                watcher = await namespace.watch().prefix('').create()
            cache = this.entryCache[entry] = { targets: { } as any, watcher }
            watcher.on('connected', async () => cache.targets = await namespace.getAll().json())
            watcher.on('put', kv => cache.targets[kv.key.toString()] = JSON.parse(kv.value.toString()))
            watcher.on('delete', kv => delete cache.targets[kv.key.toString()])
        }
        return cache.targets
    }
    
    query<T extends AsyncFunctions>(api: T, opts = { } as { target?: string }) {
        return hookFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return async (...args: any[]) => {
                const target = opts.target || Object.keys(await this.list(entry)).pop() || ''
                return await this.doCallRemote(target, entry, args)
            }
        })
    }
    
    register<T extends AsyncFunctions>(api: T) {
        return wrapFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/'),
                [{ receiver, target }] = stack
            return this.methods[entry] = target.bind(receiver)
        })
    }

    async destroy() {
        this.opts.destroyed = true

        await Promise.all([
            this.lease.revoke(),
            this.callWatchers.req.cancel(),
            this.callWatchers.res.cancel(),
            ... Object.values(this.entryCache).map(({ watcher }) => watcher.cancel())
        ])

        this.client.close()
        this.recycle()
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
    }
}
