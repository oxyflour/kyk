import * as assert from 'assert'

import EtcdMesh from '../src'
import api1 from './api1'
import api2 from './api2'

const etcdOpts = {
    hosts: 'http://localhost:2379',
}

describe('test', function() {
    this.timeout(30000)

    let node1: EtcdMesh, node2: EtcdMesh
    before(async () => {
        node1 = await new EtcdMesh({ etcdOpts }, api1).init()
        node2 = await new EtcdMesh({ etcdOpts }, api2).init()
    })

    it(`simple async function`, async () => {
        assert.equal(await node2.query(api1).testSimple('this'), 'test pass this')
    })

    it(`this within function`, async () => {
        assert.equal(await node2.query(api1).testThis(), 'this test pass this')
    })

    it(`nested function within object`, async () => {
        assert.equal(await node2.query(api1).testNested(), 'nested nesteded test pass nested')
    })

    it(`nested function within object2`, async () => {
        assert.equal(await node2.query(api1).nested.method(), 'nested')
    })

    it(`call with array`, async () => {
        assert.deepEqual(await node1.query(api2).testArray([5]), [6])
    })

    it(`call with wrong type`, async () => {
        try {
            await node1.query(api2).testArray('x' as any)
        } catch (err) {
            assert.equal(err.message, '.SrvTestArrayKykReq.arg: array expected')
        }
    })

    it(`call with map`, async () => {
        assert.deepEqual(await node1.query(api2).testMap(), { name: 1 })
    })

    after(async () => {
        await node1.destroy()
        await node2.destroy()
        // FIXME:
        setTimeout(() => process.exit(0), 2000)
    })
})
