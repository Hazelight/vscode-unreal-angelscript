import {
    TextDocumentPositionParams, CompletionItem, CompletionItemKind, SignatureHelp,
    SignatureInformation, ParameterInformation, Hover, MarkupContent, SymbolInformation,
    TextDocument, SymbolKind, Definition, Location, InsertTextFormat, TextEdit,
    Range, Position, MarkupKind, WorkspaceSymbol, DocumentSymbol
} from 'vscode-languageserver';

import * as scriptfiles from './as_parser';
import * as parsedcompletion from './parsed_completion';
import * as typedb from './database';
import * as specifiers from './specifiers';
import { FormatFunctionDocumentation, FormatPropertyDocumentation } from './documentation';

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

export function FindUnimportedSymbolOnLine(asmodule : scriptfiles.ASModule, position : Position) : scriptfiles.ASSemanticSymbol
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

    for (let sym of asmodule.semanticSymbols)
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

export function GetSymbolDefinition(asmodule : scriptfiles.ASModule, findSymbol : scriptfiles.ASSemanticSymbol) : Array<SymbolDeclaration>
{
    let definitions = new Array<SymbolDeclaration>();
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
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
        case scriptfiles.ASSymbolType.Namespace:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.symbol_name);
            if (namespace)
            {
                for (let decl of namespace.declarations)
                {
                    if (!decl.declaredModule)
                        continue;

                    let declModule = scriptfiles.GetModule(decl.declaredModule);
                    if (declModule)
                    {
                        definitions.push({
                            module: declModule,
                            location: declModule.getLocation(decl.declaredOffset),
                        });
                    }
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
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
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
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;

            let dbSymbols = namespace.findSymbols(findSymbol.symbol_name);
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
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
            if (!insideType)
                return null;

            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substring(3);

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
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;

            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substring(3);

            let dbSymbols = [
                ...namespace.findSymbols("Get"+accessName),
                ...namespace.findSymbols("Set"+accessName),
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
    let type = typedb.GetTypeByName(typename);
    while(type && type.declaredModule && type.supertype)
        type = type.getSuperType();

    if (!type)
        return null;

    return type.name;
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
        {
            let dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
            if (dbtype)
                return GetHoverForType(dbtype);
        }
        break;
        case scriptfiles.ASSymbolType.Namespace:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.symbol_name);
            if (namespace)
                return GetHoverForNamespace(namespace);
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
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
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
                return GetHoverForFunction(asmodule, findSymbol.end + 2, insideType, methods[0], false);
        }
        break;
        case scriptfiles.ASSymbolType.GlobalFunction:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;

            let symbols = namespace.findSymbols(findSymbol.symbol_name);
            let methods = [];

            for (let func of symbols)
            {
                if (func instanceof typedb.DBMethod)
                    methods.push(func);
            }

            if (methods.length > 1)
                parsedcompletion.SortMethodsBasedOnArgumentTypes(methods, asmodule, findSymbol.end + 2);

            if (methods.length != 0)
                return GetHoverForFunction(asmodule, findSymbol.end + 2, namespace, methods[0], false);
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
            if (!insideType)
                return null;

            let sym = insideType.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (sym instanceof typedb.DBProperty)
            {
                return GetHoverForProperty(insideType, sym);
            }
        }
        break;
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;

            let sym = namespace.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (sym instanceof typedb.DBProperty)
            {
                return GetHoverForProperty(namespace, sym);
            }
        }
        break;
        case scriptfiles.ASSymbolType.MemberAccessor:
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
            if (!insideType)
                return null;

            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substring(3);

            let dbSymbols = [
                ...insideType.findSymbols("Get"+accessName),
                ...insideType.findSymbols("Set"+accessName),
            ];

            for (let sym of dbSymbols)
            {
                // Find the symbol that has documentation
                if (sym instanceof typedb.DBMethod && sym.findAvailableDocumentation())
                {
                    return GetHoverForFunction(asmodule, findSymbol.end + 2, insideType, sym, true)
                }
            }

            for (let sym of dbSymbols)
            {
                // Fall back to first symbol
                if (sym instanceof typedb.DBMethod)
                {
                    return GetHoverForFunction(asmodule, findSymbol.end + 2, insideType, sym, true)
                }
            }
        }
        break;
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;

            let accessName = findSymbol.symbol_name;
            if (accessName.startsWith("Get") || accessName.startsWith("Set"))
                accessName = accessName.substring(3);

            let dbSymbols = [
                ...namespace.findSymbols("Get"+accessName),
                ...namespace.findSymbols("Set"+accessName),
            ];

            for (let sym of dbSymbols)
            {
                // Find the symbol that has documentation
                if (sym instanceof typedb.DBMethod && sym.findAvailableDocumentation())
                {
                    return GetHoverForFunction(asmodule, findSymbol.end + 2, namespace, sym, true)
                }
            }

            for (let sym of dbSymbols)
            {
                // Fall back to first symbol
                if (sym instanceof typedb.DBMethod)
                {
                    return GetHoverForFunction(asmodule, findSymbol.end + 2, namespace, sym, true)
                }
            }
        }
        break;
        case scriptfiles.ASSymbolType.AccessSpecifier:
            return <Hover> {contents: <MarkupContent> {
                kind: "markdown",
                value: `Access specifier \`${findSymbol.symbol_name}\` restricts which other classes this can be used from`,
            }};
        break;
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

    let specifier_lists = [
        specifiers.ASPropertySpecifiers,
        specifiers.ASClassSpecifiers,
        specifiers.ASFunctionSpecifiers,
        specifiers.ASStructSpecifiers,
    ];

    if (scriptfiles.GetScriptSettings().useAngelscriptHaze)
    {
        specifier_lists.push(specifiers.ASPropertySpecifiers_HAZE);
        specifier_lists.push(specifiers.ASFunctionSpecifiers_HAZE);
    }
    else
    {
        specifier_lists.push(specifiers.ASPropertySpecifiers_NO_HAZE);
        specifier_lists.push(specifiers.ASFunctionSpecifiers_NO_HAZE);
    }

    let subspecifier_lists = [
        specifiers.ASPropertySubSpecifiers,
        specifiers.ASClassSubSpecifiers,
        specifiers.ASFunctionSubSpecifiers,
        specifiers.ASStructSubSpecifiers,
    ];

    for (let sublist of subspecifier_lists)
    {
        for (let subspec in sublist)
            specifier_lists.push(sublist[subspec]);
    }

    let documentation = null;
    for (let speclist of specifier_lists)
    {
        if (word in speclist)
        {
            documentation = speclist[word];
            break;
        }
    }

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
        hover += "enum "+hoveredType.name;
    }
    else if (hoveredType.isDelegate)
    {
        hover += "delegate ";
        let mth = hoveredType.getMethod("ExecuteIfBound");
        if (mth)
            hover += mth.format(null, false, false, hoveredType.name);
        else
            hover += hoveredType.name;
    }
    else if (hoveredType.isEvent)
    {
        hover += "event ";
        let mth = hoveredType.getMethod("Broadcast");
        if (mth)
            hover += mth.format(null, false, false, hoveredType.name);
        else
            hover += hoveredType.name;
    }
    else
    {
        if (hoveredType.isStruct)
            hover += "struct ";
        else
            hover += "class ";

        hover += hoveredType.name;
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

function GetHoverForNamespace(hoveredNamespace : typedb.DBNamespace) : Hover
{
    let hover = "";
    hover += FormatHoverDocumentation(hoveredNamespace.documentation);
    hover += "```angelscript_snippet\n";
    hover += "namespace "+hoveredNamespace.name;

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

function GetHoverForProperty(type : typedb.DBType | typedb.DBNamespace, prop : typedb.DBProperty) : Hover
{
    let prefix = null;
    if(type instanceof typedb.DBNamespace)
    {
        if (!type.isRootNamespace())
            prefix = type.getQualifiedNamespace()+"::";
    }

    let hover = "";
    hover += FormatPropertyDocumentation(prop.documentation);
    hover += "```angelscript_snippet\n"+prop.format(prefix)+"\n```";

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function GetHoverForFunction(asmodule : scriptfiles.ASModule, offset : number, type : typedb.DBType | typedb.DBNamespace, func : typedb.DBMethod, isAccessor : boolean) : Hover
{
    let prefix = "";
    let suffix = "";
    if (func.isMixin && func.args && func.args.length != 0)
    {
        prefix = func.args[0].typename+".";
        suffix = " mixin";
    }
    else if (type instanceof typedb.DBNamespace)
    {
        if (!type.isRootNamespace())
            prefix = type.getQualifiedNamespace()+"::";
    }
    else
    {
        prefix = type.name+".";
    }

    let hover = "";

    let doc = func.findAvailableDocumentation();
    if (doc)
        hover += FormatFunctionDocumentation(doc, func);

    let determineType : typedb.DBType = null;
    if (func.determinesOutputTypeArgumentIndex != -1)
        determineType = parsedcompletion.GetDetermineTypeFromArguments(asmodule, offset, func.determinesOutputTypeArgumentIndex);

    if (isAccessor)
    {
        if (func.name.startsWith("Get"))
            hover += "```angelscript_snippet\n"+func.returnType+" "+prefix+func.name.substring(3)+"\n```";
        else if (func.args && func.args.length > 0)
            hover += "```angelscript_snippet\n"+func.args[0].typename+" "+prefix+func.name.substring(3)+"\n```";
    }
    else
    {
        hover += "```angelscript_snippet\n"+func.format(prefix, func.isMixin, false, null, determineType)+suffix+"\n```";
    }

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

export function DocumentSymbols(asmodule : scriptfiles.ASModule) : DocumentSymbol[]
{
    let symbols = new Array<DocumentSymbol>();
    if (!asmodule)
        return symbols;

    AddScopeSymbols(asmodule, asmodule.rootscope, symbols);
    return symbols;
}

function AddScopeSymbols(asmodule : scriptfiles.ASModule, scope : scriptfiles.ASScope, symbols: Array<DocumentSymbol>)
{
    if (!scope)
        return;
    if (scope.scopetype == scriptfiles.ASScopeType.Class
        || scope.scopetype == scriptfiles.ASScopeType.Global
        || scope.scopetype == scriptfiles.ASScopeType.Namespace
        || scope.scopetype == scriptfiles.ASScopeType.Enum
        )
    {
        let varKind : SymbolKind = SymbolKind.Variable;

        if (scope.scopetype == scriptfiles.ASScopeType.Class
            || scope.scopetype == scriptfiles.ASScopeType.Enum)
        {
            let dbtype = scope.getDatabaseType();
            if (dbtype)
            {
                let scopeSymbol = <DocumentSymbol> {};
                if (dbtype.moduleScopeEnd != -1)
                    scopeSymbol.range = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleScopeEnd);
                else if (dbtype.moduleOffsetEnd != -1)
                    scopeSymbol.selectionRange = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleOffsetEnd);
                else
                    scopeSymbol.range = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleOffset);

                if (dbtype.moduleOffsetEnd != -1)
                    scopeSymbol.selectionRange = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleOffsetEnd);
                else
                    scopeSymbol.selectionRange = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleOffset);

                scopeSymbol.name = dbtype.name
                if (scope.scopetype == scriptfiles.ASScopeType.Enum)
                {
                    scopeSymbol.kind = SymbolKind.Enum;
                    varKind = SymbolKind.EnumMember;
                }
                else
                {
                    scopeSymbol.kind = SymbolKind.Class;
                    if (dbtype.isStruct)
                        scopeSymbol.kind = SymbolKind.Struct;
                }

                scopeSymbol.children = new Array<DocumentSymbol>();

                symbols.push(scopeSymbol);
                symbols = scopeSymbol.children;
            }
        }
        else if (scope.scopetype == scriptfiles.ASScopeType.Namespace)
        {
            let namespace = scope.getNamespace();
            if (namespace && scope.previous instanceof scriptfiles.ASStatement && scope.previous.ast
                && scope.previous.ast.type == scriptfiles.node_types.NamespaceDefinition)
            {
                let nsdef = scope.previous.ast;

                let scopeSymbol = <DocumentSymbol> {};
                scopeSymbol.range = asmodule.getRange(scope.start_offset, scope.end_offset);
                scopeSymbol.kind = SymbolKind.Namespace;
                scopeSymbol.selectionRange = asmodule.getRange(scope.previous.start_offset + nsdef.name.start, scope.previous.start_offset + nsdef.name.end);
                scopeSymbol.name = namespace.name;
                scopeSymbol.children = new Array<DocumentSymbol>();

                symbols.push(scopeSymbol);
                symbols = scopeSymbol.children;
            }
        }

        for (let classVar of scope.variables)
        {
            if (classVar.isArgument)
                continue;

            let signature = classVar.typename;
            if (classVar.accessSpecifier)
                signature = "access:"+classVar.accessSpecifier.name+" "+signature;
            else if (classVar.isPrivate)
                signature = "private "+signature;
            else if (classVar.isProtected)
                signature = "protected "+signature;

            symbols.push({
                name : classVar.name,
                kind : varKind,
                detail : signature,
                range : asmodule.getRange(classVar.start_offset_name, classVar.end_offset_name),
                selectionRange : asmodule.getRange(classVar.start_offset_name, classVar.end_offset_name),
            });
        }
    }

    let scopeFunc = scope.getDatabaseFunction();
    if (scopeFunc)
    {
        let scopeSymbol = <DocumentSymbol> {
            name : scopeFunc.name,
        };

        if (scopeFunc.args.length != 0)
            scopeSymbol.name += "(…)";
        else
            scopeSymbol.name += "()";

        if (scopeFunc.accessSpecifier)
            scopeSymbol.detail = "access:"+scopeFunc.accessSpecifier.name;
        else if (scopeFunc.isPrivate)
            scopeSymbol.detail = "private";
        else if (scopeFunc.isProtected)
            scopeSymbol.detail = "protected";

        if (scopeFunc.moduleScopeEnd != -1)
            scopeSymbol.range = asmodule.getRange(scopeFunc.moduleOffset, scopeFunc.moduleScopeEnd);
        else if (scopeFunc.moduleOffsetEnd != -1)
            scopeSymbol.range = asmodule.getRange(scopeFunc.moduleOffset, scopeFunc.moduleOffsetEnd);
        else
            scopeSymbol.range = asmodule.getRange(scopeFunc.moduleOffset, scopeFunc.moduleOffset);

        if (scopeFunc.moduleOffsetEnd != -1)
            scopeSymbol.selectionRange = asmodule.getRange(scopeFunc.moduleOffset, scopeFunc.moduleOffsetEnd);
        else
            scopeSymbol.selectionRange = asmodule.getRange(scopeFunc.moduleOffset, scopeFunc.moduleOffset);

        if (scope.scopetype == scriptfiles.ASScopeType.Function)
        {
            if (scope.parentscope && scope.parentscope.scopetype == scriptfiles.ASScopeType.Class)
                scopeSymbol.kind = SymbolKind.Method;
            else
                scopeSymbol.kind = SymbolKind.Function;

            symbols.push(scopeSymbol);
        }
    }
    else
    {
        for (let subscope of scope.scopes)
            AddScopeSymbols(asmodule, subscope, symbols);
    }
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

    for (let [_, dbtype] of typedb.GetAllTypesById())
    {
        if (!dbtype.declaredModule)
            continue;

        let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
        if (!asmodule)
            continue;

        let displayTypename = dbtype.getDisplayName();
        let qualifiedTypename = dbtype.getQualifiedTypenameInNamespace(null);

        let typeIsMatching = displayTypename.toLowerCase().indexOf(query) != -1;
        if (typeIsMatching)
        {
            let symbol = <WorkspaceSymbol> {
                name: qualifiedTypename,
            };

            symbol.location = {uri: asmodule.displayUri};

            if (dbtype.isEnum)
                symbol.kind = SymbolKind.Enum;
            else
                symbol.kind = SymbolKind.Class;

            symbol.data = dbtype.name;
            symbols.push(symbol);
        }

        if (matchMembers)
        {
            let memberPrefix = qualifiedTypename;
            if (dbtype.isEnum)
                memberPrefix += "::";
            else
                memberPrefix += ".";

            dbtype.forEachSymbol(function (sym : typedb.DBSymbol)
            {
                if (sym instanceof typedb.DBMethod)
                {
                    let dbfunc = sym;
                    if (dbfunc.isAutoGenerated)
                        return;
                    let funcIsMatching = dbfunc.name.toLowerCase().indexOf(query) != -1;
                    if (!funcIsMatching && !typeIsMatching)
                        return;

                    let symbol = <WorkspaceSymbol> {};
                    if (dbfunc.args && dbfunc.args.length != 0)
                        symbol.name = memberPrefix+dbfunc.name+"(…)";
                    else
                        symbol.name = memberPrefix+dbfunc.name+"()";

                    symbol.data = [dbtype.name, dbfunc.name, dbfunc.id];
                    symbol.location = {uri: asmodule.displayUri};

                    if (dbfunc.isBlueprintEvent)
                        symbol.kind = SymbolKind.Event;
                    else
                        symbol.kind = SymbolKind.Method;
                    symbol.containerName = displayTypename;

                    symbols.push(symbol);
                }
                else if (sym instanceof typedb.DBProperty)
                {
                    let dbprop = sym;
                    if (dbprop.isAutoGenerated)
                        return;
                    let propIsMatching = dbprop.name.toLowerCase().indexOf(query) != -1;
                    if (!propIsMatching && !typeIsMatching)
                        return;

                    let symbol = <WorkspaceSymbol> {};
                    symbol.name = memberPrefix+dbprop.name;
                    symbol.data = [dbtype.name, dbprop.name];
                    symbol.location = {uri: asmodule.displayUri};

                    symbol.kind = SymbolKind.Field;
                    symbol.containerName = displayTypename;

                    symbols.push(symbol);
                }
            }, false);
        }
    }

    for (let [_, namespace] of typedb.GetAllNamespaces())
    {
        let displayName = namespace.name;
        let qualifiedName = namespace.getQualifiedNamespace();
        let typeIsMatching = false;

        if (!namespace.isRootNamespace())
        {
            let scriptDecl = namespace.getFirstScriptDeclaration();
            if (!scriptDecl)
                continue;

            let asmodule = scriptfiles.GetModule(scriptDecl.declaredModule);
            if (!asmodule)
                continue;

            typeIsMatching = displayName.toLowerCase().indexOf(query) != -1;
            if (typeIsMatching && !namespace.isShadowingType())
            {
                let symbol = <WorkspaceSymbol> {
                    name: qualifiedName,
                };

                symbol.location = {uri: asmodule.displayUri};
                symbol.kind = SymbolKind.Namespace;
                symbol.data = namespace.getQualifiedNamespace();

                symbols.push(symbol);
            }
        }

        if (matchMembers)
        {
            let memberPrefix = qualifiedName;
            if (memberPrefix.length != 0)
                memberPrefix += "::";

            namespace.forEachSymbol(
                function (dbsym : typedb.DBSymbol)
                {
                    if (!dbsym.declaredModule)
                        return;

                    if (dbsym instanceof typedb.DBMethod)
                    {
                        if (dbsym.isAutoGenerated)
                            return;
                        let dbfunc = dbsym;
                        if (dbfunc.isAutoGenerated)
                            return;
                        let funcIsMatching = dbfunc.name.toLowerCase().indexOf(query) != -1;
                        if (!funcIsMatching && !typeIsMatching)
                            return;
                        let symbolModule = scriptfiles.GetModule(dbsym.declaredModule);
                        if (!symbolModule)
                            return;

                        let symbol = <WorkspaceSymbol> {};
                        if (dbfunc.args && dbfunc.args.length != 0)
                            symbol.name = memberPrefix+dbfunc.name+"(…)";
                        else
                            symbol.name = memberPrefix+dbfunc.name+"()";

                        symbol.data = [namespace.getQualifiedNamespace(), dbfunc.name, dbfunc.id];
                        symbol.location = {uri: symbolModule.displayUri};

                        if (dbfunc.isBlueprintEvent)
                            symbol.kind = SymbolKind.Event;
                        else
                            symbol.kind = SymbolKind.Method;
                        symbol.containerName = qualifiedName;

                        symbols.push(symbol);
                    }
                    else if (dbsym instanceof typedb.DBProperty)
                    {
                        if (dbsym.isAutoGenerated)
                            return;
                        let dbprop = dbsym;
                        if (dbprop.isAutoGenerated)
                            return;
                        let propIsMatching = dbprop.name.toLowerCase().indexOf(query) != -1;
                        if (!propIsMatching && !typeIsMatching)
                            return;
                        let symbolModule = scriptfiles.GetModule(dbsym.declaredModule);
                        if (!symbolModule)
                            return;

                        let symbol = <WorkspaceSymbol> {};
                        symbol.name = memberPrefix+dbprop.name;
                        symbol.data = [namespace.getQualifiedNamespace(), dbprop.name];
                        symbol.location = {uri: symbolModule.displayUri};

                        symbol.kind = SymbolKind.Field;
                        symbol.containerName = qualifiedName;

                        symbols.push(symbol);
                    }
                });
        }
    }

    return symbols;
}

