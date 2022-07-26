import * as typedb from './database';
import * as scriptfiles from './as_parser';

import {
    Position, TypeHierarchyItem, SymbolKind,
    Range,
} from 'vscode-languageserver/node';

export function PrepareTypeHierarchy(asmodule : scriptfiles.ASModule, position : Position) : TypeHierarchyItem[]
{
    let findSymbol = asmodule.getSymbolAtOrBefore(asmodule.getOffset(position));
    if (!findSymbol)
        return null;

    let dbtype : typedb.DBType = null;
    switch (findSymbol.type)
    {
        case scriptfiles.ASSymbolType.Typename:
        case scriptfiles.ASSymbolType.Namespace:
        {
            dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
        }
    }

    if (!dbtype)
        return null;
    return [GetTypeHierarchyItem(dbtype)];
}

function GetTypeHierarchyItem(dbtype : typedb.DBType) : TypeHierarchyItem
{
    let symDetail : string = null;
    let symKind : SymbolKind = SymbolKind.Class;

    if (dbtype.isStruct)
    {
        symKind = SymbolKind.Struct;
        symDetail = "struct "+dbtype.getDisplayName();
    }
    else if (dbtype.isEnum)
    {
        symKind = SymbolKind.Enum;
        symDetail = "enum "+dbtype.getDisplayName();
    }
    else
    {
        symKind = SymbolKind.Class;
        if (dbtype.supertype)
            symDetail = "class "+dbtype.getDisplayName()+" : "+dbtype.supertype;
        else
            symDetail = "class "+dbtype.getDisplayName();
    }

    let uri = "";
    let range : Range = Range.create(0,0, 0,0)
    let selectionRange : Range = Range.create(0,0, 0,0);

    if (dbtype.declaredModule)
    {
        let asmodule = scriptfiles.GetModule(dbtype.declaredModule);
        if (asmodule)
        {
            uri = asmodule.displayUri;
            range = asmodule.getRange(dbtype.moduleScopeStart, dbtype.moduleScopeEnd);
            selectionRange = asmodule.getRange(dbtype.moduleOffset, dbtype.moduleOffsetEnd);
        }
    }
    else
    {
        symKind = SymbolKind.Interface;
    }

    return <TypeHierarchyItem> {
        name: dbtype.getDisplayName(),
        kind: symKind,
        detail: symDetail,
        uri: uri,
        range: range,
        selectionRange: selectionRange,
        data: dbtype.name,
    };
}

export function GetTypeHierarchySupertypes(item : TypeHierarchyItem) : TypeHierarchyItem[]
{
    let dbtype = typedb.GetTypeByName(item.data);
    if (!dbtype || !dbtype.supertype)
        return [];

    let dbsuper = dbtype.getSuperType();
    if (!dbsuper)
        return [];

    return [GetTypeHierarchyItem(dbsuper)];
}

export function GetTypeHierarchySubtypes(item : TypeHierarchyItem) : TypeHierarchyItem[]
{
    let dbtype = typedb.GetTypeByName(item.data);
    if (!dbtype)
        return [];

    let subTypes : Array<TypeHierarchyItem> = [];
    for (let [_, checkType] of typedb.GetAllTypesById())
    {
        if (checkType.supertype == dbtype.name)
            subTypes.push(GetTypeHierarchyItem(checkType));
    }

    return subTypes;
}