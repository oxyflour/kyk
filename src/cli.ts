#!/usr/bin/env node

import path from 'path'
import prog from 'commander'
import Mesh, { MeshOptions } from './'

const pkg = require(path.join(__dirname, '..', 'package.json')),
    { env } = process,
    opts = { } as MeshOptions

env.KYKMSH_ETCD_OPTS && (opts.etcdOpts = JSON.parse(env.KYKMSH_ETCD_OPTS))
env.KYKMSH_GRPC_OPTS && (opts.grpcOpts = JSON.parse(env.KYKMSH_GRPC_OPTS))

prog.version(pkg.version)
    .command('serve [mods...]')
    .option('-n, --node-name <name>', 'mesh node name', undefined, env.KYKMSH_NODE_NAME)
    .option('-s, --announce-interval <seconds>', 'announce interval', parseInt, env.KYKMSH_ANNOUNCE_INTERVAL)
    .option('-e, --etcd-prefix <prefix>', 'etcd prefix', undefined, env.KYKMSH_ETCD_PREFIX)
    .option('-s, --etcd-lease <seconds>', 'etcd lease', parseInt, env.KYKMSH_ETCD_LEASE)
    .option('-l, --listen-addr <addr>', 'listen addr, default 0.0.0.0', undefined, env.KYKMSH_LISTEN_ADDR)
    .option('-p, --listen-port <port>', 'listen port, default random', parseInt, env.KYKMSH_LISTEN_PORT)
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
            console.log(`serving "${nodeName}" at ${listenAddr}:${listenPort}, ${node.entries.length} entries`)
        } catch (err) {
            console.error(err)
            process.exit(-1)
        }
    })

prog.command('call <method> [args...]')
    .action(async (method: string, args: string[]) => {
        try {
            const fn = method.split('.').reduce((fn, name) => fn[name], new Mesh(opts).query() as any),
                ret = await fn(...args.map(item => JSON.parse(item)))
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
