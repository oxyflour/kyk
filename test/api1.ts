import { GrpcStream } from "../src/utils"

export default (id = 'xx') => ({
    __filename,
    map: {
        [id]: {
            async ok() {
                return id + ' ok'
            }
        }
    },
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
    async beginTransport(flag: string) {
        const stream = new GrpcStream<{ msg: string }>()
        stream.write({ msg: flag })
        stream.on('data', data => stream.write(data))
        setTimeout(() => stream.write({ msg: 'c' }), 1000)
        return stream
    },
})
