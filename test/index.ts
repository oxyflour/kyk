import KyokoMesh from '../src'
import * as assert from 'assert'

const api1 = {
    async testSimple() {
        return 'test pass'
    },
    async testThis() {
        return 'this ' + await this.testSimple()
    },
    async testNested() {
        return [
            await this.nested.method(),
            await this.nested.nesteded.method(),
            await this.testSimple(),
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
}

const api2 = {
    async testSimple2() {
        return 'test pass again'
    },
}

describe('test', async () => {
    let root: KyokoMesh, node1: KyokoMesh, node2: KyokoMesh
    before(async () => {
        root = new KyokoMesh()
        await new Promise(resolve => root.once('listening', resolve))

        const url = `http://localhost:${root.network.servers.http.address().port}`
        node1 = new KyokoMesh(url, api1)
        node2 = new KyokoMesh(url, api2)
        await Promise.all([node1, node2].map(node => {
            return new Promise(resolve => node.once('upstream-connected', resolve))
        }))
    })

    it(`simple async function`, async () => {
        assert.equal(await node2.query(api1).testSimple(), 'test pass')
    })

    it(`this within function`, async () => {
        assert.equal(await node2.query(api1).testThis(), 'this test pass')
    })

    it(`nested function within object`, async () => {
        assert.equal(await node2.query(api1).testNested(), 'nested nesteded test pass')
    })

    it(`call from another node`, async () => {
        assert.equal(await node1.query(api2).testSimple2(), 'test pass again')
    })

    it(`dir from root`, () => {
        assert.deepEqual(root.dir('nested'), ['method', 'nesteded/'])
    })

    after(() => {
        root.destroy()
        node1.destroy()
        node2.destroy()
    })
})
