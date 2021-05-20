import {
    TextDocumentPositionParams, CompletionItem, CompletionItemKind, SignatureHelp,
    SignatureInformation, ParameterInformation, Hover, MarkupContent, SymbolInformation,
    TextDocument, SymbolKind, Definition, Location, InsertTextFormat, TextEdit,
    Range, Position, MarkupKind
} from 'vscode-languageserver';

import * as scriptfiles from './as_parser';
import * as typedb from './database';

export function GetDefinition(asmodule : scriptfiles.ASModule, position : Position) : Definition
{
    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    let definitions = new Array<Location>();
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.Namespace:
        {
            let dbtype = typedb.GetType(findSymbol.symbol_name);
            if (dbtype && dbtype.declaredModule)
            {
                let symbolModule = scriptfiles.GetModule(dbtype.declaredModule);
                if (symbolModule)
                    return symbolModule.getLocation(dbtype.moduleOffset);
            }

            dbtype = typedb.GetType("__"+findSymbol.symbol_name);
            if (dbtype && dbtype.declaredModule)
            {
                let symbolModule = scriptfiles.GetModule(dbtype.declaredModule);
                if (symbolModule)
                    return symbolModule.getLocation(dbtype.moduleOffset);
            }
        }
        break;
        case scriptfiles.ASSymbolType.LocalVariable:
        case scriptfiles.ASSymbolType.Parameter:
        {
            let scope = asmodule.getScopeAt(offset);
            while (scope)
            {
                if (!scope.isInFunctionBody())
                    break;

                for (let asvar of scope.variables)
                {
                    if (asvar.name == findSymbol.symbol_name)
                        return asmodule.getLocationRange(asvar.start_offset_name, asvar.end_offset_name);
                }
                scope = scope.parentscope;
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let insideType = typedb.GetType(findSymbol.container_type);
            if (!insideType)
                return null;
            
            let dbSymbols = insideType.findSymbols(findSymbol.symbol_name);
            for (let sym of dbSymbols)
            {
                if (sym instanceof typedb.DBMethod || sym instanceof typedb.DBProperty)
                {
                    if (!sym.declaredModule)
                        continue;
                    let symbolModule = scriptfiles.GetModule(sym.declaredModule);
                    if (symbolModule)
                        definitions.push(symbolModule.getLocation(sym.moduleOffset));
                }
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let insideType = typedb.GetType(findSymbol.container_type);
            if (!insideType)
                return null;
            
            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substr(3);

            let dbSymbols = [
                ...insideType.findSymbols("Get"+accessName),
                ...insideType.findSymbols("Set"+accessName),
            ];

            for (let sym of dbSymbols)
            {
                if (sym instanceof typedb.DBMethod || sym instanceof typedb.DBProperty)
                {
                    if (!sym.declaredModule)
                        continue;
                    let symbolModule = scriptfiles.GetModule(sym.declaredModule);
                    if (symbolModule)
                        definitions.push(symbolModule.getLocation(sym.moduleOffset));
                }
            }
        }
        break;
    }

    if (definitions.length == 0)
        return null;
    if (definitions.length == 1)
        return definitions[0];
    return definitions;
}

export function GetUnrealTypeFor(typename : string) : string
{
    // Walk through the typedb to find parent types until we find a C++ class
    let type = typedb.GetType(typename);
    while(type && type.declaredModule && type.supertype)
        type = typedb.GetType(type.supertype);

    if (!type)
        return null;

    return type.typename;
}

export function GetCppSymbol(asmodule : scriptfiles.ASModule, position : Position) : [string, string]
{
    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.Namespace:
        {
            let unrealType = GetUnrealTypeFor(findSymbol.symbol_name);
            if (unrealType)
                return ["", unrealType];

            unrealType = GetUnrealTypeFor("__"+findSymbol.symbol_name);
            if (unrealType)
                return ["", unrealType];
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.GlobalVariable:
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let unrealType = GetUnrealTypeFor(findSymbol.container_type);
            if (unrealType)
                return [unrealType, findSymbol.symbol_name];
        }
        break;
    }

    return null;
}

