import * as path from 'path'
import * as ts from 'typescript'
import * as protobuf from 'protobufjs'

import grpc from 'grpc'

// FIXME: internal in typescript
interface IntrinsicType extends ts.Type { intrinsicName: string }
interface TypeReferenceType extends ts.Type { typeArguments: ts.Type[] }
interface UnionType extends ts.Type { types: ts.Type[] }

export interface ExportMember {
    id: number,
    required: boolean,
    member: ExportType,
    initializer?: string
}

export class ExportObject {
    constructor(
        public members: { [name: string]: ExportMember },
        private type = 'object') { }
}
export class ExportArray {
    constructor(
        public item: ExportType,
        private type = 'array') { }
}
export class ExportMap {
    constructor(
        public key: 'string' | 'number',
        public value: ExportType,
        private type = 'map') { }
}
export class ExportFunc {
    constructor(
        public args: ExportObject,
        public ret: ExportType,
        private type = 'function') { }
}
export type ExportType = string | ExportFunc | ExportObject | ExportArray | ExportMap

const RENAME_TYPES = {
    string: 'string',
    number: 'float',
    boolean: 'bool',
    void: 'void',
    undefined: 'void',
    null: 'NullValue',
} as { [name: string]: string }

export function getDefaultExportType(file: string) {
    const opts = { module: ts.ModuleKind.CommonJS },
        program = ts.createProgram([file], opts),
        checker = program.getTypeChecker(),
        resolvedPath = file.replace(/\\/g, '/').toLowerCase(),
        sourceFile = program.getSourceFileByPath(resolvedPath as any),
        moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile),
        defaultExport = moduleSymbol &&
            checker.tryGetMemberInModuleExports(ts.InternalSymbolName.Default, moduleSymbol),
        exportType = defaultExport && sourceFile &&
            checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
    if (!exportType) {
        throw Error(`not default export found for ${file}`)
    }

    function parseExportType(type: ts.Type, stack: ts.Type[]): ExportType {
        const next = [type].concat(stack),
            intrinsic = type as IntrinsicType,
            reference = type as TypeReferenceType,
            stringIndexed = type.getStringIndexType(),
            numberIndexed = type.getNumberIndexType(),
            { symbol } = type
        if (intrinsic.intrinsicName) {
            if (intrinsic.intrinsicName !== 'unknown') {
                return intrinsic.intrinsicName
            } else {
                throw Error(`unknown type ${next.map(type => checker.typeToString(type)).join('\nin ')}`)
            }
        } else if (symbol && symbol.escapedName === 'Array' && reference.typeArguments) {
            if (reference.typeArguments.length === 1) {
                const [argument] = reference.typeArguments
                return new ExportArray(parseExportType(argument, next))
            } else {
                throw Error(`array of types ${reference.typeArguments} not supported, type ${next.map(type => checker.typeToString(type)).join('\nin ')}`)
            }
        } else if ((type.flags & ts.TypeFlags.Object) && stringIndexed) {
            return new ExportMap('string', parseExportType(stringIndexed, next))
        } else if ((type.flags & ts.TypeFlags.Object) && numberIndexed) {
            return new ExportMap('number', parseExportType(numberIndexed, next))
        } else if ((type.flags & ts.TypeFlags.Object) &&
                type.aliasSymbol && type.aliasSymbol.escapedName === 'Partial' &&
                type.aliasTypeArguments && type.aliasTypeArguments.length === 1) {
            const [typeArgument] = type.aliasTypeArguments
            return parseExportType(typeArgument, next)
        } else if ((type.flags & ts.TypeFlags.Object) && symbol && symbol.members) {
            const isClass = symbol.valueDeclaration && ts.isClassLike(symbol.valueDeclaration),
                result = { } as { [name: string]: ExportMember },
                [parent] = stack,
                isParentPartial = parent && parent.aliasSymbol && parent.aliasSymbol.escapedName === 'Partial'
            let id = 1
            symbol.members.forEach((symbol, key) => {
                const isFuncion = symbol.valueDeclaration && ts.isFunctionLike(symbol.valueDeclaration)
                if (symbol.valueDeclaration && !(isClass && isFuncion)) {
                    const decl = symbol.valueDeclaration as ts.PropertyDeclaration,
                        initializer = decl.initializer && ts.transpile(decl.initializer.getFullText()),
                        type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration),
                        member = parseExportType(type, next),
                        required = !isParentPartial && !decl.questionToken
                    result[symbol.escapedName.toString()] = { id: id ++, member, initializer, required }
                }
            })
            return new ExportObject(result)
        } else if (symbol && symbol.valueDeclaration && ts.isFunctionLike(symbol.valueDeclaration)) {
            const signatures = type.getCallSignatures()
            if (signatures.length === 1) {
                const [signature] = signatures,
                    args = { } as { [name: string]: ExportMember }
                for (const [index, symbol] of signature.parameters.entries()) {
                    if (symbol.valueDeclaration) {
                        const decl = symbol.valueDeclaration as ts.ParameterDeclaration,
                            initializer = decl.initializer && ts.transpile(decl.initializer.getFullText()),
                            type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration),
                            member = parseExportType(type, next),
                            required = !decl.questionToken
                        args[symbol.escapedName.toString()] = { id: index + 1, member, initializer, required }
                    }
                }
                const returnType = signature.getReturnType() as TypeReferenceType
                if (returnType.symbol && returnType.symbol.escapedName === 'Promise' && returnType.typeArguments) {
                    const [argument] = returnType.typeArguments
                    return new ExportFunc(new ExportObject(args), parseExportType(argument, next))
                } else {
                    throw Error(`return value is not an async function, type ${next.map(type => checker.typeToString(type)).join('\nin ')}`)
                }
            } else {
                throw Error(`can not parse function type ${next.map(type => checker.typeToString(type)).join('\nin ')}`)
            }
        } else {
            throw Error(`can not parse type "${next.map(type => checker.typeToString(type)).join('\nin ')}"`)
        }
    }

    const { symbol } = exportType
    if (symbol && symbol.valueDeclaration && ts.isFunctionLike(symbol.valueDeclaration)) {
        const [signature] = exportType.getCallSignatures()
        return parseExportType(signature.getReturnType(), []) as ExportObject
    } else {
        return parseExportType(exportType, []) as ExportObject
    }
}

