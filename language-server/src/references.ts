import * as scriptfiles from './as_parser';
import * as typedb from './database';

import { Range, Position, Location, TextEdit, ResponseError } from "vscode-languageserver";

export function* FindReferences(uri : string, position : Position) : any
{
    let references = new Array<Location>();

    // Find the symbol that is at the specified location in the document
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return references;

    // Make sure the module is parsed and resolved
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
    if (!findSymbol)
        return references;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return references;

    // Local variables and parameters have special treatment that needs to be scope-aware,
    // we also only need to search within the module for these
    if (findSymbol.type == scriptfiles.ASSymbolType.LocalVariable
        || findSymbol.type == scriptfiles.ASSymbolType.Parameter)
    {
        let declaredScope = asmodule.getScopeDeclaringLocalSymbol(findSymbol);
        if (!declaredScope)
            return references;
        for (let symbol of asmodule.semanticSymbols)
        {
            if (symbol.type != findSymbol.type)
                continue;
            if (symbol.container_type != findSymbol.container_type)
                continue;
            if (symbol.symbol_name != findSymbol.symbol_name)
                continue;

            // Need to check if the symbol is within where our symbol is declared
            if (symbol.start >= declaredScope.end_offset)
                continue;
            if (symbol.end < declaredScope.start_offset)
                continue;

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

    let considerModules : Array<scriptfiles.ASModule> = null;

    // Some symbol types only need to be searched within the current file
    if (findSymbol.type == scriptfiles.ASSymbolType.AccessSpecifier)
        considerModules = [asmodule];
    else
        considerModules = scriptfiles.GetModulesPotentiallyImportingSymbol(asmodule, findSymbol);

    // If we're looking for a method, we should also include any overrides from derived types
    let searchForTypes = new Set<string>();
    searchForTypes.add(findSymbol.container_type);

    if (findSymbol.type == scriptfiles.ASSymbolType.MemberFunction
        || findSymbol.type == scriptfiles.ASSymbolType.MemberAccessor)
    {
        // First find the parent-most type that has this method
        let checkParent = typedb.GetTypeByName(findSymbol.container_type);
        while (checkParent)
        {
            let nextParent = checkParent.getSuperType();
            if (nextParent && nextParent.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Functions))
            {
                checkParent = nextParent;
                continue;
            }
            else
            {
                break;
            }
        }

        // Update which modules to search in based on our parent
        if (checkParent && checkParent.name != findSymbol.container_type)
        {
            if (checkParent.declaredModule)
                considerModules = scriptfiles.GetModulesPotentiallyImporting(checkParent.declaredModule);
            else
                considerModules = scriptfiles.GetAllLoadedModules();
        }
        searchForTypes.add(checkParent.name);

        // Types don't have a list of inherited types, so we need to recursively
        // search for types that have one of our search types as parent. Shouldn't take
        // more than a few sweeps.
        let lastTypeCount = 0;
        while (lastTypeCount != searchForTypes.size)
        {
            lastTypeCount = searchForTypes.size;
            for (let [_, searchType] of typedb.GetAllTypesById())
            {
                if (searchType && searchForTypes.has(searchType.supertype))
                    searchForTypes.add(searchType.name);
            }
        }
    }

    // See if there's any auxiliary symbols we need to check for
    let auxSymbols : Array<typedb.DBAuxiliarySymbol> = null;
    {
        if (findSymbol.type == scriptfiles.ASSymbolType.GlobalFunction
            || findSymbol.type == scriptfiles.ASSymbolType.GlobalVariable
            || findSymbol.type == scriptfiles.ASSymbolType.GlobalAccessor)
        {
            let insideNamespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (insideNamespace)
            {
                let findDbSym = insideNamespace.findFirstSymbol(findSymbol.symbol_name);
                if (findDbSym)
                    auxSymbols = findDbSym.auxiliarySymbols;
            }
        }
        else
        {
            let insideType = typedb.GetTypeByName(findSymbol.container_type);
            if (insideType)
            {
                let findDbSym = insideType.findFirstSymbol(findSymbol.symbol_name);
                if (findDbSym)
                    auxSymbols = findDbSym.auxiliarySymbols;
            }
        }

        if (auxSymbols)
        {
            for (let auxSym of auxSymbols)
                searchForTypes.add(auxSym.container_type);
        }
    }

    // Look in all considered modules (Slow!)
    let parseCount = 0;
    for (let checkmodule of considerModules)
    {
        // Count how much parsing we're doing
        if (!checkmodule.resolved)
            parseCount += 100;
        else
            parseCount += 1;

        // Make sure the module is parsed and resolved
        scriptfiles.ParseModuleAndDependencies(checkmodule);
        scriptfiles.PostProcessModuleTypesAndDependencies(checkmodule);
        scriptfiles.ResolveModule(checkmodule);

        // Find symbols that match the symbol we're trying to find
        if (auxSymbols)
        {
            for (let symbol of checkmodule.semanticSymbols)
            {
                if (!searchForTypes.has(symbol.container_type))
                    continue;

                let matchesSymbol = false;
                if ((symbol.type == findSymbol.type || symbol.type == alternateType)
                    && symbol.symbol_name == findSymbol.symbol_name
                    && searchForTypes.has(symbol.container_type))
                {
                    matchesSymbol = true;
                }
                else
                {
                    for (let auxSym of auxSymbols)
                    {
                        if (symbol.symbol_name == auxSym.symbol_name
                            && symbol.container_type == auxSym.container_type)
                        {
                            matchesSymbol = true;
                            break;
                        }
                    }
                }

                if (!matchesSymbol)
                    continue;

                references.push(checkmodule.getLocationRange(symbol.start, symbol.end));
            }
        }
        else
        {
            for (let symbol of checkmodule.semanticSymbols)
            {
                if (symbol.type != findSymbol.type && symbol.type != alternateType)
                    continue;
                if (symbol.symbol_name != findSymbol.symbol_name)
                    continue;
                if (!searchForTypes.has(symbol.container_type))
                    continue;

                references.push(checkmodule.getLocationRange(symbol.start, symbol.end));
            }
        }

        // Yield out after we've done some amount of parse work
        if (parseCount >= 100)
        {
            parseCount = 0;
            yield null;
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
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
    if (!findSymbol)
        return null;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return null;

    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.TemplateBaseType:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (!dbtype.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
        }
        break;
        case scriptfiles.ASSymbolType.Namespace:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (namespace.getCppDeclaration())
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
        }
        break;
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;
            let dbmethod = namespace.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionsAndMixins);
            if (!(dbmethod instanceof typedb.DBMethod))
                return null;
            if (!dbmethod.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbmethod.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        }
        break;
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.MemberAccessor:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbmethod = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionsAndMixins);
            if (!(dbmethod instanceof typedb.DBMethod))
                return null;
            if (!dbmethod.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbmethod.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        }
        break;
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return null;
            let dbprop = namespace.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (!(dbprop instanceof typedb.DBProperty))
                return null;
            if (!dbprop.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbprop.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.container_type);
            if (!dbtype)
                return null;
            let dbprop = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (!(dbprop instanceof typedb.DBProperty))
                return null;
            if (!dbprop.declaredModule)
                return new ResponseError<void>(0, "Cannot rename symbols declared in C++");
            if (dbprop.isAutoGenerated)
                return new ResponseError<void>(0, "Cannot rename autogenerated symbols.");
        }
        break;
    }

    return asmodule.getRange(findSymbol.start, findSymbol.end);
}

