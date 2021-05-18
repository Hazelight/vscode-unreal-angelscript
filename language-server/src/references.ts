import * as scriptfiles from './as_parser';
import * as completion from './completion';
import * as typedb from './database';

import { Range, Position, Location, TextEdit, ResponseError } from "vscode-languageserver";

export function FindReferences(uri : string, position : Position) : Array<Location>
{
    let references = new Array<Location>();

    // Find the symbol that is at the specified location in the document
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return null;

    // Make sure the module is parsed and resolved
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return null;

    // Local variables and parameters have special treatment that needs to be scope-aware,
    // we also only need to search within the module for these
    if (findSymbol.type == scriptfiles.ASSymbolType.LocalVariable
        || findSymbol.type == scriptfiles.ASSymbolType.Parameter)
    {
        let considerScopes : Array<scriptfiles.ASScope> = [];
        let checkscope = asmodule.getScopeAt(offset);
        while (checkscope)
        {
            if (!checkscope.isInFunctionBody())
                break;
            considerScopes.push(checkscope);
            checkscope = checkscope.parentscope;
        }

        for (let symbol of asmodule.symbols)
        {
            if (symbol.type != findSymbol.type)
                continue;
            if (symbol.container_type != findSymbol.container_type)
                continue;
            if (symbol.symbol_name != findSymbol.symbol_name)
                continue;

            // Need to check if the symbol is in our scope or one of our parent scopes
            let inScope = false;
            for (let scope of considerScopes)
            {
                if (symbol.start >= scope.end_offset)
                    continue;
                if (symbol.end < scope.start_offset)
                    continue;
                inScope = true;
                break;
            }

            if (inScope)
                references.push(asmodule.getLocationRange(symbol.start, symbol.end));
        }

        return references;
    }

    // If we search for accessors we also search for functions and vice-versa
    let alternateType = scriptfiles.ASSymbolType.NoSymbol;
    if (findSymbol.type == scriptfiles.ASSymbolType.MemberAccessor)
        alternateType = scriptfiles.ASSymbolType.MemberFunction;
    else if (findSymbol.type == scriptfiles.ASSymbolType.GlobalAccessor)
        alternateType = scriptfiles.ASSymbolType.GlobalFunction;
    else if (findSymbol.type == scriptfiles.ASSymbolType.MemberFunction)
        alternateType = scriptfiles.ASSymbolType.MemberAccessor;
    else if (findSymbol.type == scriptfiles.ASSymbolType.GlobalFunction)
        alternateType = scriptfiles.ASSymbolType.GlobalAccessor;

    // Look in all loaded modules (Slow!)
    for (let checkmodule of scriptfiles.GetAllModules())
    {
        // Make sure the module is parsed and resolved
        scriptfiles.ParseModuleAndDependencies(checkmodule);
        scriptfiles.PostProcessModuleTypesAndDependencies(checkmodule);
        scriptfiles.ResolveModule(checkmodule);

        // Find symbols that match the symbol we're trying to find
        for (let symbol of checkmodule.symbols)
        {
            if (symbol.type != findSymbol.type && symbol.type != alternateType)
                continue;
            if (symbol.container_type != findSymbol.container_type)
                continue;
            if (symbol.symbol_name != findSymbol.symbol_name)
                continue;

            references.push(checkmodule.getLocationRange(symbol.start, symbol.end));
        }
    }

    return references;
}

