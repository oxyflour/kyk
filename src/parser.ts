import ts from 'typescript'
import { getSrvFuncName } from './utils';

// FIXME: internal in typescript
interface IntrinsicType extends ts.Type { intrinsicName: string }
interface TypeReferenceType extends ts.Type { typeArguments: ts.Type[] }

export interface ExportMember {
    id: number,
    required: boolean,
    member: ExportType,
    initializer?: string
}

export class ExportObject {
    constructor(
        public members: { [name: string]: ExportMember }) { }
}
export class ExportArray {
    constructor(
        public item: ExportType) { }
}
export class ExportMap {
    constructor(
        public key: 'string' | 'number',
        public value: ExportType) { }
}
export class ExportFunc {
    constructor(
        public args: ExportObject, public ret: ExportType,
        public opts: { requestStream: boolean, responseStream: boolean }) { }
}
export type ExportType = string | ExportFunc | ExportObject | ExportArray | ExportMap

const RENAME_TYPES = {
    buffer: 'bytes',
    string: 'string',
    number: 'float',
    boolean: 'bool',
    void: 'void',
    undefined: 'void',
    null: 'NullValue',
} as { [name: string]: string }

function formatTypes(types: ts.Type[], checker: ts.TypeChecker) {
    return types.map(type => checker.typeToString(type)).join('\nin ')
}

export function getDefaultExportType(file: string, opts: ts.CompilerOptions) {
    const program = ts.createProgram([file], opts),
        checker = program.getTypeChecker(),
        resolvedPath = require.resolve(file, { paths: [process.cwd()] }),
        sourceFile = resolvedPath && program.getSourceFile(resolvedPath as any),
        moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile),
        defaultExport = moduleSymbol &&
            checker.tryGetMemberInModuleExports(ts.InternalSymbolName.Default, moduleSymbol),
        exportType = defaultExport && sourceFile &&
            checker.getTypeOfSymbolAtLocation(defaultExport, sourceFile)
    if (!exportType) {
        throw Error(`no default export found for file "${file}"`)
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
                throw Error(`unknown type ${formatTypes(next, checker)}`)
            }
        } else if (symbol && symbol.escapedName === 'Array' && reference.typeArguments) {
            if (reference.typeArguments.length === 1) {
                const [argument] = reference.typeArguments
                return new ExportArray(parseExportType(argument, next))
            } else {
                throw Error(`array of types ${reference.typeArguments} not supported, type ${next.map(type => checker.typeToString(type)).join('\nin ')}`)
            }
        } else if ((type.flags & ts.TypeFlags.Object) && stringIndexed) {
            const valType = parseExportType(stringIndexed, next)
            if (valType instanceof ExportMap) {
                throw Error(`nested maps are not supported, type ${formatTypes(next, checker)}`)
            }
            return new ExportMap('string', valType)
        } else if ((type.flags & ts.TypeFlags.Object) && type.symbol && type.symbol.escapedName === 'Buffer') {
            return 'buffer'
        } else if ((type.flags & ts.TypeFlags.Object) && numberIndexed) {
            const valType = parseExportType(numberIndexed, next)
            if (valType instanceof ExportMap) {
                throw Error(`nested maps are not supported, type ${formatTypes(next, checker)}`)
            }
            return new ExportMap('number', valType)
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
            for (const symbol of type.getProperties()) {
                const isFuncion = symbol.valueDeclaration && ts.isFunctionLike(symbol.valueDeclaration)
                if (symbol.valueDeclaration && !(isClass && isFuncion)) {
                    const decl = symbol.valueDeclaration as ts.PropertyDeclaration,
                        initializer = decl.initializer && ts.transpile(decl.initializer.getFullText()),
                        memberType = (symbol as any).type || checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration),
                        member = parseExportType(memberType, next),
                        required = !isParentPartial && !decl.questionToken
                    result[symbol.escapedName.toString()] = { id: id ++, member, initializer, required }
                }
            }
            return new ExportObject(result)
        } else if (symbol && symbol.valueDeclaration && ts.isFunctionLike(symbol.valueDeclaration)) {
            const signatures = type.getCallSignatures()
            if (signatures.length === 1) {
                let requestStream = false
                const [signature] = signatures,
                    args = { } as { [name: string]: ExportMember },
                    { parameters } = signature,
                    firstParamType = parameters[0] &&
                        checker.getTypeOfSymbolAtLocation(parameters[0], parameters[0].valueDeclaration) as TypeReferenceType
                if (parameters.length === 1 && firstParamType && firstParamType.symbol &&
                        firstParamType.symbol.escapedName === 'AsyncIterableIterator') {
                    const member = parseExportType(firstParamType.typeArguments[0], next)
                    args.result = { id: 1, member, required: true }
                    requestStream = true
                } else {
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
                }
                const argsType = new ExportObject(args),
                    returnType = signature.getReturnType() as TypeReferenceType
                if (returnType.symbol && returnType.symbol.escapedName === 'Promise' && returnType.typeArguments) {
                    const [ret] = returnType.typeArguments as TypeReferenceType[]
                    return new ExportFunc(argsType, parseExportType(ret, next), { requestStream, responseStream: false })
                } else if (returnType.symbol && returnType.typeArguments &&
                        (returnType.symbol.escapedName === 'AsyncIterableIterator' || returnType.symbol.escapedName === 'AsyncGenerator')) {
                    let [ret] = returnType.typeArguments as TypeReferenceType[]
                    return new ExportFunc(argsType, parseExportType(ret, next), { requestStream, responseStream: true })
                } else {
                    throw Error(`return value is not an async function or iterator, type ${formatTypes(next, checker)}`)
                }
            } else {
                throw Error(`can not parse function type ${formatTypes(next, checker)}`)
            }
        } else {
            throw Error(`can not parse type ${formatTypes(next, checker)}`)
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

export function getProtoObject(file: string, api: any, opts: ts.CompilerOptions) {
    const exportType = getDefaultExportType(file, opts),
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
            for (const [name, { id, member, required, initializer }] of Object.entries(type.members)) {
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
            const [srvName, funcName] = getSrvFuncName(entry),
                requestType = `${srvName}KykReq`,
                responseType = `${srvName}KykRes`,
                methods = { [funcName]: { requestType, responseType, ...type.opts } }
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