export function* PerformRename(uri : string, position : Position, baseReplaceWith : string) : any
{
    let edits = new Map<string, Array<TextEdit>>();

    // Find the symbol that is at the specified location in the document
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return edits;

    // Make sure the module is parsed and resolved
    scriptfiles.ParseModuleAndDependencies(asmodule);
    scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
    scriptfiles.ResolveModule(asmodule);

    let offset = asmodule.getOffset(position);
    let findSymbol = asmodule.getSymbolAtOrBefore(offset);
    if (!findSymbol)
        return edits;

    // Unknown symbols cannot be searched for
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return edits;

    // Only rename symbols we can actually rename
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.TemplateBaseType:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (!dbtype.declaredModule)
                return edits;
        }
        break;
        case scriptfiles.ASSymbolType.Namespace:
            let namespace = typedb.LookupNamespace(null, findSymbol.symbol_name);
            // We can only edit typenames that are declared in a script file
            if (namespace.getCppDeclaration())
                return edits;
        break;
        case scriptfiles.ASSymbolType.MemberFunction:
        case scriptfiles.ASSymbolType.MemberAccessor:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.container_type);
            if (!dbtype)
                return edits;
            let dbmethod = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionsAndMixins);
            if (!(dbmethod instanceof typedb.DBMethod))
                return edits;
            if (!dbmethod.declaredModule)
                return edits;
            if (dbmethod.isAutoGenerated)
                return edits;
        }
        break;
        case scriptfiles.ASSymbolType.GlobalFunction:
        case scriptfiles.ASSymbolType.GlobalAccessor:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return edits;
            let dbmethod = namespace.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.FunctionsAndMixins);
            if (!(dbmethod instanceof typedb.DBMethod))
                return edits;
            if (!dbmethod.declaredModule)
                return edits;
            if (dbmethod.isAutoGenerated)
                return edits;
        }
        break;
        case scriptfiles.ASSymbolType.GlobalVariable:
        {
            let namespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (!namespace)
                return edits;
            let dbprop = namespace.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (!(dbprop instanceof typedb.DBProperty))
                return edits;
            if (!dbprop.declaredModule)
                return edits;
            if (dbprop.isAutoGenerated)
                return edits;
        }
        break;
        case scriptfiles.ASSymbolType.MemberVariable:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.container_type);
            if (!dbtype)
                return edits;
            let dbprop = dbtype.findFirstSymbol(findSymbol.symbol_name, typedb.DBAllowSymbol.Properties);
            if (!(dbprop instanceof typedb.DBProperty))
                return edits;
            if (!dbprop.declaredModule)
                return edits;
            if (dbprop.isAutoGenerated)
                return edits;
        }
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
        edits.set(asmodule.displayUri, fileEdits);

        let declaredScope = asmodule.getScopeDeclaringLocalSymbol(findSymbol);
        if (!declaredScope)
            return edits;

        // Find all symbols in the file that match
        for (let symbol of asmodule.semanticSymbols)
        {
            if (symbol.type != findSymbol.type)
                continue;
            if (symbol.container_type != findSymbol.container_type)
                continue;
            if (symbol.symbol_name != findSymbol.symbol_name)
                continue;
            if (symbol.isAuto)
                continue;

            // Need to check if the symbol is in our scope
            if (symbol.start >= declaredScope.end_offset)
                continue;
            if (symbol.end < declaredScope.start_offset)
                continue;

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

        let parseCount = 0;

        let considerModules : Array<scriptfiles.ASModule> = null;

        // Some symbol types only need to be searched within the current file
        if (findSymbol.type == scriptfiles.ASSymbolType.AccessSpecifier)
            considerModules = [asmodule];
        else
            considerModules = scriptfiles.GetModulesPotentiallyImportingSymbol(asmodule, findSymbol);

        // Look in all considered modules (Slow!)
        for (let checkmodule of considerModules)
        {
            // Count how much parsing we're doing
            if (!checkmodule.resolved)
                parseCount += 100;
            else
                parseCount += 1;

            // Make sure the module is parsed and resolved
            scriptfiles.ParseModuleAndDependencies(checkmodule);
            scriptfiles.PostProcessModuleTypesAndDependencies(checkmodule);
            scriptfiles.ResolveModule(checkmodule);

            // Find symbols that match the symbol we're trying to find
            let fileEdits : Array<TextEdit> = null;

            for (let symbol of checkmodule.semanticSymbols)
            {
                if (symbol.type != findSymbol.type && symbol.type != alternateType)
                    continue;
                if (symbol.container_type != findSymbol.container_type)
                    continue;
                if (symbol.symbol_name != findSymbol.symbol_name)
                    continue;
                if (symbol.isAuto)
                    continue;

                if (!fileEdits)
                {
                    fileEdits = new Array<TextEdit>();
                    edits.set(checkmodule.displayUri, fileEdits);
                }

                let isAccessor = (symbol.type == scriptfiles.ASSymbolType.MemberAccessor
                                    || symbol.type == scriptfiles.ASSymbolType.GlobalAccessor);
                fileEdits.push(
                    TextEdit.replace(
                        checkmodule.getRange(symbol.start, symbol.end),
                        isAccessor ? accessorReplaceText : replaceText
                    )
                );
            }

            // Yield out after we've done some amount of parse work
            if (parseCount >= 100)
            {
                parseCount = 0;
                yield null;
            }
        }
    }

    return edits;
}