import EtcdMesh from '../src'
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

const etcdOpts = {
    hosts: 'http://localhost:2379',
}

describe('test', function() {
    this.timeout(30000)

    let node1: EtcdMesh, node2: EtcdMesh
    before(async () => {
        node1 = new EtcdMesh({ etcdOpts }, api1)
        await new Promise(resolve => node1.once('ready', resolve))
        node2 = new EtcdMesh({ etcdOpts }, api2)
        await new Promise(resolve => node2.once('ready', resolve))
    })

    it(`simple async function`, async () => {
        const start = Date.now()
        for (const i in Array(500).fill(0)) {
            await node2.query(api1).testSimple()
        }
        console.log(`t1: ${(Date.now() - start) / 500}ms`)
        assert.equal(await node2.query(api1).testSimple(), 'test pass')
    })

    it(`this within function`, async () => {
        const start = Date.now()
        for (const i in Array(500).fill(0)) {
            await node2.query(api1).testThis()
        }
        console.log(`t2: ${(Date.now() - start) / 500}ms`)
        assert.equal(await node2.query(api1).testThis(), 'this test pass')
    })

    it(`nested function within object`, async () => {
        const start = Date.now()
        for (const i in Array(500).fill(0)) {
            await node2.query(api1).testNested()
        }
        console.log(`t3: ${(Date.now() - start) / 500}ms`)
        assert.equal(await node2.query(api1).testNested(), 'nested nesteded test pass')
    })

    it(`call from another node`, async () => {
        const start = Date.now()
        for (const i in Array(500).fill(0)) {
            await node1.query(api2).testSimple2()
        }
        console.log(`t4: ${(Date.now() - start) / 500}ms`)
        assert.equal(await node1.query(api2).testSimple2(), 'test pass again')
    })

    after(async () => {
        await node1.destroy()
        await node2.destroy()
        // FIXME:
        setTimeout(() => process.exit(0), 2000)
    })
})
