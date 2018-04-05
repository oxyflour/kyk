import * as ts from 'typescript'
import * as fs from 'fs'
import * as path from 'path'

// FIXME: internal in typescript
interface IntrinsicType extends ts.Type { intrinsicName: string }
interface TypeReferenceType extends ts.Type { typeArguments: ts.Type[] }

export class ExportObject { constructor(public members: { [name: string]: ExportType }, private type = 'object') { } }
export class ExportArray { constructor(public item: ExportType, private type = 'array') { } }
export class ExportMap { constructor(public key: 'string' | 'number', public value: ExportType, private type = 'map') { } }
export class ExportFunc { constructor(public args: ExportObject, public ret: ExportType, private type = 'function') { } }
export type ExportType = string | ExportFunc | ExportObject | ExportArray | ExportMap

const RENAME_TYPES = {
    string: 'string',
    number: 'float',
    boolean: 'bool',
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

    function parseExportType(type: ts.Type): ExportType {
        const intrinsic = type as IntrinsicType,
            reference = type as TypeReferenceType,
            stringIndexed = type.getStringIndexType(),
            numberIndexed = type.getNumberIndexType()
        if (intrinsic.intrinsicName) {
            return intrinsic.intrinsicName
        } else if (type.symbol && type.symbol.escapedName === 'Array' && reference.typeArguments) {
            if (reference.typeArguments.length === 1) {
                return new ExportArray(parseExportType(reference.typeArguments[0]))
            } else {
                throw Error(`array of types ${reference.typeArguments} not supported`)
            }
        } else if ((type.flags & ts.TypeFlags.Object) && stringIndexed) {
            return new ExportMap('string', parseExportType(stringIndexed))
        } else if ((type.flags & ts.TypeFlags.Object) && numberIndexed) {
            return new ExportMap('number', parseExportType(numberIndexed))
        } else if ((type.flags & ts.TypeFlags.Object) && type.symbol && type.symbol.members) {
            const result = { } as { [name: string]: ExportType }
            type.symbol.members.forEach((symbol, key) => {
                if (symbol.valueDeclaration) {
                    const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
                    result[symbol.escapedName.toString()] = parseExportType(type)
                }
            })
            return new ExportObject(result)
        } else if (type.symbol && type.symbol.valueDeclaration && ts.isFunctionLike(type.symbol.valueDeclaration)) {
            const signatures = type.getCallSignatures()
            if (signatures.length === 1) {
                const signature = signatures[0],
                    args = { } as { [name: string]: ExportType }
                for (const symbol of signature.parameters) {
                    if (symbol.valueDeclaration) {
                        const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration)
                        args[symbol.escapedName.toString()] = parseExportType(type)
                    }
                }
                const ret = signature.getReturnType() as TypeReferenceType
                if (ret.symbol && ret.symbol.escapedName === 'Promise' && ret.typeArguments) {
                    return new ExportFunc(new ExportObject(args), parseExportType(ret.typeArguments[0]))
                } else {
                    throw Error(`only async functions supported`)
                }
            } else {
                throw Error(`can not parse function type ${type.flags}`)
            }
        } else {
            throw Error(`can not parse type ${type.flags}`)
        }
    }

    return parseExportType(exportType)
}

export function getProtoObject(file: string) {
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
            for (const [index, [name, member]] of Object.entries(type.members).entries()) {
                let type = proto(member)
                if (member instanceof ExportObject) {
                    nested[type = `${name}Type`] = proto(member)
                }
                const rule = member instanceof ExportArray ? 'repeated' : 'required',
                    keyType = member instanceof ExportMap ? proto(member.key) : undefined
                fields[name] = { keyType, rule, type, id: index + 1 }
            }
            return { fields, nested }
        } else if (type instanceof ExportArray) {
            return proto(type.item)
        } else if (type instanceof ExportMap) {
            return proto(type.value)
        } else {
            throw Error(`can not convert unknown type to proto`)
        }
    }

    function walk(srvName: string, key: string, type: ExportType) {
        srvName = srvName + key.replace(/^\w/, w => w.toUpperCase())
        if (type instanceof ExportFunc) {
            const requestType = `${srvName}KykReq`,
                responseType = `${srvName}KykRes`,
                methods = { [key]: { requestType, responseType } }
            nested[srvName] = { methods }
            nested[requestType] = proto(type.args)
            nested[responseType] = proto(new ExportObject({ result: type.ret }))
        } else if (type instanceof ExportObject) {
            for (const [name, member] of Object.entries(type.members)) {
                walk(srvName, name, member)
            }
        }
    }

    walk('', 'srv', exportType instanceof ExportFunc ? exportType.ret : exportType)
    return { nested }
}
