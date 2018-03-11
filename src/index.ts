import * as os from 'os'
//@ts-ignore
import * as serializeError from 'serialize-error'
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

    watchers = { } as { req: Watcher, res: Watcher }
    private async init() {
        const name = this.opts.nodeName || (this.opts.nodeName = Math.random().toString(16).slice(2, 10))

        const req = this.watchers.req = await this.etcd.namespace(`rpc-req/${name}/`).watch().prefix('').create()
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
            await this.etcd.delete().key(id)
        })

        const res = this.watchers.res = await this.etcd.namespace(`rpc-res/${name}/`).watch().prefix('').create()
        res.on('put', async kv => {
            const id = kv.key.toString(),
                { err, ret } = JSON.parse(kv.value.toString()),
                { resolve, reject } = this.calls[id] || [null, null]
            if (resolve && reject) {
                err ? reject(err) : resolve(ret)
                delete this.calls[id]
            } else {
                console.error(`call id "${id}" not found`)
            }
            await this.etcd.delete().key(id)
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
            throw Error(`entry "${entry}" not found`)
        }
    }
    
    private async callRemote(entry: string, args: any[]) {
        const target = await this.getCallTarget(entry),
            id = Math.random().toString(16).slice(2, 10) + '@' + os.hostname(),
            name = this.opts.nodeName,
            addedAt = Date.now()
        return await new Promise(async (resolve, reject) => {
            this.calls[id] = { resolve, reject, addedAt }
            const req = JSON.stringify({ name, entry, args })
            await this.lease.put(`rpc-req/${target}/${id}`).value(req)
        })
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
                promises = [ ] as any[],
                toDel = Object.keys(this.announcedEntries).filter(entry => !this.methods[entry])
                    .map(entry => this.etcd.delete().key(`rpc-entry/${entry}/$/${name}`)),
                toPut = Object.keys(this.methods).filter(entry => !this.announcedEntries[entry])
                    .map(entry => this.lease.put(`rpc-entry/${entry}/$/${name}`).value(value))
            await Promise.all(promises.concat(toDel).concat(toPut))
            this.announcedEntries = { ...this.methods }
        } else {
            await this.lease.grant()
        }
    }

    entryCache = { } as { [entry: string]: { targets: any, watcher: Watcher } }
    private async getCallTarget(entry: string) {
        if (!this.entryCache[entry]) {
            const namespace = this.etcd.namespace(`rpc-entry/${entry}/$/`),
                targets = await namespace.getAll().json(),
                watcher = await namespace.watch().prefix('').create()
            watcher.on('put', kv => targets[kv.key.toString()] = JSON.parse(kv.value.toString()))
            watcher.on('delete', kv => delete targets[kv.key.toString()])
            this.entryCache[entry] = { targets, watcher }
        }
        const keys = Object.keys(this.entryCache[entry].targets)
        return keys[Math.floor(keys.length * Math.random())]
    }
    
    query<T extends AsyncFunctions>(api: T) {
        return hookFunc(api, (...stack) => {
            const entry = stack.map(({ propKey }) => propKey).reverse().join('/')
            return (...args: any[]) => this.callRemote(entry, args)
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
            this.watchers.req.cancel(),
            this.watchers.res.cancel(),
            ... Object.values(this.entryCache).map(({ watcher }) => watcher.cancel())
        ])

        this.client.close()
        this.recycle()
        if (this.pollTimeout) {
            clearTimeout(this.pollTimeout)
        }
    }
}
