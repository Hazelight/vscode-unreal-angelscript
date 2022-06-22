import {
    TextDocumentPositionParams, CompletionItem, CompletionItemKind, SignatureHelp,
    SignatureInformation, ParameterInformation, Hover, MarkupContent, SymbolInformation,
    TextDocument, SymbolKind, Definition, Location, InsertTextFormat, TextEdit,
    Range, Position, MarkupKind, WorkspaceSymbol
} from 'vscode-languageserver';

import * as scriptfiles from './as_parser';
import * as parsedcompletion from './parsed_completion';
import * as typedb from './database';
import * as specifiers from './specifiers';

export function GetDefinition(asmodule : scriptfiles.ASModule, position : Position) : Array<Location>
{
    let locations = new Array<Location>();
    let offset = asmodule.getOffset(position);

    // If there is a symbol beneath the cursor, go to that symbol/
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
    if (findSymbol)
    {
        let defs = GetSymbolDefinition(asmodule, findSymbol);
        if (defs)
        {
            for (let def of defs)
                locations.push(def.location);
        }
        return locations;
    }

    // If the cursor is on an import statement, use that as the definition
    let statement = asmodule.getStatementAt(offset);
    if (statement && statement.ast && statement.ast.type == scriptfiles.node_types.ImportStatement)
    {
        if (statement.ast.children[0].value)
        {
            let importedModule = scriptfiles.GetModule(statement.ast.children[0].value);
            if (importedModule)
            {
                locations.push(importedModule.getLocation(0));
                return locations;
            }
        }
    }

    return locations;
}

export function FindUnimportedSymbolOnLine(asmodule : scriptfiles.ASModule, position : Position) : scriptfiles.ASSymbol
{
    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
    if (findSymbol && findSymbol.isUnimported)
        return findSymbol;

    let lineStartOffset = asmodule.getOffset(
        Position.create(position.line, 0)
    );
    let lineEndOffset = asmodule.getOffset(
        Position.create(position.line, 10000)
    );

    for (let sym of asmodule.symbols)
    {
        if (!sym.overlapsRange(lineStartOffset, lineEndOffset))
            continue;
        if (sym.isUnimported)
            return sym;
    }

    return null;
}

export interface SymbolDeclaration
{
    location : Location,
    module : scriptfiles.ASModule,
};

export function GetSymbolDefinition(asmodule : scriptfiles.ASModule, findSymbol : scriptfiles.ASSymbol) : Array<SymbolDeclaration>
{
    let definitions = new Array<SymbolDeclaration>();
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
                {
                    return [{
                        module: symbolModule,
                        location: symbolModule.getLocation(dbtype.moduleOffset),
                    }];
                }
            }

            dbtype = typedb.GetType("__"+findSymbol.symbol_name);
            if (dbtype && dbtype.declaredModule)
            {
                let symbolModule = scriptfiles.GetModule(dbtype.declaredModule);
                if (symbolModule)
                {
                    return [{
                        module: symbolModule,
                        location: symbolModule.getLocation(dbtype.moduleOffset),
                    }];
                }
            }
        }
        break;
        case scriptfiles.ASSymbolType.LocalVariable:
        case scriptfiles.ASSymbolType.Parameter:
        {
            if (!asmodule)
                return [];
            let scope = asmodule.getScopeAt(findSymbol.start);
            while (scope)
            {
                if (!scope.isInFunctionBody())
                    break;

                for (let asvar of scope.variables)
                {
                    if (asvar.name == findSymbol.symbol_name)
                    {
                        return [{
                            module: asmodule,
                            location: asmodule.getLocationRange(asvar.start_offset_name, asvar.end_offset_name),
                        }];
                    }
                }
                scope = scope.parentscope;
            }
        }
        break;
        case scriptfiles.ASSymbolType.AccessSpecifier:
        {
            if (!asmodule)
                return [];
            let scope = asmodule.getScopeAt(findSymbol.start);
            let dbtype = scope.getParentType();
            if (!dbtype)
                return [];

            let spec = dbtype.getAccessSpecifier(findSymbol.symbol_name);
            if (!spec)
                return [];

            return [{
                module: asmodule,
                location: asmodule.getLocationRange(spec.moduleOffset, spec.moduleOffsetEnd),
            }];
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
                    {
                        definitions.push({
                            module: symbolModule,
                            location: symbolModule.getLocation(sym.moduleOffset)
                        });
                    }
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
                    {
                        definitions.push({
                            module: symbolModule,
                            location: symbolModule.getLocation(sym.moduleOffset)
                        });
                    }
                }
            }
        }
        break;
    }

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
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
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
    {
        // If there's no symbol below the cursor, try to provider a hover for the world under cursor
        let word = GetWordAt(asmodule, offset);
        if (!word)
            return null;
        return GetWordHover(word);
    }

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
            
            let symbols = insideType.findSymbols(findSymbol.symbol_name);
            let methods = [];

            for (let func of symbols)
            {
                if (func instanceof typedb.DBMethod)
                    methods.push(func);
            }

            if (methods.length > 1)
                parsedcompletion.SortMethodsBasedOnArgumentTypes(methods, asmodule, findSymbol.end + 2);

            if (methods.length != 0)
                return GetHoverForFunction(insideType, methods[0], false);
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
        case scriptfiles.ASSymbolType.AccessSpecifier:
            return <Hover> {contents: <MarkupContent> {
                kind: "markdown",
                value: `Access specifier \`${findSymbol.symbol_name}\` restricts which other classes this can be used from`,
            }};
    }
}

