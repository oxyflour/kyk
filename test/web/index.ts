import makeAPI from '../../src/web'
import * as assert from 'assert'

import Api2 from '../node/api2'

describe('test', function() {
    const api2 = makeAPI<typeof Api2>('https://dev.yff.me:8443')

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
            assert.equal(err.message, 'boom')
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
})
