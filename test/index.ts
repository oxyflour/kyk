import * as assert from 'assert'

import EtcdMesh from '../src'
import mkAPI1 from './api1'
import API2 from './api2'

const hosts = process.env.ETCD_HOSTS || 'http://localhost:2379',
    opts = { etcdOpts: { hosts } }

const API1 = mkAPI1('node1')
describe('test', function() {
    this.timeout(60000)

    let node1: EtcdMesh, node2a: EtcdMesh, node2b: EtcdMesh
    before(async () => {
        node1 = await new EtcdMesh(opts, API1).init()
        node2a = await new EtcdMesh(opts, API2).init()
        node2b = await new EtcdMesh(opts, API2).init()
        api1 = node2a.query(API1)
        api2 = node1.query(API2)
    })

    let api1: typeof API1, api2: typeof API2
    it(`simple async function`, async () => {
        assert.equal(await api1.testSimple('this'), 'test pass this')
    })

    it(`this within function`, async () => {
        assert.equal(await api1.testThis(), 'this test pass this')
    })

    it(`nested function within object`, async () => {
        assert.equal(await api1.testNested(), 'nested nesteded test pass nested')
    })

    it(`nested function within object2`, async () => {
        assert.equal(await api1.nested.method(), 'nested')
    })

    it(`call indiced function`, async () => {
        assert.equal(await api1.map['node1'].ok(), 'node1 ok')
    })

    it(`call with array`, async () => {
        assert.deepEqual(await api2.testArray([5]), [6])
    })

    it(`call with wrong type`, async () => {
        try {
            await api2.testArray('x' as any)
        } catch (err) {
            assert.equal(err.message, '.SrvTestArrayKykReq.arg: array expected')
        }
    })

    it(`call with map`, async () => {
        assert.deepEqual(await api2.testMap(), { name: 1 })
    })

    it(`call with void`, async () => {
        assert.equal(await api2.testVoid(), undefined)
    })

    it(`call with exception`, async () => {
        try {
            await api2.throwSomeError()
        } catch (err) {
            assert.equal(err.message, '2 UNKNOWN: boom')
        }
    })

    it(`call with partial class`, async () => {
        assert.deepEqual(await api2.testClass({ }), { a: 2, b: 'b', c: [ ] })
        assert.deepEqual(await api2.testClass({ a: 1, c: ['c'] }), { a: 1, b: 'b', c: ['c'] })
    })

    it(`call with default parameters`, async () => {
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    it(`call with new node`, async () => {
        await node2a.destroy()
        await new Promise(resolve => setTimeout(resolve, 2000))
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    after(async () => {
        await Promise.all([
            node1.destroy(),
            node2b.destroy(),
        ])
    })
})
