import makeAPI from '../../src/web'
import * as assert from 'assert'

import Api2 from '../node/api2'
import { RSA_PKCS1_OAEP_PADDING } from 'constants'

describe('test', function() {
    this.timeout(60000)

    const api2 = makeAPI<typeof Api2>('http://127.0.0.1:8080')

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
            assert.equal(err.message, '.SrvTestArrayReq.arg: array expected')
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
            assert.equal(err.message, 'boom')
        }
    })

    it(`should work with optional values`, async () => {
        assert.equal(await api2.testOptional(), '')
        assert.equal(await api2.testOptional('x'), 'x')
    })

    it(`should work with partial class`, async () => {
        assert.deepEqual(await api2.testClass({ }), { a: 2, b: 'b', c: [ ], d: 0 })
        assert.deepEqual(await api2.testClass({ a: 1, c: ['c'] }), { a: 1, b: 'b', c: ['c'], d: 0 })
    })

    it(`should work with default parameters`, async () => {
        assert.equal(await api2.testDefaultParameters(1), '1x')
        assert.equal(await api2.testDefaultParameters(1, 'y'), '1y')
    })

    it(`should work with recursive type`, async () => {
        assert.deepEqual(await api2.testRecursive(), [{ children: [{ title: 'y', children: [] }], title: 'x' }])
    })

    it(`should work with returned stream`, async () => {
        const arr = []
        for await (const i of api2.returnStream()) {
            arr.push(i)
        }
        assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7, 8, 9])
    })

    this.afterAll(async () => {
        await api2.quit(5000)
    })
})