export function getProtoObject(file: string, api = { } as any) {
    const exportType = getDefaultExportType(file),
        nested = { } as any
    
    function proto(type: ExportType): any {
        if (typeof type === 'string') {
            if (RENAME_TYPES[type]) {
                return RENAME_TYPES[type]
            } else {
                throw Error(`unknown type ${type}`)
            }
        } else if (type instanceof ExportObject) {
            const fields = { } as any,
                nested = { } as any
            for (const [index, [name, { id, member, required, initializer }]] of Object.entries(type.members).entries()) {
                let type = proto(member)
                if (typeof type !== 'string') {
                    const typeName = `${name.replace(/^\w/, c => c.toUpperCase())}Type`,
                        typeBody = type
                    nested[type = typeName] = typeBody
                }
                const rule = member instanceof ExportArray ? 'repeated' : required ? 'required' : 'optional',
                    keyType = member instanceof ExportMap ? proto(member.key) : undefined,
                    options = { } as any
                if (initializer) {
                    options.default = Function(`return ${initializer}`)()
                }
                if (type !== 'void') {
                    fields[name] = { id, keyType, options, rule, type }
                }
            }
            return { fields, nested }
        } else if (type instanceof ExportArray) {
            return proto(type.item)
        } else if (type instanceof ExportMap) {
            return proto(type.value)
        } else {
            throw Error(`can not convert type ${type} to proto`)
        }
    }

    function walk(entry: string, type: ExportType) {
        if (type instanceof ExportFunc) {
            const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
                funcName = path.basename(entry),
                requestType = `${srvName}KykReq`,
                responseType = `${srvName}KykRes`,
                methods = { [funcName]: { requestType, responseType } }
            nested[srvName] = { methods }
            nested[requestType] = proto(type.args)
            nested[responseType] = proto(new ExportObject({ result: { id: 1, member: type.ret, required: true } }))
        } else if (type instanceof ExportObject) {
            for (const [name, { member }] of Object.entries(type.members)) {
                walk(entry + '/' + name, member)
            }
        } else if (type instanceof ExportMap) {
            const value = entry.split('/').reduce((val, key) => val && val[key], api)
            for (const name of Object.keys(value || { })) {
                walk(entry + '/' + name, type.value)
            }
        }
    }

    for (const [entry, { member }] of Object.entries(exportType.members)) {
        walk(entry, member)
    }
    return { nested }
}

function makeClient(proto: any, srvName: string, host: string) {
    const root = protobuf.Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        Client = desc[srvName] as typeof grpc.Client
    return new Client(host, grpc.credentials.createInsecure())
}

export async function callService(entry: string, host: string, args: any[],
        proto: any, cache = { } as { [key: string]: grpc.Client }) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        cacheKey = `${srvName}/$/${host}`,
        client = cache[cacheKey] || (cache[cacheKey] = makeClient(proto, srvName, host)),
        reqFields = proto.nested[`${srvName}KykReq`].fields,
        resFields = proto.nested[`${srvName}KykRes`].fields,
        request = resFields.json ? { json: JSON.stringify(args) } :
            Object.keys(reqFields).reduce((req, key, index) => ({ ...req, [key]: args[index] }), { })
    return await new Promise((resolve, reject) => {
        (client as any)[funcName](request, (err: Error, ret: any) => {
            err ? reject(err) : resolve(resFields.json ? (ret.json ? JSON.parse(ret.json) : undefined) : ret.result)
        })
    })
}

const JSON_TYPE = { fields: { json: { type: 'string', id: 1 } } }
export function makeService(entry: string, func: (...args: any[]) => Promise<any>, types?: any) {
    const srvName = ('Srv/' + entry).replace(/\/(\w)/g, (_, c) => c.toUpperCase()).replace(/\W/g, '_'),
        funcName = path.basename(entry),
        requestType = `${srvName}KykReq`,
        responseType = `${srvName}KykRes`,
        rpc = { methods: { [funcName]: { requestType, responseType } } },
        proto = types || { nested: { [requestType]: JSON_TYPE, [responseType]: JSON_TYPE, [srvName]: rpc } },
        root = protobuf.Root.fromJSON(proto),
        desc = grpc.loadObject(root),
        service = (desc[srvName] as any).service,
        resFields = proto.nested[responseType].fields
    const fn = ({ request }: grpc.ServerUnaryCall, callback: grpc.sendUnaryData) => {
        func(...(resFields.json ? JSON.parse(request.json) : Object.values(request)))
            .then(result => callback(null, resFields.json ? { json: JSON.stringify(result) } : { result }))
            .catch(error => callback(error, undefined))
    }
    return { proto, service, impl: { [funcName]: fn } }
}