export function GetHover(asmodule : scriptfiles.ASModule, position : Position) : Hover
{
    if (!asmodule)
        return null;

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.Namespace:
        {
            let dbtype : typedb.DBType = null;
            if (findSymbol.symbol_name.startsWith("__"))
                dbtype = typedb.GetType(findSymbol.symbol_name.substr(2));
            if (!dbtype)
                dbtype = typedb.GetType(findSymbol.symbol_name);
            if (!dbtype)
                dbtype = typedb.GetType("__"+findSymbol.symbol_name);

            if (dbtype)
                return GetHoverForType(dbtype);
        }
        break;
        case scriptfiles.ASSymbolType.LocalVariable:
        case scriptfiles.ASSymbolType.Parameter:
        {
            let scope = asmodule.getScopeAt(offset);
            while (scope)
            {
                if (!scope.isInFunctionBody())
                    break;

                for (let asvar of scope.variables)
                {
                    if (asvar.name == findSymbol.symbol_name)
                    {
                        return GetHoverForLocalVariable(scope, asvar);
                    }
                }
                scope = scope.parentscope;
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.GlobalFunction:
        {
            let insideType = typedb.GetType(findSymbol.container_type);
            if (!insideType)
                return null;
            
            let sym = insideType.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionOnly);
            if (sym instanceof typedb.DBMethod)
            {
                return GetHoverForFunction(insideType, sym, false);
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let insideType = typedb.GetType(findSymbol.container_type);
            if (!insideType)
                return null;
            
            let sym = insideType.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.PropertyOnly);
            if (sym instanceof typedb.DBProperty)
            {
                return GetHoverForProperty(insideType, sym);
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let insideType = typedb.GetType(findSymbol.container_type);
            if (!insideType)
                return null;
            
            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substr(3);

            let dbSymbols = [
                ...insideType.findSymbols("Get"+accessName),
                ...insideType.findSymbols("Set"+accessName),
            ];

            for (let sym of dbSymbols)
            {
                // Find the symbol that has documentation
                if (sym instanceof typedb.DBMethod && sym.findAvailableDocumentation())
                {
                    return GetHoverForFunction(insideType, sym, true)
                }
            }

            for (let sym of dbSymbols)
            {
                // Fall back to first symbol
                if (sym instanceof typedb.DBMethod)
                {
                    return GetHoverForFunction(insideType, sym, true)
                }
            }
        }
        break;
    }
}

function FormatHoverDocumentation(doc : string) : string
{
    if (doc)
    {
        let outDoc = "*";
        outDoc += doc.replace(/\s*\r?\n\s*/g,"*\n\n*");
        outDoc += "*\n\n";
        return outDoc;
    }
    return "";
}

function GetHoverForType(hoveredType : typedb.DBType) : Hover
{
    if (hoveredType.isPrimitive)
        return null;

    let hover = "";
    hover += FormatHoverDocumentation(hoveredType.documentation);
    hover += "```angelscript_snippet\n";
    if (hoveredType.isEnum)
    {
        hover += "enum "+hoveredType.typename.substr(2);
    }
    else if (hoveredType.isNamespace())
    {
        hover += "namespace "+hoveredType.typename.substr(2);
    }
    else if (hoveredType.isDelegate)
    {
        hover += "delegate ";
        let mth = hoveredType.getMethod("ExecuteIfBound");
        if (mth)
            hover += mth.format(null, false, false, hoveredType.typename);
        else
            hover += hoveredType.typename;
    }
    else if (hoveredType.isEvent)
    {
        hover += "event ";
        let mth = hoveredType.getMethod("Broadcast");
        if (mth)
            hover += mth.format(null, false, false, hoveredType.typename);
        else
            hover += hoveredType.typename;
    }
    else
    {
        if (hoveredType.isStruct)
            hover += "struct ";
        else
            hover += "class ";

        hover += hoveredType.typename;
        if (hoveredType.supertype)
            hover += " : "+hoveredType.supertype;
        else if (hoveredType.unrealsuper)
            hover += " : "+hoveredType.unrealsuper;
    }

    hover += "\n```";
    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function GetHoverForLocalVariable(scope : scriptfiles.ASScope, asvar : scriptfiles.ASVariable) : Hover
{
    let hover = "";
    if(asvar.documentation)
        hover += FormatHoverDocumentation(asvar.documentation);

    hover += "```angelscript_snippet\n"+asvar.typename+" "+asvar.name+"\n```";
    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function GetHoverForProperty(type : typedb.DBType, prop : typedb.DBProperty) : Hover
{
    let prefix = null;
    if(type.typename.startsWith("__"))
    {
        if(type.typename != "__")
            prefix = type.typename.substring(2)+"::";
    }
    /*else if(!type.typename.startsWith("//"))
        prefix = type.typename+".";*/

    let hover = "";
    hover += FormatHoverDocumentation(prop.documentation);
    hover += "```angelscript_snippet\n"+prop.format(prefix)+"\n```";

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function GetHoverForFunction(type : typedb.DBType, func : typedb.DBMethod, isAccessor : boolean) : Hover
{
    let prefix = null;
    if(type.typename.startsWith("__"))
    {
        if(type.typename != "__")
            prefix = type.typename.substring(2)+"::";
    }
    else if(!type.typename.startsWith("//"))
        prefix = type.typename+".";

    let hover = "";

    let doc = func.findAvailableDocumentation();
    if (doc)
        hover += FormatHoverDocumentation(doc);

    if (isAccessor)
    {
        if (func.name.startsWith("Get"))
            hover += "```angelscript_snippet\n"+func.returnType+" "+prefix+func.name.substr(3)+"\n```";
        else if (func.args && func.args.length > 0)
            hover += "```angelscript_snippet\n"+func.args[0].typename+" "+prefix+func.name.substr(3)+"\n```";
    }
    else
    {
        hover += "```angelscript_snippet\n"+func.format(prefix)+"\n```";
    }

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

export function DocumentSymbols( uri : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return symbols;

    AddModuleSymbols(asmodule, symbols);
    AddScopeSymbols(asmodule, asmodule.rootscope, symbols);
    return symbols;
}

export function WorkspaceSymbols( query : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();
    console.log("Query: "+query);
    for (let asmodule of scriptfiles.GetAllModules())
    {
        AddModuleSymbols(asmodule, symbols, query);
        AddScopeSymbols(asmodule, asmodule.rootscope, symbols, query);
    }
    return symbols;
}

function AddModuleSymbols(asmodule : scriptfiles.ASModule, symbols : Array<SymbolInformation>, query : string = null)
{
    for (let dbtype of [...asmodule.types, ...asmodule.namespaces])
    {
        if (dbtype.isShadowedNamespace())
            continue;

        let scopeSymbol = <SymbolInformation> {
            name : dbtype.typename,
        };

        if (dbtype.moduleScopeStart != -1)
            scopeSymbol.location = asmodule.getLocationRange(dbtype.moduleOffset, dbtype.moduleScopeEnd);
        else
            scopeSymbol.location = asmodule.getLocation(dbtype.moduleOffset);

        if (scopeSymbol.name.startsWith("__"))
            scopeSymbol.name = scopeSymbol.name.substr(2);

        if (dbtype.isNamespace())
            scopeSymbol.kind = SymbolKind.Namespace;
        else if (dbtype.isEnum)
            scopeSymbol.kind = SymbolKind.Enum;
        else if (dbtype.isStruct)
            scopeSymbol.kind = SymbolKind.Struct;
        else
            scopeSymbol.kind = SymbolKind.Class;

        symbols.push(scopeSymbol);
    }
}

function AddScopeSymbols(asmodule : scriptfiles.ASModule, scope : scriptfiles.ASScope, symbols: Array<SymbolInformation>, query : string = null)
{
    let scopeType = scope.getDatabaseType();
    if (scopeType)
    {
        if (scope.scopetype == scriptfiles.ASScopeType.Class)
        {
            for (let classVar of scope.variables)
            {
                if (classVar.isArgument)
                    continue;

                symbols.push(<SymbolInformation> {
                    name : classVar.name,
                    kind : SymbolKind.Variable,
                    location : asmodule.getLocationRange(classVar.start_offset_name, classVar.end_offset_name),
                    containerName : scopeType.typename,
                });
            }
        }
    }

    let scopeFunc = scope.getDatabaseFunction();
    if (scopeFunc)
    {
        let scopeSymbol = <SymbolInformation> {
            name : scopeFunc.name+"()",
            location : asmodule.getLocationRange(scope.start_offset, scope.end_offset),
        };

        if (scope.scopetype == scriptfiles.ASScopeType.Function)
        {
            if (scope.parentscope.scopetype == scriptfiles.ASScopeType.Class)
            {
                scopeSymbol.kind = SymbolKind.Method;
                scopeSymbol.containerName = scope.parentscope.getDatabaseType().typename;
            }
            else
            {
                scopeSymbol.kind = SymbolKind.Function;
            }

            symbols.push(scopeSymbol);
        }
    }

    for (let subscope of scope.scopes)
        AddScopeSymbols(asmodule, subscope, symbols);
}