export function ResolveWorkspaceSymbol(symbol : WorkspaceSymbol) : WorkspaceSymbol
{
    if (typeof symbol.data === "string")
    {
        {
            let dbtype = typedb.GetTypeByName(symbol.data);
            if (dbtype && dbtype.declaredModule)
            {
                let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
                if (!asmodule)
                    return;

                if (dbtype.moduleScopeStart != -1)
                    symbol.location = asmodule.getLocationRange(dbtype.moduleOffset, dbtype.moduleScopeEnd);
                else
                    symbol.location = asmodule.getLocation(dbtype.moduleOffset);
                return symbol;
            }
        }

        {
            let namespace = typedb.LookupNamespace(null, symbol.data);
            if (namespace)
            {
                let scriptDecl = namespace.getFirstScriptDeclaration();
                if (scriptDecl)
                {
                    let asmodule = scriptfiles.GetModule(scriptDecl.declaredModule);
                    if (!asmodule)
                        return;

                    if (scriptDecl.scopeOffsetStart != -1)
                        symbol.location = asmodule.getLocationRange(scriptDecl.scopeOffsetStart, scriptDecl.scopeOffsetEnd);
                    else
                        symbol.location = asmodule.getLocation(scriptDecl.declaredOffset);
                    return symbol;
                }
            }
        }
    }
    else
    {
        {
            let dbtype = typedb.GetTypeByName(symbol.data[0]);
            if (dbtype && dbtype.declaredModule)
            {
                let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
                if (!asmodule)
                    return;

                let allSymbols = dbtype.findSymbols(symbol.data[1]);
                let subSymbol : typedb.DBSymbol = null;
                for (let checkSymbol of allSymbols)
                {
                    if (checkSymbol instanceof typedb.DBMethod)
                    {
                        if (symbol.data.length < 3 || checkSymbol.id == symbol.data[2])
                        {
                            subSymbol = checkSymbol;
                            break;
                        }
                    }
                    else
                    {
                        subSymbol = checkSymbol;
                        break;
                    }
                }

                if (subSymbol)
                {
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
                    return symbol;
                }
            }
        }

        {
            let namespace = typedb.LookupNamespace(null, symbol.data[0]);
            if (namespace)
            {
                let allSymbols = namespace.findSymbols(symbol.data[1]);
                let subSymbol : typedb.DBSymbol = null;
                for (let checkSymbol of allSymbols)
                {
                    if (!checkSymbol.declaredModule)
                        continue;

                    if (checkSymbol instanceof typedb.DBMethod)
                    {
                        if (symbol.data.length < 3 || checkSymbol.id == symbol.data[2])
                        {
                            subSymbol = checkSymbol;
                            break;
                        }
                    }
                    else
                    {
                        subSymbol = checkSymbol;
                        break;
                    }
                }

                if (subSymbol)
                {
                    let symbolModule = scriptfiles.GetModule(subSymbol.declaredModule);
                    if (symbolModule)
                    {
                        if (subSymbol instanceof typedb.DBMethod)
                        {
                            if (subSymbol.moduleScopeStart != -1)
                                symbol.location = symbolModule.getLocationRange(subSymbol.moduleOffset, subSymbol.moduleScopeEnd);
                            else
                                symbol.location = symbolModule.getLocation(subSymbol.moduleOffset);
                        }
                        else if (subSymbol instanceof typedb.DBProperty)
                        {
                            symbol.location = symbolModule.getLocation(subSymbol.moduleOffset);
                        }
                        return symbol;
                    }
                }
            }
        }
    }

    return symbol;
}