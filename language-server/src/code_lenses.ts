import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as assets from './assets';
import * as fs from 'fs';
import * as path from 'path';

import { Range, Position, Location, CodeLens, InitializedNotification, Command } from "vscode-languageserver";

class ASFileTemplate
{
    name : string;
    content : string;
    order : number = 0;
}

let FileTemplates = new Array<ASFileTemplate>();

export interface CodeLensSettings
{
    engineSupportsCreateBlueprint : boolean;
    showCreateBlueprintClasses : Array<string>;
};

let CodeLensSettings : CodeLensSettings = {
    engineSupportsCreateBlueprint : false,
    showCreateBlueprintClasses : [],
};

export function GetCodeLensSettings() : CodeLensSettings
{
    return CodeLensSettings;
}

export function LoadFileTemplates(filenames : Array<string>)
{
    let templateNames = new Set<string>();
    for (let file of filenames)
    {
        try
        {
            let content = fs.readFileSync(file, 'utf8');

            let basename = path.basename(file, ".as.template");

            let template = new ASFileTemplate();
            template.content = content;
            template.name = basename.replace("_", " ");

            let match = template.name.match(/^([0-9]+)\.(.*)/);
            if (match)
            {
                template.name = match[2];
                template.order = parseInt(match[1]);
            }

            if (!templateNames.has(template.name.toLowerCase()))
            {
                templateNames.add(template.name.toLowerCase());
                FileTemplates.push(template);
            }
        }
        catch (readError)
        {
            continue;
        }
    }

    // Add default templates for actor and component if they don't already exist
    if (!templateNames.has("actor"))
    {
        let template = new ASFileTemplate();
        template.content =
`class A\${TM_FILENAME_BASE} : AActor
{
	UPROPERTY(DefaultComponent, RootComponent)
	USceneComponent Root;$0

	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
	}
};`;
        template.name = "Actor";
        FileTemplates.push(template);
    }

    if (!templateNames.has("component"))
    {
        let template = new ASFileTemplate();
        template.content =
`class U\${TM_FILENAME_BASE} : UActorComponent
{$0
	UFUNCTION(BlueprintOverride)
	void BeginPlay()
	{
	}
};`;
        template.name = "Component";
        FileTemplates.push(template);
    }

    FileTemplates.sort(
        function(a : ASFileTemplate, b : ASFileTemplate) : number {
            if (a.order < b.order)
                return -1;
            else if (a.order > b.order)
                return 1;
            else
                return 0;
        }
    );
}

export function ComputeCodeLenses(asmodule : scriptfiles.ASModule) : Array<CodeLens>
{
    let lenses = new Array<CodeLens>();

    // Add lenses for each scope in the file
    AddScopeLenses(asmodule.rootscope, lenses);

    // If the file is empty, add lenses for activating templates
    if (asmodule.rootscope.next == null && FileTemplates.length != 0 && asmodule.content.match(/^[\s\r\n]*$/))
    {
        for (let template of FileTemplates)
        {
            if (template.content.length == 0)
                continue;

            lenses.push(<CodeLens> {
                range: Range.create(Position.create(0, 0), Position.create(0, 10000)),
                command: <Command> {
                    title: "Create "+template.name,
                    command: "editor.action.insertSnippet",
                    arguments: [{
                        "snippet": template.content
                    }],
                }
            });
        }
    }

    // Some literal assets should be able to open in the editor
    for (let asset of asmodule.literalAssets)
    {
        let dbtype = typedb.GetTypeByName(asset.type);
        if (!dbtype)
            continue;

        let canEdit = false;
        if (dbtype.inheritsFrom("UCurveFloat"))
            canEdit = true;

        if (canEdit)
        {
            let startPos = asmodule.getPosition(asset.statement.end_offset);
            let lensLine = Math.max(startPos.line-1, 0);

            lenses.push(<CodeLens> {
                range: Range.create(Position.create(lensLine, 0), Position.create(lensLine, 10000)),
                command: <Command> {
                    title: "Edit "+asset.name+" in Unreal",
                    command: "angelscript.editAsset",
                    arguments: ["/Script/AngelscriptAssets."+asset.name],
                }
            });
        }
    }

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

export function AllowCreateBlueprintForClass(dbtype : typedb.DBType) : boolean
{
    if (!CodeLensSettings.engineSupportsCreateBlueprint)
        return false;
    if (dbtype.macroSpecifiers && dbtype.macroSpecifiers.has("NotBlueprintable"))
        return false;
    return true;
}

function ShowCreateBlueprintForClass(dbtype : typedb.DBType) : boolean
{
    if (!AllowCreateBlueprintForClass(dbtype))
        return false;
    if (dbtype.inheritsFrom("UDataAsset"))
        return true;
    for (let showClass of CodeLensSettings.showCreateBlueprintClasses)
    {
        if (dbtype.inheritsFrom(showClass))
            return true;
    }
    return false;
}

function AddAssetImplementationsLense(scope : scriptfiles.ASScope, dbtype : typedb.DBType, lenses : Array<CodeLens>)
{
    let references = assets.GetAssetsImplementing(dbtype.name);
    if (references && references.length != 0)
    {
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
                arguments: [dbtype.name],
            }
        });

        if (isDataAsset && AllowCreateBlueprintForClass(dbtype))
        {
            lenses.push(<CodeLens> {
                range: Range.create(Position.create(lensLine, 0), Position.create(lensLine, 10000)),
                command: <Command> {
                    title: "Create Asset",
                    command: "angelscript.saveAndCreateBlueprint",
                    arguments: [scope.module.uri, dbtype.name],
                }
            });
        }
    }
    else if (ShowCreateBlueprintForClass(dbtype))
    {
        let startPos = scope.module.getPosition(dbtype.moduleOffset);
        let lensLine = Math.max(startPos.line, 0);

        let isDataAsset = dbtype.inheritsFrom("UDataAsset");
        let message : string = null;
        if (isDataAsset)
            message = "Create Asset";
        else
            message = "Create Blueprint";

        lenses.push(<CodeLens> {
            range: Range.create(Position.create(lensLine, 0), Position.create(lensLine, 10000)),
            command: <Command> {
                title: message,
                command: "angelscript.saveAndCreateBlueprint",
                arguments: [scope.module.uri, dbtype.name],
            }
        });
    }
}