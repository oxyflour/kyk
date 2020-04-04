import Mesh from '../../dist'

function genericArray<T>(a: T) {
    return [a]
}

function genericAB<A, B>(a: A, b: B) {
    return { a, b }
}

export default (node: Mesh) => ({
    async testSimple(you: string) {
        return 'test pass ' + you
    },
    map: {
        [node.opts.nodeName]: {
            async ok() {
                return node.opts.nodeName + ' ok'
            }
        }
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
    async *returnStream() {
        for (let i = 1; i < 10; i ++) {
            await new Promise(resolve => setTimeout(resolve, 100))
            yield i
        }
    },
    async inputStream(iter: AsyncIterableIterator<number>) {
        const arr = []
        for await (const val of iter) {
            arr.push(val)
        }
        return arr
    },
})
