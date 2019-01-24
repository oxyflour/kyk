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
    __filename,
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
    async testClass(a: Partial<A>) {
        return a
    },
    async testDefaultParameters(a: number, b = 'x') {
        return a + b
    },
}
