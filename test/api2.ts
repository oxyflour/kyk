export default {
    __filename,
    async testArray(arg: number[]) {
        return arg.map(num => num + 1)
    },
    async testMap() {
        return { name: 1 } as { [name: string]: number }
    },
    testSync() {
        return 'x'
    },
    throwSomeError() {
        if (1) {
            throw Error(`boom`)
        } else {
            return 0
        }
    }
}