function IsIdentifierValid(content : string, index : number)
{
    let charCode = content.charCodeAt(index);
    if (charCode > 47 && charCode < 58)
        return true;
    if (charCode > 64 && charCode < 91)
        return true;
    if (charCode > 96 && charCode < 123)
        return true;
    if (charCode == 95)
        return true;
    return false;
}

function GetWordAt(asmodule : scriptfiles.ASModule, offset : number) : string
{
    let startOffset = offset;
    while (startOffset > 0)
    {
        if (!IsIdentifierValid(asmodule.content, startOffset))
        {
            startOffset += 1;
            break;
        }
        startOffset -= 1;
    }

    let endOffset = offset+1;
    while (endOffset > 0)
    {
        if (!IsIdentifierValid(asmodule.content, endOffset))
            break;
        endOffset += 1;
    }

    if (startOffset < endOffset)
        return asmodule.content.substring(startOffset, endOffset);
    return null;
}

function GetWordHover(word : string) : Hover
{
    if (!word)
        return;

    let documentation = null;
    if (word in specifiers.ASPropertySpecifiers)
        documentation = specifiers.ASPropertySpecifiers[word];
    else if (word in specifiers.ASClassSpecifiers)
        documentation = specifiers.ASClassSpecifiers[word];
    else if (word in specifiers.ASFunctionSpecifiers)
        documentation = specifiers.ASFunctionSpecifiers[word];
    else if (word in specifiers.ASStructSpecifiers)
        documentation = specifiers.ASStructSpecifiers[word];

    if (documentation)
    {
        return <Hover> {contents: <MarkupContent> {
            kind: "markdown",
            value: documentation,
        }};
    }
    return null;
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
    let prefix = "";
    let suffix = "";
    if (func.isMixin && func.args && func.args.length != 0)
    {
        prefix = func.args[0].typename+".";
        suffix = " mixin";
    }
    else if (type.typename.startsWith("__"))
    {
        if (type.typename != "__")
            prefix = type.typename.substring(2)+"::";
    }
    else if (!type.typename.startsWith("//"))
    {
        prefix = type.typename+".";
    }

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
        hover += "```angelscript_snippet\n"+func.format(prefix, func.isMixin)+suffix+"\n```";
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

function AddModuleSymbols(asmodule : scriptfiles.ASModule, symbols : Array<SymbolInformation>)
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
            scopeSymbol.name = scopeSymbol.name.substring(2);

        if (dbtype.isNamespace())
            scopeSymbol.kind = SymbolKind.Namespace;
        else if (dbtype.isEnum)
            scopeSymbol.kind = SymbolKind.Enum;
        else
            scopeSymbol.kind = SymbolKind.Class;

        symbols.push(scopeSymbol);
    }
}

