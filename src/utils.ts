export function asyncCache<R, F extends (...args: any[]) => Promise<R>>(fn: F) {
    const cache = { } as { [key: string]: Promise<R> }
    return (function (...args: any[]) {
        const key = JSON.stringify(args)
        return cache[key] || (cache[key] = fn(...args))
    }) as F
}

export type AsyncFunction<T> = (...args: any[]) => Promise<T>
export type AsyncIteratorFunction<T> = (...args: any[]) => AsyncIterableIterator<T>
export interface ApiDefinition { [name: string]: string | AsyncIteratorFunction<any> | AsyncFunction<any> | ApiDefinition }

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

export function getSrvFuncName(entry: string) {
    const srv = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        func = entry.split('/').pop() || ''
    return [srv, func]
}

export const metaQuery = {
    entry: '_query_proto',
    proto: {
        nested: {
            Srv_query_proto: {
                methods: {
                    _query_proto: {
                        requestType: "Srv_query_protoKykReq",
                        responseType: "Srv_query_protoKykRes"
                    }
                }
            },
            Srv_query_protoKykReq: {
                fields: {
                    entry: {
                        id: 1,
                        options: {},
                        rule: "required",
                        type: "string"
                    }
                },
                nested: {}
            },
            Srv_query_protoKykRes: {
                fields: {
                    result: {
                        id: 1,
                        options: {},
                        rule: "required",
                        type: "string"
                    }
                },
                nested: {}
            }
        }
    }
}
