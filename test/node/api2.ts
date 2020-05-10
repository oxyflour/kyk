export class A {
    a = 1 + 1
    b = 'b'
    c = [ ] as string[]

    // WARNING: the following initilizer is not supported
    // k = ['c'] as string[]
    // WARNING: intializers with side effects are not supported
    // d = Date.now()

    // functions are ingored
    m() {
    }
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
    async testClass(a: Partial<A>) {
        return a
    },
    async testDefaultParameters(a: number, b = 'x') {
        return a + b
    },
    async *returnStream() {
        for (let i = 1; i < 10; i ++) {
            await new Promise(resolve => setTimeout(resolve, 100))
            yield i
        }
    },
}
