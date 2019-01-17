#!/usr/bin/env

const Mesh = require('./dist').default,
    [, , api] = process.argv,
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

new Mesh(opts, require(api).default).init().catch(err => {
    console.error(err)
    process.exit(-1)
})