function AddScopeSymbols(asmodule : scriptfiles.ASModule, scope : scriptfiles.ASScope, symbols: Array<SymbolInformation>)
{
    if (!scope)
        return;
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
                    kind : SymbolKind.Field,
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
        };

        if (scopeFunc.moduleScopeStart != -1)
            scopeSymbol.location = asmodule.getLocationRange(scopeFunc.moduleOffset, scopeFunc.moduleScopeEnd);
        else
            scopeSymbol.location = asmodule.getLocation(scopeFunc.moduleOffset);

        if (scope.scopetype == scriptfiles.ASScopeType.Function)
        {
            if (scope.parentscope && scope.parentscope.scopetype == scriptfiles.ASScopeType.Class)
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

export function WorkspaceSymbols( query : string ) : WorkspaceSymbol[]
{
    let symbols = new Array<WorkspaceSymbol>();

    // Always ignore case for queries
    query = query.toLowerCase();

    // This is intentional, we don't send anything when there's no query because it's way too slow
    if (query.length == 0)
        return symbols;

    // We never match for members unless we've typed a longer query string, to improve performance.
    // The vscode filtering on all this stuff is also incredibly bad, so this isn't a very useful usecase anyway.
    let matchMembers = query.length >= 5;

    for (let [typename, dbtype] of typedb.GetAllTypes())
    {
        if (!dbtype.declaredModule)
            continue;

        let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
        if (!asmodule)
            continue;

        let containingTypename = dbtype.getDisplayName();
        let typeIsMatching = containingTypename.toLowerCase().indexOf(query) != -1;
        if (typeIsMatching && !dbtype.isGlobalScope && !dbtype.isShadowedNamespace())
        {
            let symbol = <WorkspaceSymbol> {
                name: containingTypename,
            };

            symbol.location = {uri: asmodule.displayUri};

            if (dbtype.isNamespace())
                symbol.kind = SymbolKind.Namespace;
            else if (dbtype.isEnum)
                symbol.kind = SymbolKind.Enum;
            else
                symbol.kind = SymbolKind.Class;

            symbol.data = dbtype.typename;
            symbols.push(symbol);
        }

        if (matchMembers)
        {
            let memberPrefix = containingTypename;
            if (dbtype.isGlobalScope)
                memberPrefix = "";
            else if (dbtype.isNamespace())
                memberPrefix += "::";
            else
                memberPrefix += ".";

            for (let dbfunc of dbtype.methods)
            {
                if (dbfunc.isAutoGenerated)
                    continue;
                let funcIsMatching = dbfunc.name.toLowerCase().indexOf(query) != -1;
                if (!funcIsMatching && !typeIsMatching)
                    continue;

                let symbol = <WorkspaceSymbol> {};
                if (dbfunc.args && dbfunc.args.length != 0)
                    symbol.name = memberPrefix+dbfunc.name+"(…)";
                else
                    symbol.name = memberPrefix+dbfunc.name+"()";

                symbol.data = [dbtype.typename, dbfunc.name];
                symbol.location = {uri: asmodule.displayUri};

                if (dbtype.isGlobalScope)
                {
                    symbol.kind = SymbolKind.Function;
                }
                else if (dbtype.isNamespace())
                {
                    symbol.kind = SymbolKind.Function;
                    symbol.containerName = containingTypename;
                }
                else
                {
                    if (dbfunc.isBlueprintEvent)
                        symbol.kind = SymbolKind.Event;
                    else
                        symbol.kind = SymbolKind.Method;
                    symbol.containerName = containingTypename;
                }

                symbols.push(symbol);
            }

            for (let dbprop of dbtype.properties)
            {
                if (dbprop.isAutoGenerated)
                    continue;
                let propIsMatching = dbprop.name.toLowerCase().indexOf(query) != -1;
                if (!propIsMatching && !typeIsMatching)
                    continue;

                let symbol = <WorkspaceSymbol> {};
                symbol.name = memberPrefix+dbprop.name;
                symbol.data = [dbtype.typename, dbprop.name];
                symbol.location = {uri: asmodule.displayUri};

                if (dbtype.isGlobalScope)
                {
                    symbol.kind = SymbolKind.Variable;
                }
                else if (dbtype.isNamespace())
                {
                    symbol.kind = SymbolKind.Variable;
                    symbol.containerName = containingTypename;
                }
                else
                {
                    symbol.kind = SymbolKind.Field;
                    symbol.containerName = containingTypename;
                }

                symbols.push(symbol);
            }
        }
    }

    return symbols;
}

export function ResolveWorkspaceSymbol(symbol : WorkspaceSymbol) : WorkspaceSymbol
{
    if (typeof symbol.data === "string")
    {
        let dbtype = typedb.GetType(symbol.data);
        if (!dbtype)
            return;
        let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
        if (!asmodule)
            return;

        if (dbtype.moduleScopeStart != -1)
            symbol.location = asmodule.getLocationRange(dbtype.moduleOffset, dbtype.moduleScopeEnd);
        else
            symbol.location = asmodule.getLocation(dbtype.moduleOffset);
    }
    else
    {
        let dbtype = typedb.GetType(symbol.data[0]);
        if (!dbtype)
            return;
        let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
        if (!asmodule)
            return;

        let subSymbol = dbtype.findFirstSymbol(symbol.data[1]);
        if (subSymbol instanceof typedb.DBMethod)
        {
            if (subSymbol.moduleScopeStart != -1)
                symbol.location = asmodule.getLocationRange(subSymbol.moduleOffset, subSymbol.moduleScopeEnd);
            else
                symbol.location = asmodule.getLocation(subSymbol.moduleOffset);
        }
        else if (subSymbol instanceof typedb.DBProperty)
        {
            symbol.location = asmodule.getLocation(subSymbol.moduleOffset);
        }
    }

    return symbol;
}