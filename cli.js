#!/usr/bin/env node

require('ts-node/register')
const Mesh = require('./dist').default,
    [, , action, ...params] = process.argv,
    { env } = process,
    opts = { }

env.KYKMSH_NODE_NAME   && (opts.nodeName   = env.KYKMSH_NODE_NAME)
env.KYKMSH_ETCD_PREFIX && (opts.etcdPrefix = env.KYKMSH_ETCD_PREFIX)
env.KYKMSH_ETCD_OPTS   && (opts.etcdOpts   = JSON.parse(env.KYKMSH_ETCD_OPTS))
env.KYKMSH_ETCD_LEASE  && (opts.etcdLease  = parseInt(env.KYKMSH_ETCD_LEASE))
env.KYKMSH_ANNOUNCE_INTERVAL  && (opts.announceInterval  = parseInt(env.KYKMSH_ANNOUNCE_INTERVAL))
env.KYKMSH_GRPC_OPTS   && (opts.grpcOpts   = JSON.parse(env.KYKMSH_GRPC_OPTS))
env.KYKMSH_LISTEN_PORT && (opts.listenPort = parseInt(KYKMSH_LISTEN_PORT))
env.KYKMSH_LISTEN_ADDR && (opts.listenAddr = env.KYKMSH_LISTEN_ADDR)

if (action === 'serve') {
    const node = new Mesh(opts)
    for (const mod of params) {
        node.register(mod)
    }
    node.init().catch(err => {
        console.error(err)
        process.exit(-1)
    })
} else if (action === 'call') {
    const [method, ...args] = params,
        fn = method.split('.').reduce((fn, name) => fn[name], new Mesh(opts).query())
    fn(...args.map(item => JSON.parse(item))).then(ret => {
        console.log(ret)
        process.exit(0)
    }).catch(err => {
        console.error(err)
        process.exit(-1)
    })
} else {
    console.error(`kykm serve [...module] \nkykm call <method> [...args]`)
    process.exit(-1)
}
