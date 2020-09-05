function genericArray<T>(a: T) {
    return [a]
}

function genericAB<A, B>(a: A, b: B) {
    return { a, b }
}

export default {
    async testSimple(you: string) {
        return 'test pass ' + you
    },
    async testThis() {
        return 'this ' + await this.testSimple('this')
    },
    async testNested() {
        return [
            await this.nested.method(),
            await this.nested.nesteded.method(),
            await this.testSimple('nested'),
        ].join(' ')
    },
    async testGenericArray() {
        return genericArray(0)
    },
    async testGenericMap() {
        return genericAB(0, '')
    },
    nested: {
        async method() {
            return 'nested'
        },
        nesteded: {
            async method() {
                return 'nesteded'
            },
        },
    },
    async inputStream(iter: AsyncIterableIterator<number>) {
        const arr = []
        for await (const val of iter) {
            arr.push(val)
        }
        return arr
    },
}
