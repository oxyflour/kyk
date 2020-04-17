#!/usr/bin/env node

import path from 'path'
import prog from 'commander'
import Mesh, { MeshOptions, GrpcServer } from './'
import { getModuleAndDeclaration } from './parser'

const pkg = require(path.join(__dirname, '..', 'package.json')),
    { env } = process,
    opts = { } as MeshOptions

env.KYKM_ETCD_OPTS && (opts.etcdOpts = JSON.parse(env.KYKM_ETCD_OPTS))
env.KYKM_GRPC_OPTS && (opts.grpcOpts = JSON.parse(env.KYKM_GRPC_OPTS))

function resolveModule(src: string) {
    try {
        return require.resolve(src)
    } catch (err) {
        return require.resolve(path.resolve(src), { paths: [process.cwd()] })
    }
}

function parseIntWithRadix10(val: string) {
    return parseInt(val)
}

prog.version(pkg.version)
    .name('kykm')
    .command('serve [mods...]')
    .option('-n, --node-name <name>', 'mesh node name', undefined, env.KYKM_NODE_NAME)
    .option('-s, --announce-interval <seconds>', 'announce interval', parseIntWithRadix10, env.KYKM_ANNOUNCE_INTERVAL)
    .option('-e, --etcd-prefix <prefix>', 'etcd prefix', undefined, env.KYKM_ETCD_PREFIX)
    .option('-s, --etcd-lease <seconds>', 'etcd lease', parseIntWithRadix10, env.KYKM_ETCD_LEASE)
    .option('-l, --listen-addr <addr>', 'listen addr, default 0.0.0.0', undefined, env.KYKM_LISTEN_ADDR)
    .option('-p, --listen-port <port>', 'listen port, default random', parseIntWithRadix10, env.KYKM_LISTEN_PORT)
    .option('-m, --middleware <file>', 'middleware path', (val, all) => all.concat(val), [])
    .option('-P, --project <file>', 'tsconfig.json path')
    .action(async (mods, args) => {
        try {
            if (args.project) {
                process.env.TS_NODE_PROJECT = args.project
            }
            require('ts-node/register')
            const node = new Mesh({ ...opts, ...args })
            for (const mod of mods) {
                node.register(resolveModule(mod))
            }
            for (const mod of args.middleware) {
                node.use(require(resolveModule(mod)).default)
            }
            await node.init()
            const { listenAddr, listenPort, nodeName } = node.opts
            console.log(`serving "${nodeName}" with ${node.entries.length} entries at ${listenAddr}:${listenPort}`)
        } catch (err) {
            console.error(err)
            process.exit(-1)
        }
    })

prog.command('start [mods...]')
    .option('-l, --listen-addr <addr>', 'listen addr, default 0.0.0.0', val => val, env.KYKM_LISTEN_ADDR || '0.0.0.0')
    .option('-p, --listen-port <port>', 'listen port, default 5000', parseIntWithRadix10, env.KYKM_LISTEN_PORT || 5000)
    .option('-m, --middleware <file>', 'middleware path', (val, all) => all.concat(val), [])
    .option('-P, --project <file>', 'tsconfig.json path')
    .action(async (mods, args) => {
        try {
            if (args.project) {
                process.env.TS_NODE_PROJECT = args.project
            }
            require('ts-node/register')
            const server = new GrpcServer()
            for (const mod of mods) {
                const src = resolveModule(mod),
                    api = getModuleAndDeclaration(src, server)
                server.register(api.mod, api.decl)
            }
            for (const mod of args.middleware) {
                server.use(require(resolveModule(mod)).default)
            }
            server.start(`${args.listenAddr}:${args.listenPort}`, opts.grpcOpts)
            console.log(`grpc server started at ${args.listenAddr}:${args.listenPort}`)
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

prog.on('command:*', () => {
    prog.outputHelp()
    process.exit(1)
})

prog.parse(process.argv)
if (process.argv.length <= 2) {
    prog.outputHelp()
    process.exit(1)
}
