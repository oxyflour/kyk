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

describe('test', async function() {
    this.timeout(30000)

    let node1: EtcdMesh, node2: EtcdMesh
    before(async () => {
        node1 = new EtcdMesh({ etcdOpts }, api1)
        await new Promise(resolve => node1.once('ready', resolve))
        node2 = new EtcdMesh({ etcdOpts }, api2)
        await new Promise(resolve => node2.once('ready', resolve))
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

    after(async () => {
        node1.destroy()
        node2.destroy()
    })
})
