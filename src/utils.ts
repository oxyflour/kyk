import crypto from 'crypto'
import { Readable } from 'stream'

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

type ReturnPromise<T> = (...args: any[]) => Promise<T>
type ReturnAsyncIterator<T> = (...args: any[]) => AsyncIterableIterator<T>
export interface ApiDefinition { [name: string]: string | ReturnAsyncIterator<any> | ReturnPromise<any> | ApiDefinition }

export function readableToAsyncIterator(stream: Readable) {
    let cbs = { resolve: (() => 0) as Function, reject: (() => 0) as Function },
        pending = new Promise((resolve, reject) => cbs = { resolve, reject })
    function callback(err: any, ret: any) {
        err ? cbs.reject(err) : cbs.resolve(ret)
        pending = new Promise((resolve, reject) => cbs = { resolve, reject })
    }
    stream.on('data', ({ result }: any) => callback(null, { value: result, done: false }))
    stream.on('error', error => callback(error, null))
    stream.on('end', () => callback(null, { done: true }))
    return {
        [Symbol.asyncIterator]() {
            return { next: () => pending }
        }
    }
}

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
