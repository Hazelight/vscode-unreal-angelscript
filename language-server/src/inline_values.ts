import * as scriptfiles from './as_parser';
import * as typedb from './database';
import { Range, Position } from "vscode-languageserver";

export interface InlineValueSettings
{
    showInlineValueForLocalVariables : boolean;
    showInlineValueForParameters : boolean;
    showInlineValueForMemberAssignment : boolean;
    showInlineValueForFunctionThisObject : boolean;
};

let InlineValueSettings : InlineValueSettings = {
    showInlineValueForLocalVariables : true,
    showInlineValueForParameters : true,
    showInlineValueForMemberAssignment : true,
    showInlineValueForFunctionThisObject : true,
};

export function GetInlineValueSettings() : InlineValueSettings
{
    return InlineValueSettings;
}

export function ProvideInlineValues(asmodule : scriptfiles.ASModule, position : Position)
{
    let offset = asmodule.getOffset(position);
    let scope = asmodule.getScopeAt(offset);
    if (!scope)
        return null;

    let context = new InlineValueContext;
    context.values = new Array<any>();
    context.offset = offset;
    context.asmodule = asmodule;
    context.inType = scope.getParentType();

    // Show the this pointer above the function
    if (InlineValueSettings.showInlineValueForFunctionThisObject)
        AddThisObjectInlineValue(context, scope);

    // Add values for stuff in the scope we're in
    AddScopeInlineValues(context, scope);

    return context.values;
}

class InlineValueContext
{
    asmodule : scriptfiles.ASModule;
    inType : typedb.DBType;
    values : Array<any>;
    offset : number;

    shownMembers = new Set<string>();
};

// Structs that we should show inline values for, other structs are not shown
let WhitelistedInlineStructs = new Set<string>([
    "FVector", "FVector2D", "FVector4", "FIntVector",
    "FRotator", "FName", "FString", "FColor", "FLinearColor",
    "FText",
]);

function CanTypeHaveInlineValue(typename : string) : boolean
{
    let dbType = typedb.GetType(typename);
    if (!dbType)
        return false;

    if (dbType.isStruct && !dbType.isTemplateInstantiation)
    {
        if (!WhitelistedInlineStructs.has(dbType.typename))
            return false;
    }

    return true;
}

function AddThisObjectInlineValue(context : InlineValueContext, scope : scriptfiles.ASScope)
{
    // Show the this pointer above the function
    let inFunction = scope.getParentFunction();
    let functionScope = scope.getParentFunctionScope();
    if (context.inType && !context.inType.isNamespaceOrGlobalScope() && inFunction && functionScope)
    {
        let range : Range = null;

        // Figure out the correct position to show above-function hints
        let declaration = functionScope.declaration;
        if (declaration && declaration.ast)
        {
            let startOffset = declaration.start_offset;
            let lineOffset = 0;

            if (declaration.ast.macro)
            {
                startOffset += declaration.ast.macro.start;
                lineOffset = -1;
            }
            else if (declaration.ast.name)
            {
                startOffset += declaration.ast.name.start;
                lineOffset = -1;
            }

            let statementStart = context.asmodule.getPosition(declaration.start_offset);
            let startPos = context.asmodule.getPosition(startOffset);

            startPos.line += lineOffset;
            if (startPos.line < statementStart.line+1)
                startPos.line = statementStart.line+1;

            startPos.character = 4;
            
            range = Range.create(startPos, startPos);
        }
        else
        {
            range = context.asmodule.getRange(
                inFunction.moduleOffset,
                inFunction.moduleOffsetEnd);
        }

        // Figure out which above-function hints to show
        if (context.inType.inheritsFrom("AActor"))
        {
            context.values.push({
                range: range,
                expression: "this",
            });
        }
        else if (context.inType.inheritsFrom("UActorComponent"))
        {
            context.values.push({
                range: range,
                expression: "Owner",
            });

            context.values.push({
                range: range,
                expression: "this",
            });
        }
        else if (context.inType.getProperty("Owner"))
        {
            context.values.push({
                range: range,
                expression: "Owner",
            });

            context.values.push({
                range: range,
                expression: "this",
            });
        }
        else
        {
            context.values.push({
                range: range,
                expression: "this",
            });
        }
    }
}

function AddScopeInlineValues(context : InlineValueContext, scope : scriptfiles.ASScope)
{
    if (scope.scopetype != scriptfiles.ASScopeType.Function
        && scope.scopetype != scriptfiles.ASScopeType.Code)
    {
        return;
    }

    // Any local variable declarations should get inline values
    for (let scopeVar of scope.variables)
    {
        if (scopeVar.start_offset_name >= context.offset)
            continue;
        if (!CanTypeHaveInlineValue(scopeVar.typename))
            continue;

        if (scopeVar.isArgument)
        {
            if (!InlineValueSettings.showInlineValueForParameters)
                continue;
        }
        else
        {
            if (!InlineValueSettings.showInlineValueForLocalVariables)
                continue;
        }

        context.values.push({
            range: context.asmodule.getRange(scopeVar.start_offset_name, scopeVar.end_offset_name),
            variable: scopeVar.name,
        });
    }

    // Go over the AST of the scope to find statements that can use inline values
    if (context.inType)
    {
        for (let i = scope.statements.length - 1; i >= 0; --i)
        {
            let statement = scope.statements[i];
            if (!statement)
                continue;
            if (!statement.ast)
                continue;
            if (statement.start_offset >= context.offset)
                continue;

            let node = statement.ast;

            if (InlineValueSettings.showInlineValueForMemberAssignment)
            {
                if (node.type == scriptfiles.node_types.Assignment
                    || node.type == scriptfiles.node_types.CompoundAssignment)
                {
                    // If we are assigning to a member variable, show its value
                    if (node.children[0] && node.children[0].type == scriptfiles.node_types.Identifier)
                    {
                        let identifier = node.children[0].value;
                        let memberVar = context.inType.getProperty(identifier);

                        if (memberVar
                            && !context.shownMembers.has(memberVar.name)
                            && CanTypeHaveInlineValue(memberVar.typename))
                        {
                            context.values.push({
                                range: context.asmodule.getRange(
                                    statement.start_offset + node.children[0].start,
                                    statement.start_offset + node.children[0].end),
                                variable: memberVar.name,
                            });

                            context.shownMembers.add(memberVar.name);
                        }
                    }
                }
            }
        }
    }

    // Add variables from the parent scope as well
    if (scope.parentscope)
        AddScopeInlineValues(context, scope.parentscope);
}