export function PrepareRename(uri : string, position : Position) : Range | ResponseError<void>
{
    // Find the symbol that is at the specified location in the document
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return null;

    // Make sure the module is parsed and resolved
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return null;

    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.TemplateBaseType:
        case scriptfiles.ASSymbolType.Namespace:
        {
            let dbtype = typedb.GetType(findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (!dbtype.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
        }
        break;
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let dbtype = typedb.GetType(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbmethod = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionOnly);
            if (!(dbmethod instanceof typedb.DBMethod))
                return null;
            if (!dbmethod.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbmethod.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        }
        break;
        case scriptfiles.ASSymbolType.GlobalVariable:
        case scriptfiles.ASSymbolType.MemberVariable:
            let dbtype = typedb.GetType(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbprop = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.PropertyOnly);
            if (!(dbprop instanceof typedb.DBProperty))
                return null;
            if (!dbprop.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbprop.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        break;
    }

    return asmodule.getRange(findSymbol.start, findSymbol.end);
}

export function PerformRename(uri : string, position : Position, baseReplaceWith : string) : Map<string, Array<TextEdit>>
{
    let edits = new Map<string, Array<TextEdit>>();

    // Find the symbol that is at the specified location in the document
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return null;

    // Make sure the module is parsed and resolved
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAt(offset);
    if (!findSymbol)
        return null;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return null;

    // Only rename symbols we can actually rename
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.TemplateBaseType:
        case scriptfiles.ASSymbolType.Namespace:
        {
            let dbtype = typedb.GetType(findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (!dbtype.declaredModule)
                return null;
        }
        break;
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let dbtype = typedb.GetType(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbmethod = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionOnly);
            if (!(dbmethod instanceof typedb.DBMethod))
                return null;
            if (!dbmethod.declaredModule)
                return null;
            if (dbmethod.isAutoGenerated)
                return null;
        }
        break;
        case scriptfiles.ASSymbolType.GlobalVariable:
        case scriptfiles.ASSymbolType.MemberVariable:
            let dbtype = typedb.GetType(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbprop = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.PropertyOnly);
            if (!(dbprop instanceof typedb.DBProperty))
                return null;
            if (!dbprop.declaredModule)
                return null;
            if (dbprop.isAutoGenerated)
                return null;
        break;
    }

    // If we're renaming an accessor we need to prepend the Get/Set
    let replaceText = baseReplaceWith;
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.MemberAccessor:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            if (findSymbol.symbol_name.startsWith("Get"))
                replaceText = "Get"+replaceText;
            else if (findSymbol.symbol_name.startsWith("Set"))
                replaceText = "Set"+replaceText;
        }
        break;
    }

    let accessorReplaceText = replaceText;
    if (accessorReplaceText.startsWith("Get") || accessorReplaceText.startsWith("Set"))
        accessorReplaceText = accessorReplaceText.substr(3);

    // Some symbol types are limited to scope
    let scopeLimited = false;
    let considerScopes : Array<scriptfiles.ASScope> = [];

    if (findSymbol.type == scriptfiles.ASSymbolType.LocalVariable)
        scopeLimited = true;
    else if (findSymbol.type == scriptfiles.ASSymbolType.Parameter)
        scopeLimited = true;

    if (scopeLimited)
    {
        let fileEdits = new Array<TextEdit>();
        edits.set(asmodule.uri, fileEdits);

        let checkscope = asmodule.getScopeAt(offset);
        while (checkscope)
        {
            if (!checkscope.isInFunctionBody())
                break;
            considerScopes.push(checkscope);
            checkscope = checkscope.parentscope;
        }

        // Find all symbols in the file that match
        for (let symbol of asmodule.symbols)
        {
            if (symbol.type != findSymbol.type)
                continue;
            if (symbol.container_type != findSymbol.container_type)
                continue;
            if (symbol.symbol_name != findSymbol.symbol_name)
                continue;

            // Need to check if the symbol is in our scope or one of our parent scopes
            if (scopeLimited)
            {
                let inScope = false;
                for (let scope of considerScopes)
                {
                    if (symbol.start >= scope.end_offset)
                        continue;
                    if (symbol.end < scope.start_offset)
                        continue;
                    inScope = true;
                    break;
                }

                if (!inScope)
                    continue;
            }

            fileEdits.push(
                TextEdit.replace(
                    asmodule.getRange(symbol.start, symbol.end),
                    replaceText
                )
            );
        }
    }
    else
    {
        // If we search for accessors we also search for functions and vice-versa
        let alternateType = scriptfiles.ASSymbolType.NoSymbol;
        if (findSymbol.type == scriptfiles.ASSymbolType.MemberAccessor)
            alternateType = scriptfiles.ASSymbolType.MemberFunction;
        else if (findSymbol.type == scriptfiles.ASSymbolType.GlobalAccessor)
            alternateType = scriptfiles.ASSymbolType.GlobalFunction;
        else if (findSymbol.type == scriptfiles.ASSymbolType.MemberFunction)
            alternateType = scriptfiles.ASSymbolType.MemberAccessor;
        else if (findSymbol.type == scriptfiles.ASSymbolType.GlobalFunction)
            alternateType = scriptfiles.ASSymbolType.GlobalAccessor;

        // Look in all loaded modules (Slow!)
        for (let checkmodule of scriptfiles.GetAllModules())
        {
            // Make sure the module is parsed and resolved
            scriptfiles.ParseModuleAndDependencies(checkmodule);
            scriptfiles.PostProcessModuleTypesAndDependencies(checkmodule);
            scriptfiles.ResolveModule(checkmodule);

            // Find symbols that match the symbol we're trying to find
            let fileEdits : Array<TextEdit> = null;

            for (let symbol of checkmodule.symbols)
            {
                if (symbol.type != findSymbol.type && symbol.type != alternateType)
                    continue;
                if (symbol.container_type != findSymbol.container_type)
                    continue;
                if (symbol.symbol_name != findSymbol.symbol_name)
                    continue;

                if (!fileEdits)
                {
                    fileEdits = new Array<TextEdit>();
                    edits.set(asmodule.uri, fileEdits);
                }

                let isAccessor = (symbol.type == scriptfiles.ASSymbolType.MemberAccessor
                                    || symbol.type == scriptfiles.ASSymbolType.GlobalAccessor);
                fileEdits.push(
                    TextEdit.replace(
                        asmodule.getRange(symbol.start, symbol.end),
                        isAccessor ? accessorReplaceText : replaceText
                    )
                );
            }
        }
    }

    return edits;
}