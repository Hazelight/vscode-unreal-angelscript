import * as scriptfiles from './as_parser';
import * as completion from './completion';
import * as typedb from './database';
import * as assets from './assets';

import { Range, Position, Location, CodeLens, InitializedNotification, Command } from "vscode-languageserver";

export function ComputeCodeLenses(asmodule : scriptfiles.ASModule) : Array<CodeLens>
{
    let lenses = new Array<CodeLens>();

    // Add lenses for each scope in the file
    AddScopeLenses(asmodule.rootscope, lenses);

    return lenses;
}

function AddScopeLenses(scope : scriptfiles.ASScope, lenses : Array<CodeLens>)
{
    if (scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        // Add a lense for blueprint references if we have any
        if (scope.dbtype && !scope.dbtype.isStruct)
            AddAssetImplementationsLense(scope, scope.dbtype, lenses);
    }

    // Recurse into subscopes
    for (let subscope of scope.scopes)
        AddScopeLenses(subscope, lenses);
}

function AddAssetImplementationsLense(scope : scriptfiles.ASScope, dbtype : typedb.DBType, lenses : Array<CodeLens>)
{
    let references = assets.GetAssetsImplementing(dbtype.typename);
    if (!references || references.length == 0)
        return;

    let message : string = null;
    let isDataAsset = dbtype.inheritsFrom("UDataAsset");

    if (references.length == 1 && !isDataAsset)
    {
        message = "Implemented by "+assets.GetShortAssetName(references[0]);
    }
    else if (references.length <= 3)
    {
        if (isDataAsset)
            message = "Used by data assets: ";
        else
            message = "Implemented by ";

        for (let i = 0; i < references.length; ++i)
        {
            if (i != 0)
                message += ", "
            message += assets.GetShortAssetName(references[i]);
        }
    }
    else
    {
        if (isDataAsset)
            message = "Used by "+ references.length +" data assets";
        else
            message = "Implemented by "+ references.length +" blueprints";
    }

    let startPos = scope.module.getPosition(dbtype.moduleOffset);
    let lensLine = Math.max(startPos.line, 0);

    lenses.push(<CodeLens> {
		range: Range.create(Position.create(lensLine, 0), Position.create(lensLine, 10000)),
		command: <Command> {
			title: message,
			command: "angelscript.openAssets",
            arguments: [dbtype.typename],
		}
    });
}