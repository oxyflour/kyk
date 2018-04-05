export default {
    __filename,
    async testArray(arg: number[]) {
        return arg.map(num => num + 1)
    },
    async testMap() {
        return { name: 1 } as { [name: string]: number }
    },
}
