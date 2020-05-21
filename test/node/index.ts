import path from 'path'
import * as assert from 'assert'

import Mesh from '../../src'
import Api1 from './api1'
import Api2 from './api2'

const mod1 = path.join(__dirname, 'api1'),
    mod2 = path.join(__dirname, 'api2')

describe('test', function() {
    this.timeout(60000)

    const node1 = new Mesh({ nodeName: 'node1' }).register(mod1),
        node2 = new Mesh().register(mod2),
        node3 = new Mesh().register(mod2),
        api1 = node2.query<ReturnType<typeof Api1>>(),
        api2 = node1.query<typeof Api2>()
    before(async () => {
        await Promise.all([node1.init(), node2.init()])
    })

    it(`should work with simple async function`, async () => {
        assert.equal(await api1.testSimple('this'), 'test pass this')
    })

    it(`should work with this within function`, async () => {
        assert.equal(await api1.testThis(), 'this test pass this')
    })

    it(`should work with nested function within object`, async () => {
        assert.equal(await api1.testNested(), 'nested nesteded test pass nested')
    })

    it(`should work with nested function within object2`, async () => {
        assert.equal(await api1.nested.method(), 'nested')
    })

    it(`should call indiced function`, async () => {
        assert.equal(await api1.map['node1'].ok(), 'node1 ok')
    })

    it(`should work with generics`, async () => {
        assert.deepEqual(await api1.testGenericArray(), [0])
        assert.deepEqual(await api1.testGenericMap(), { a: 0, b: '' })
    })

    it(`should work with recursive`, async () => {
        assert.deepEqual(await api1.testRecursive(), [{ children: [] }])
    })

    it(`should work with middleware`, async () => {
        const ret = [] as any[]
        node1.use(async (ctx, next) => {
            ret.push({ name: '1', args: ctx.call.request })
            await next()
            ret.push({ name: '4', ret: ctx.ret })
        }).use(async (ctx, next) => {
            ret.push({ name: '2', args: ctx.call.request })
            await next()
            ret.push({ name: '3', ret: ctx.ret })
        })
        assert.equal(await api1.testSimple('that'), 'test pass that')
        assert.deepEqual(ret, [
            { name: '1', args: { you: 'that' } },
            { name: '2', args: { you: 'that' } },
            { name: '3', ret: { result: 'test pass that' } },
            { name: '4', ret: { result: 'test pass that' } }
        ])
    })

    it(`should work with array`, async () => {
        assert.deepEqual(await api2.testArray([5]), [6])
    })

    it(`should work with buffer`, async () => {
        assert.deepEqual(await api2.testBuffer(Buffer.from('you')), Buffer.from('ret you'))
    })

    it(`should throw error with wrong argument type`, async () => {
        try {
            await api2.testArray('x' as any)
        } catch (err) {
            assert.equal(err.message, '.SrvTestArrayKykReq.arg: array expected')
        }
    })

    it(`should work with map`, async () => {
        assert.deepEqual(await api2.testMap(), { name: 1 })
    })

    it(`should work with void return value`, async () => {
        assert.equal(await api2.testVoid(), undefined)
    })

    it(`should throw some exception`, async () => {
        try {
            await api2.throwSomeError()
        } catch (err) {
            assert.equal(err.message, '2 UNKNOWN: boom')
        }
    })

    it(`should work with partial class`, async () => {
        assert.deepEqual(await api2.testClass({ }), { a: 2, b: 'b', c: [ ] })
        assert.deepEqual(await api2.testClass({ a: 1, c: ['c'] }), { a: 1, b: 'b', c: ['c'] })
    })

    it(`should work with default parameters`, async () => {
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    it(`should work with returned async iterator`, async () => {
        const arr = []
        for await (const item of api2.returnStream()) {
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

    it(`should work with new joined node`, async () => {
        await node2.destroy(0)
        await node3.init()
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    after(async () => {
        await Promise.all([
            node1.destroy(0),
            node3.destroy(0),
        ])
    })
})
