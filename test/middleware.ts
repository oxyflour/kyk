import { GrpcContext } from '../'
import { AsyncFunction } from '../dist/utils'

export default async (ctx: GrpcContext, next: AsyncFunction<any>) => {
    console.log('req', ctx.call && ctx.call.request)
    await next()
    console.log('ret', ctx.ret && ctx.ret.result)
}
