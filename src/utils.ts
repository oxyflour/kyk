import crypto from 'crypto'
import { ServerWriteableStream, ClientReadableStream } from 'grpc'

export class GrpcStream<T = any> {
    constructor() {
        this.on('end', () => this.end())
    }
    private cached = [] as (T | null)[]
    private writer = null as ServerWriteableStream<T> | null
    flush(writer: ServerWriteableStream<T>) {
        this.writer = writer
        for (const data of this.cached) {
            if (data) {
                writer.write(data)
            } else {
                writer.end()
            }
        }
        this.cached = []
        return this
    }
    write(msg: T) {
        if (this.writer) {
            this.writer.write(msg)
        } else {
            this.cached.push(msg)
        }
        return this
    }
    end() {
        if (this.writer) {
            this.writer.end()
        } else {
            this.cached.push(null)
        }
    }
    private callbacks = [] as [string, Function][]
    private reader = null as ClientReadableStream<T> | null
    bind(reader: ClientReadableStream<T>) {
        this.reader = reader
        for (const [evt, cb] of this.callbacks) {
            reader.on(evt, cb as any)
        }
        this.callbacks = []
        return this
    }
    on(evt: 'data', cb: (data: T) => any): void
    on(evt: 'end', cb: () => any): void
    on(evt: string, cb: (data: any) => any) {
        if (this.reader) {
            this.reader.on(evt, cb)
        } else {
            this.callbacks.push([evt, cb])
        }
    }
}

export function md5(str: string) {
    return crypto.createHash('md5').update(str).digest('hex')
}

export function asyncCache<R, F extends (...args: any[]) => Promise<R>>(fn: F) {
    const cache = { } as { [key: string]: Promise<R> }
    return (function (...args: any[]) {
        const key = JSON.stringify(args)
        return cache[key] || (cache[key] = fn(...args))
    }) as F
}

export function callWithRetry<F extends ReturnPromise<any>>(fn: F, retry = 1) {
    return (async (...args: any[]) => {
        let count = retry
        while (1) {
            try {
                return await fn(...args)
            } catch (err) {
                count -= 1
                if (count > 0) {
                    continue
                } else {
                    throw err
                }
            }
        }
    }) as F
}

type ReturnPromise<T> = (...args: any[]) => Promise<T>
export interface ApiDefinition { [name: string]: ApiDefinition | ReturnPromise<any> | string }

export interface ProxyStackItem {
    target: any,
    propKey: any,
    receiver: any,
}

export function hookFunc<M extends ApiDefinition>(
        methods: M,
        proxy: (...stack: ProxyStackItem[]) => any,
        stack = [ ] as ProxyStackItem[]): M {
    return new Proxy(methods, {
        get(target, propKey, receiver) {
            const next = [{ target, propKey, receiver }].concat(stack)
            return hookFunc(proxy(...next) as ApiDefinition, proxy, next)
        }
    })
}

export function wrapFunc<M extends ApiDefinition>(
        receiver: M,
        callback: (...stack: ProxyStackItem[]) => void,
        stack = [ ] as ProxyStackItem[]) {
    if (typeof receiver === 'function') {
        return callback(...stack)
    } else if (typeof receiver === 'string') {
        return receiver
    } else {
        const ret = { } as any
        for (const propKey in receiver) {
            const target = receiver[propKey],
                next = [{ target, propKey, receiver }].concat(stack)
            ret[propKey] = wrapFunc(target as ApiDefinition, callback, next)
        }
        return ret
    }
}
