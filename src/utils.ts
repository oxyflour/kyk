import crypto from 'crypto'

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

export function callWithRetry<F extends (...args: any[]) => Promise<any>>(fn: F, retry = 1) {
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

export interface ApiDefinition { [name: string]: ApiDefinition | Function | string }

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
