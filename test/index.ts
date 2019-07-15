import * as assert from 'assert'

import Mesh from '../src'
import mkAPI1 from './api1'
import API2 from './api2'

const API1 = mkAPI1('node1')
describe('test', function() {
    this.timeout(60000)

    const node1 = new Mesh().register(API1),
        node2a = new Mesh().register(API2),
        node2b = new Mesh().register(API2),
        api1 = node2a.query(API1),
        api2 = node1.query(API2)
    before(async () => {
        await Promise.all([node1.init(), node2a.init(), node2b.init()])
    })

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

    it(`should work with returned async iterator`, async () => {
        const arr = []
        for await (const item of api1.returnStream()) {
            arr.push(item)
        }
        assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    })

    it(`should work passing async iterator`, async () => {
        async function *input() {
            for (let i = 1; i < 10; i ++) {
                await new Promise(resolve => setTimeout(resolve, 100))
                yield i
            }
        }
        const arr = await api1.inputStream(input())
        assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    })

    it(`call with new node`, async () => {
        await node2a.destroy(0)
        await new Promise(resolve => setTimeout(resolve, 2000))
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    after(async () => {
        await Promise.all([
            node1.destroy(0),
            node2b.destroy(0),
        ])
    })
})
