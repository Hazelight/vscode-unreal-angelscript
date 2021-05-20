import * as scriptfiles from './as_parser';

import { Range, Position, Location, DocumentHighlight, DocumentHighlightKind } from "vscode-languageserver";

export function HighlightOccurances(uri : string, position : Position) : Array<DocumentHighlight>
{
    let matches = new Array<DocumentHighlight>();

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

    // Unknown symbols cannot be highlighted
    if (findSymbol.type == scriptfiles.ASSymbolType.UnknownError)
        return null;

    let scopeLimited = false;
    if (findSymbol.type == scriptfiles.ASSymbolType.LocalVariable)
        scopeLimited = true;
    else if (findSymbol.type == scriptfiles.ASSymbolType.Parameter)
        scopeLimited = true;

    let declaredScope : scriptfiles.ASScope = null;

    if (scopeLimited)
    {
        declaredScope = asmodule.getScopeDeclaringLocalSymbol(findSymbol);
        if (!declaredScope)
            return null;
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
            if (symbol.start >= declaredScope.end_offset)
                continue;
            if (symbol.end < declaredScope.start_offset)
                continue;
        }

        let highlight = DocumentHighlight.create(
            asmodule.getRange(symbol.start, symbol.end),
            symbol.isWriteAccess ? DocumentHighlightKind.Write : DocumentHighlightKind.Read
        );
        matches.push(highlight);
    }

    return matches;
}