#!/usr/bin/env node

import path from 'path'
import program from 'commander'
import ts from 'typescript'
import fs from 'mz/fs'
import URL from 'url'
import { isMaster, fork } from 'cluster'
import { GrpcWebProxy } from '@dataform/grpc-web-proxy'
import * as tsNode from 'ts-node'

import { GrpcServer, getModuleAndDeclaration, loadTsConfig, GrpcClient } from './grpc'

const { version, name } = require(path.join(__dirname, '..', 'package.json'))
program.version(version).name(name)

function resolveModule(src: string) {
    try {
        return require.resolve(src)
    } catch (err) {
        return require.resolve(path.resolve(src), { paths: [process.cwd()] })
    }
}

function exitOnError<F extends (...args: any[]) => Promise<any>>(fn: F) {
    return (async (...args: any[]) => {
        try {
            await fn(...args)
        } catch (err) {
            console.error(err)
            process.exit(-1)
        }
    }) as F
}

program.command('call <url> [args...]')
    .option('-g, --return-generator', 'return generator')
    .option('-j, --input-json', 'parse args as json')
    .option('-s, --output-json', 'print output as json')
    .option('--project <file>', 'tsconfig.json path', path.join(__dirname, '..', 'tsconfig.json'))
    .action(exitOnError(async (url, args, opts) => {
        const { host, path } = URL.parse(url),
            client = new GrpcClient(host || 'localhost:5000'),
            func = (path || '/').substr(1).split('/').reduce((func: any, part: string) => func[part], client.query())
        if (opts.returnGenerator) {
            for await (const ret of func(...args)) {
                console.log(opts.outputJson ? JSON.stringify(ret) : ret)
            }
        } else {
            const ret = await func(...args.map((arg: string) => opts.inputJson ? JSON.parse(arg) : arg))
            console.log(opts.outputJson ? JSON.stringify(ret) : ret)
        }
    }))

program.command('serve [args...]')
    .option('-l, --listen-addr <addr>', 'listen addr, default 0.0.0.0', process.env.KYK_LISTEN_ADDR || '0.0.0.0')
    .option('-p, --listen-port <port>', 'listen port, default 5000', process.env.KYK_LISTEN_PORT || '5000')
    .option('-m, --middleware <file>', 'middleware path', (val, all) => all.concat(val), `${process.env.KYK_MIDDLEWARES || ''}`.split(''))
    .option('-w, --watch', 'keep watching')
    .option('--project <file>', 'tsconfig.json path', path.join(__dirname, '..', 'tsconfig.json'))
    .option('--proxy-port <port>', 'proxy port, default 8080', process.env.KYK_PROXY_PORT || '8080')
    .option('--proxy-mode <mode>', 'proxy mode, default http1-insecure', process.env.KYK_PROXY_MODE || 'http1-insecure')
    .action(exitOnError(async (args, opts) => {
        const tsOpts = loadTsConfig(opts.project)
        tsNode.register(tsOpts)
        async function start() {
            const server = new GrpcServer()
            for (const arg of args) {
                const src = resolveModule(arg),
                    { mod, decl } = getModuleAndDeclaration(src, server)
                server.register(mod, decl)
            }
            for (const mod of opts.middleware) {
                server.use(require(resolveModule(mod)).default)
            }
            server.start(`${opts.listenAddr}:${opts.listenPort}`, opts.grpcOpts)
            console.log(`INFO: grpc server started at ${opts.listenAddr}:${opts.listenPort}`)
            return server
        }

        const watcher = { resolve: () => { } }
        async function startAndWatch() {
            const files = args.map((arg: string) => resolveModule(arg)),
                prog = ts.createProgram(files, tsOpts)
            for (const { fileName } of prog.getSourceFiles()) {
                // we will ignore files in node_modules
                if (!fileName.includes('node_modules') && await fs.exists(fileName)) {
                    console.log(`INFO: watching ${fileName}`)
                    fs.watchFile(fileName, () => watcher.resolve())
                }
            }
            while (true) {
                try {
                    const server = await start()
                    console.log(`INFO: waiting for file changes...`)
                    await new Promise(resolve => watcher.resolve = resolve)
                    console.log(`INFO: reloading service...`)
                    await new Promise(resolve => setTimeout(resolve, 500))
                    await server.destroy(0)
                } catch (err) {
                    console.error(err)
                    console.log(`INFO: waiting for file changes...`)
                    await new Promise(resolve => watcher.resolve = resolve)
                }
            }
        }

        if (isMaster) {
            if (opts.watch) {
                await startAndWatch()
            } else {
                await start()
            }
            fork()
        } else {
            new GrpcWebProxy({
                backend: `http://127.0.0.1:${opts.listenPort}`,
                mode: opts.proxyMode,
                port: opts.proxyPort,
            })
            console.log(`INFO: grpc proxy started at ${opts.listenAddr}:${opts.proxyPort}`)
        }
    }))

program.on('command:*', () => {
    program.outputHelp()
    process.exit(1)
})

program.parse(process.argv)
if (process.argv.length <= 2) {
    program.outputHelp()
    process.exit(1)
}
