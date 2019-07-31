#!/usr/bin/env node

import path from 'path'
import prog from 'commander'
import Mesh, { MeshOptions } from './'

const pkg = require(path.join(__dirname, '..', 'package.json')),
    { env } = process,
    opts = { } as MeshOptions

env.KYKM_ETCD_OPTS && (opts.etcdOpts = JSON.parse(env.KYKM_ETCD_OPTS))
env.KYKM_GRPC_OPTS && (opts.grpcOpts = JSON.parse(env.KYKM_GRPC_OPTS))

prog.version(pkg.version)
    .command('serve [mods...]')
    .option('-n, --node-name <name>', 'mesh node name', undefined, env.KYKM_NODE_NAME)
    .option('-s, --announce-interval <seconds>', 'announce interval', parseInt, env.KYKM_ANNOUNCE_INTERVAL)
    .option('-e, --etcd-prefix <prefix>', 'etcd prefix', undefined, env.KYKM_ETCD_PREFIX)
    .option('-s, --etcd-lease <seconds>', 'etcd lease', parseInt, env.KYKM_ETCD_LEASE)
    .option('-l, --listen-addr <addr>', 'listen addr, default 0.0.0.0', undefined, env.KYKM_LISTEN_ADDR)
    .option('-p, --listen-port <port>', 'listen port, default random', parseInt, env.KYKM_LISTEN_PORT)
    .action(async (mods, args) => {
        try {
            require('ts-node/register')
            const node = new Mesh({ ...opts, ...args }),
                cwd = process.cwd()
            for (const mod of mods) {
                node.register(require.resolve(mod, { paths: [cwd] }))
            }
            await node.init()
            const { listenAddr, listenPort, nodeName } = node.opts
            console.log(`serving "${nodeName}" with ${node.entries.length} entries at ${listenAddr}:${listenPort}`)
        } catch (err) {
            console.error(err)
            process.exit(-1)
        }
    })

prog.command('call <method> [args...]')
    .option('-e, --etcd-prefix <prefix>', 'etcd prefix', undefined, env.KYKM_ETCD_PREFIX)
    .action(async (method: string, pars: string[], args) => {
        try {
            const api = new Mesh({ ...opts, ...args }).query() as any,
                fn = method.split('.').reduce((fn, name) => fn[name], api),
                ret = await fn(...pars.map(item => JSON.parse(item)))
            console.log(JSON.stringify(ret, null, 4))
            process.exit(0)
        } catch (err) {
            console.error(err)
            process.exit(-1)
        }
    })

prog.command('*')
    .action(() => {
        prog.outputHelp()
        process.exit(1)
    })

prog.parse(process.argv)
if (process.argv.length <= 2) {
    prog.outputHelp()
    process.exit(1)
}