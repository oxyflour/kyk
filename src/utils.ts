export type AsyncFunction = (...args: any[]) => Promise<any>
export interface AsyncFunctions { [name: string]: AsyncFunctions | AsyncFunction | string }

export interface ProxyStackItem {
    target: any,
    propKey: any,
    receiver: any,
}

export function hookFunc<M extends AsyncFunctions>(
        methods: M,
        proxy: (...stack: ProxyStackItem[]) => any,
        stack = [ ] as ProxyStackItem[]): M {
    return new Proxy(methods, {
        get(target, propKey, receiver) {
            const next = [{ target, propKey, receiver }].concat(stack)
            return hookFunc(proxy(...next) as AsyncFunctions, proxy, next)
        }
    })
}

export function wrapFunc<M extends AsyncFunctions>(
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
            ret[propKey] = wrapFunc(target as AsyncFunctions, callback, next)
        }
        return ret
    }
}
