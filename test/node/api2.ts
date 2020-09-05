export class A {
    a = 1 + 1
    b = 'b'
    c = [ ] as string[]
    d?: number

    // WARNING: the following initilizer is not supported
    // k = ['c'] as string[]
    // WARNING: intializers with side effects are not supported
    // d = Date.now()

    // functions are ingored
    m() {
    }
}

export interface D {
    title: string
    children: D[]
}

export default {
    async testArray(arg: number[]) {
        return arg.map(num => num + 1)
    },
    async testMap() {
        return { name: 1 } as { [name: string]: number }
    },
    async testVoid() {
    },
    async throwSomeError() {
        if (1) {
            throw Error(`boom`)
        } else {
            return 0
        }
    },
    async testBuffer(buf: Buffer) {
        return Buffer.from('ret ' + buf.toString())
    },
    async testOptional(x?: string) {
        return x
    },
    async testClass(a: Partial<A>) {
        return a
    },
    async testDefaultParameters(a: number, b = 'x') {
        return a + b
    },
    async testRecursive() {
        return [{ children: [{ title: 'y', children: [] }], title: 'x' }] as D[]
    },
    async *returnStream() {
        for (let i = 1; i < 10; i ++) {
            await new Promise(resolve => setTimeout(resolve, 2000))
            yield i
        }
    },
    async quit(timeout: number) {
        console.log('bye')
        setTimeout(() => process.exit(0), timeout)
    }
}
