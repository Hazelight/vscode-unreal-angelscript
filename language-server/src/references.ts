import * as scriptfiles from './as_parser';
import * as completion from './completion';

import { Range, Position, Location, } from "vscode-languageserver";

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

    // Look in all loaded modules (Slow!)
    for (let checkmodule of scriptfiles.GetAllModules())
    {
        // Make sure the module is parsed and resolved
        scriptfiles.ParseModuleAndDependencies(asmodule);
        scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
        scriptfiles.ResolveModule(asmodule);

        // Find symbols that match the symbol we're trying to find
        for (let symbol of checkmodule.symbols)
        {
            if (symbol.type != findSymbol.type)
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