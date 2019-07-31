import Mesh from '../'

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
