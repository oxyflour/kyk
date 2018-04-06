export class A_A {
    a_a = 0
}

export class A {
    a = new A_A()
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
        return new A()
    },
}
