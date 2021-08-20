import { Diagnostic, DiagnosticSeverity, DiagnosticTag, Position } from 'vscode-languageserver/node';
import * as typedb from './database';
import * as scriptfiles from './as_parser';

let node_types = require("../grammar/node_types.js");

export interface DiagnosticSettings
{
    namingConventionDiagnostics : boolean,
    markUnreadVariablesAsUnused : boolean,
};

let DiagnosticSettings : DiagnosticSettings = {
    namingConventionDiagnostics: true,
    markUnreadVariablesAsUnused: false,
};

// Diagnostics sent over to us by the unreal editor
let CompileDiagnostics = new Map<string, Array<Diagnostic>>();
// Diagnostics we have determined from within the language server
let ParseDiagnostics = new Map<string, Array<Diagnostic>>();

// Functions that should be notified when diagnostics change
let NotifyFunctions = new Array<any>();

export function UpdateCompileDiagnostics(uri : string, diagnostics : Array<Diagnostic>)
{
    CompileDiagnostics.set(scriptfiles.NormalizeUri(uri), diagnostics);
    NotifyDiagnostics(uri);
}

export function GetDiagnosticSettings() : DiagnosticSettings
{
    return DiagnosticSettings;
}

function NotifyDiagnostics(uri : string, notifyEmpty = true)
{
    let allDiagnostics : Array<Diagnostic> = [];
    let fromCompile = CompileDiagnostics.get(scriptfiles.NormalizeUri(uri));
    if (fromCompile)
    {
        let asmodule = scriptfiles.GetModuleByUri(uri);
        if (!asmodule || asmodule.exists)
            allDiagnostics = allDiagnostics.concat(fromCompile);
        if (asmodule && asmodule.loaded)
            TrimDiagnosticPositions(asmodule, allDiagnostics);
    }

    let fromParse = ParseDiagnostics.get(scriptfiles.NormalizeUri(uri));
    if (fromParse)
        allDiagnostics = allDiagnostics.concat(fromParse);

    if (notifyEmpty || allDiagnostics.length != 0)
    {
        for (let func of NotifyFunctions)
            func(uri, allDiagnostics);
    }
}

function HasCompileDiagnostics(asmodule : scriptfiles.ASModule)
{
    let fromCompile = CompileDiagnostics.get(asmodule.uri);
    return fromCompile && fromCompile.length != 0;
}

export function OnDiagnosticsChanged(bindFunction : any)
{
    NotifyFunctions.push(bindFunction);
}

export function UpdateScriptModuleDiagnostics(asmodule : scriptfiles.ASModule, initialResolve = false, alwaysSend = false)
{
    let diagnostics = new Array<Diagnostic>();
    if (!asmodule.rootscope)
        return;
    
    // Go through all the parsed scopes and add diagnostics
    AddScopeDiagnostics(asmodule.rootscope, diagnostics);

    // Add diagnostics for delegate function bind verification
    VerifyDelegateBinds(asmodule, diagnostics);

    // Add diagnostics for symbols that aren't imported
    AddSymbolDiagnostics(asmodule, diagnostics);

    // Add diagnostics for variables that don't confirm to the naming convention
    AddNamingConventionDiagnostics(asmodule, diagnostics);

    // Update stored diagnostics
    let oldDiagnostics = ParseDiagnostics.get(asmodule.uri);
    ParseDiagnostics.set(asmodule.uri, diagnostics);

    if (initialResolve && diagnostics.length == 0)
        return;

    // If no diagnostics have changed, and we don't have any compiletime ones, don't send
    if (oldDiagnostics && AreDiagnosticsEqual(oldDiagnostics, diagnostics))
    {
        if (!HasCompileDiagnostics(asmodule))
            return;
    }

    // Notify diagnostics if we have any, or if we had any prior to this
    let notifyEmpty = false;
    if (oldDiagnostics && oldDiagnostics.length != 0)
        notifyEmpty = true;

    NotifyDiagnostics(asmodule.displayUri, notifyEmpty || alwaysSend);
}

function AddScopeDiagnostics(scope : scriptfiles.ASScope, diagnostics : Array<Diagnostic>)
{
    // Function code scopes can emit diagnostics for unused parameters and local variables
    // We only send these diagnostics if the file is open
    if (scope.isInFunctionBody() && scope.module.isOpened)
    {
        for (let asvar of scope.variables)
        {
            if (!asvar.isUnused)
                continue;
            if (!DiagnosticSettings.markUnreadVariablesAsUnused && asvar.hasAnyUsages)
                continue;

            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Hint,
                tags: [DiagnosticTag.Unnecessary],
                range: scope.module.getRange(asvar.start_offset_name, asvar.end_offset_name),
                message: (asvar.isArgument ? "Parameter" : "Variable")+" "+asvar.name+" is unused.",
                source: "angelscript"
            });

            if (asvar.usages)
            {
                for (let usage of asvar.usages)
                {
                    diagnostics.push(<Diagnostic> {
                        severity: DiagnosticSeverity.Hint,
                        tags: [DiagnosticTag.Unnecessary],
                        range: scope.module.getRange(usage.start, usage.end),
                        message: (asvar.isArgument ? "Parameter" : "Variable")+" "+asvar.name+" is unused.",
                        source: "angelscript"
                    });
                }
            }
        }
    }

    // If this is a function scope allow diagnostics for that
    if (scope.dbfunc)
        AddFunctionDiagnostics(scope, scope.dbfunc, diagnostics);

    // Allow subscopes to emit diagnostics
    for (let subscope of scope.scopes)
        AddScopeDiagnostics(subscope, diagnostics);
}

function VerifyDelegateBinds(asmodule : scriptfiles.ASModule, diagnostics : Array<Diagnostic>)
{
    for (let delegateBind of asmodule.delegateBinds)
    {
        if (!delegateBind.node_name)
            continue;
        if (!delegateBind.node_object)
            continue;
        if (asmodule.isEditingNode(delegateBind.statement, delegateBind.node_object))
            continue;

        if (delegateBind.node_name.type != node_types.ConstName)
            continue;

        let funcName = delegateBind.node_name.value;

        // Chop off the n"" part from the function name
        funcName = funcName.substring(2, funcName.length-1);

        let objType = scriptfiles.ResolveTypeFromExpression(delegateBind.scope, delegateBind.node_object);
        if (!objType)
            continue;
        
        let foundFunc = objType.findFirstSymbol(funcName, typedb.DBAllowSymbol.FunctionOnly);
        if (!foundFunc || !(foundFunc instanceof typedb.DBMethod))
        {
            // We didn't find the function at all
            let classType = delegateBind.scope.getParentType();
            let delegateType = typedb.GetType(delegateBind.delegateType);
            let data = null;

            if (delegateType && classType && classType.typename == objType.typename)
            {
                data = {
                    type: "delegateBind",
                    delegate: delegateType.typename,
                    name: funcName,
                };
            }

            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Error,
                range: asmodule.getRange(
                    delegateBind.statement.start_offset + delegateBind.node_expression.start,
                    delegateBind.statement.start_offset + delegateBind.node_expression.end),
                message: "Function "+funcName+" does not exist in type "+objType.typename,
                source: "angelscript",
                data: data,
            });
            continue;
        }

        if (!foundFunc.isUFunction)
        {
            // Function exists but isn't UFUNCTION
            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Error,
                range: asmodule.getRange(
                    delegateBind.statement.start_offset + delegateBind.node_expression.start,
                    delegateBind.statement.start_offset + delegateBind.node_expression.end),
                message: "Function "+foundFunc.name+" in "+foundFunc.containingType.typename+" is not declared UFUNCTION() and cannot be bound as a delegate.",
                source: "angelscript"
            });
            continue;
        }

        let delegateType = typedb.GetType(delegateBind.delegateType);
        if (!delegateType || !delegateType.delegateArgs)
            continue;

        // Check that the signature matches
        let signatureMatches = true;
        if (delegateType.delegateReturn != foundFunc.returnType)
            signatureMatches = false;

        if (delegateType.delegateArgs.length != foundFunc.args.length)
        {
            signatureMatches = false;
        }
        else
        {
            for (let i = 0; i < delegateType.delegateArgs.length; ++i)
            {
                let signatureArg = delegateType.delegateArgs[i].typename;
                let boundArg = foundFunc.args[i].typename;

                if (!typedb.TypenameEquals(signatureArg, boundArg))
                {
                    signatureMatches = false;
                    break;
                }

                if (signatureArg.endsWith("&out") != boundArg.endsWith("&out"))
                {
                    signatureMatches = false;
                    break;
                }

                let isReferenceInUnreal = false;
                if (signatureArg.endsWith("&in"))
                    isReferenceInUnreal = true;
                else if (signatureArg.endsWith("&") && !signatureArg.startsWith("const "))
                    isReferenceInUnreal = true;

                let isBindReference = false;
                if (boundArg.endsWith("&in"))
                    isBindReference = true;
                else if (boundArg.endsWith("&") && !boundArg.startsWith("const "))
                    isBindReference = true;

                // If unreal expects a reference property here, we need to make sure the
                // bind is also a reference property or the bind will fail.
                if (isReferenceInUnreal != isBindReference)
                {
                    signatureMatches = false;
                    break;
                }
            }
        }

        if (!signatureMatches)
        {
            // Function exists but has a wrong function signature
            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Error,
                range: asmodule.getRange(
                    delegateBind.statement.start_offset + delegateBind.node_expression.start,
                    delegateBind.statement.start_offset + delegateBind.node_expression.end),
                message: "Cannot bind function "+foundFunc.name+" in "+foundFunc.containingType.typename
                +".\nExpected Signature: "+delegateType.formatDelegateSignature()
                +"\nGot Signature: "+foundFunc.format(),
                source: "angelscript"
            });
            continue;
        }
    }
}

function TrimDiagnosticPositions(asmodule : scriptfiles.ASModule, diagnostics : Array<Diagnostic>)
{
    if (!asmodule || !asmodule.loaded)
        return;

    for (let diag of diagnostics)
    {
        let orig_start = diag.range.start;
        let orig_end = diag.range.end;

        // Move the start
        {
            let offset = asmodule.getOffset(Position.create(diag.range.start.line, 0));
            while (offset < asmodule.content.length)
            {
                let char = asmodule.content[offset];
                if (char == ' ' || char == '\t')
                {
                    offset += 1;
                }
                else 
                {
                    if (char != '\n' && char != '\r')
                        diag.range.start = asmodule.getPosition(offset);
                    break;
                }
            }
        }

        // Move the end
        {
            let offset = asmodule.getOffset(Position.create(diag.range.end.line, 10000)) - 1;
            let foundNewline = false;
            while (offset >= 0)
            {
                let char = asmodule.content[offset];
                if (char == '\n')
                {
                    if (foundNewline)
                        break;
                    foundNewline = true;
                    offset -= 1;
                }
                else if (char == '\r')
                {
                    offset -= 1;
                }
                else
                    break;
            }
            while (offset >= 0)
            {
                let char = asmodule.content[offset];
                if (char == ' ' || char == '\t')
                {
                    offset -= 1;
                }
                else
                {
                    if (char != '\n' && char != '\r')
                        diag.range.end = asmodule.getPosition(offset+1);
                    break;
                }
            }
        }

        // Don't make it too small
        if (diag.range.start.line == diag.range.end.line)
        {
            if (diag.range.end.character - diag.range.start.character <= 3)
            {
                diag.range.start = orig_start;
                diag.range.end = orig_end;
            }
        }
    }
}

function AreDiagnosticsEqual(oldList : Array<Diagnostic>, newList : Array<Diagnostic>) : boolean
{
    if (!oldList && newList)
        return false;
    if (oldList && !newList)
        return false;
    if (oldList.length != newList.length)
        return false;

    for (let i = 0; i < oldList.length; ++i)
    {
        let oldDiag = oldList[i];
        let newDiag = newList[i];

        if (oldDiag.code != newDiag.code)
            return false;
        if (oldDiag.codeDescription != newDiag.codeDescription)
            return false;
        if (oldDiag.data != newDiag.data)
            return false;
        if (oldDiag.message != newDiag.message)
            return false;
        if (oldDiag.severity != newDiag.severity)
            return false;
        if (oldDiag.source != newDiag.source)
            return false;

        if (oldDiag.range.start.line != newDiag.range.start.line)
            return false;
        if (oldDiag.range.start.character != newDiag.range.start.character)
            return false;
        if (oldDiag.range.end.line != newDiag.range.end.line)
            return false;
        if (oldDiag.range.end.character != newDiag.range.end.character)
            return false;

        if (oldDiag.tags && newDiag.tags)
        {
            if (oldDiag.tags.length != newDiag.tags.length)
                return false;
            for (let j = 0; j < oldDiag.tags.length; ++j)
            {
                if (oldDiag.tags[j] != newDiag.tags[j])
                    return false;
            }
        }
        else if (!!oldDiag.tags != !!newDiag.tags)
        {
            return false;
        }
    }

    return true;
}

function AddSymbolDiagnostics(asmodule : scriptfiles.ASModule, diagnostics : Array<Diagnostic>)
{
    // No symbol diagnostics if the file isn't open at the moment
    if (!asmodule.isOpened)
        return;

    for (let symbol of asmodule.symbols)
    {
        if (!symbol.isUnimported)
            continue;

        let displayName = symbol.symbol_name;
        if (displayName.startsWith("__"))
            displayName = displayName.substr(2);

        diagnostics.push(<Diagnostic> {
            severity: DiagnosticSeverity.Information,
            range: asmodule.getRange(symbol.start, symbol.end),
            message: displayName+" must be imported.",
            source: "angelscript",
            data: {
                type: "import",
                symbol: [symbol.type, symbol.container_type, symbol.symbol_name],
            }
        });
    }
}

function AddFunctionDiagnostics(scope : scriptfiles.ASScope, dbfunc : typedb.DBMethod, diagnostics : Array<Diagnostic>)
{
    // Add a diagnostic if we aren't calling the super function
    if (!dbfunc.hasSuperCall && dbfunc.isEvent && dbfunc.containingType
        && (!dbfunc.returnType || dbfunc.returnType == "void"))
    {
        let parentType = typedb.GetType(dbfunc.containingType.supertype);
        if (parentType)
        {
            let parentMethod = parentType.findFirstSymbol(dbfunc.name, typedb.DBAllowSymbol.FunctionOnly);
            if (parentMethod && parentMethod instanceof typedb.DBMethod && parentMethod.declaredModule)
            {
                if (!parentMethod.isEmpty && !parentMethod.hasMetaData("NoSuperCall") && !dbfunc.hasMetaData("NoSuperCall"))
                {
                    diagnostics.push(<Diagnostic> {
                        severity: DiagnosticSeverity.Warning,
                        range: scope.module.getRange(
                            scope.declaration.start_offset + scope.declaration.ast.start,
                            scope.declaration.start_offset + scope.declaration.ast.end),
                        message: "Overriding "+parentMethod.name+" BlueprintEvent from parent without calling Super::"+parentMethod.name+"(...)\n(Add 'NoSuperCall' meta to suppress warning)",
                        source: "angelscript",
                        data: {
                            type: "superCall",
                            inType: parentMethod.containingType.typename,
                            name: parentMethod.name,
                        },
                    });
                }
            }
        }
    }
}

function AddNamingConventionDiagnostics(asmodule : scriptfiles.ASModule, diagnostics : Array<Diagnostic>)
{
    // Check if the user turned of naming convention checks
    if (!DiagnosticSettings.namingConventionDiagnostics)
        return;

    AddScopeNamingConventionDiagnostics(asmodule.rootscope, diagnostics);
}

// Check if the type inherits from AActor, or if the unreal type is unknown,
// check if the unreal type starts with 'A'
function IsMaybeActorType(dbtype : typedb.DBType) : boolean
{
    let checkType = dbtype;
    while (checkType)
    {
        if (checkType.typename == "AActor")
            return true;

        if (checkType.supertype)
        {
            let superType = typedb.GetType(checkType.supertype);
            if (superType)
            {
                checkType = superType;
                continue;
            }
            else
                return checkType.supertype.startsWith('A');
        }

        if (checkType.unrealsuper)
        {
            let superType = typedb.GetType(checkType.unrealsuper);
            if (superType)
            {
                checkType = superType;
                continue;
            }
            else
                return checkType.unrealsuper.startsWith('A');
        }

        return false;
    }

    return false;
}

function AddScopeNamingConventionDiagnostics(scope : scriptfiles.ASScope, diagnostics : Array<Diagnostic>)
{
    // Check the naming convention for types
    let scopeType = scope.getDatabaseType();
    if (scopeType && (!scopeType.isNamespaceOrGlobalScope() || scopeType.isEnum))
    {
        let suggestedName = scopeType.getDisplayName();
        let hasSuggestion = false;

        // Make sure the type begins with the correct character indicator
        if (scopeType.isEnum)
        {
            if (suggestedName.length >= 1 && suggestedName[0] != 'E')
            {
                suggestedName = "E"+suggestedName;
                hasSuggestion = true;
            }
        }
        else if (scopeType.isStruct)
        {
            if (suggestedName.length >= 1 && suggestedName[0] != 'F')
            {
                suggestedName = "F"+suggestedName;
                hasSuggestion = true;
            }
        }
        else if (IsMaybeActorType(scopeType))
        {
            if (suggestedName.length >= 1 && suggestedName[0] != 'A')
            {
                suggestedName = "A"+suggestedName;
                hasSuggestion = true;
            }
        }
        else
        {
            if (suggestedName.length >= 1 && suggestedName[0] != 'U')
            {
                suggestedName = "U"+suggestedName;
                hasSuggestion = true;
            }
        }

        // Make sure the second character is capitalized
        if (suggestedName.length >= 2)
        {
            let charCode = suggestedName.charCodeAt(1);
            if (charCode >= 97 && charCode <= 122)
            {
                suggestedName = suggestedName[0] + suggestedName[1].toUpperCase() + suggestedName.substr(2);
                hasSuggestion = true;
            }
        }

        if (hasSuggestion)
        {
            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Warning,
                range: scope.module.getRange(scopeType.moduleOffset, scopeType.moduleOffsetEnd),
                message: `Type '${scopeType.getDisplayName()}' violates the Unreal naming convention. Suggested: ${suggestedName}`,
                source: "angelscript"
            });
        }
    }

    // We don't apply the more granular checks for variable and function naming
    // unless the file has been opened by the user.
    if (scope.module.isOpened)
    {
        // Check naming convention for functions
        let scopeFunc = scope.getDatabaseFunction();
        if (scopeFunc)
        {
            let suggestedName = scopeFunc.name;
            let hasSuggestion = false;

            // Make sure the first character is capitalized
            if (suggestedName.length >= 1)
            {
                let charCode = suggestedName.charCodeAt(0);
                if (charCode >= 97 && charCode <= 122)
                {
                    // We allow functions that start with 'op' because these are angelscript operator overloads
                    if (!suggestedName.startsWith("op") || suggestedName.startsWith("~"))
                    {
                        suggestedName = suggestedName[0].toUpperCase() + suggestedName.substr(1);
                        hasSuggestion = true;
                    }
                }
            }

            if (hasSuggestion)
            {
                diagnostics.push(<Diagnostic> {
                    severity: DiagnosticSeverity.Hint,
                    range: scope.module.getRange(scopeFunc.moduleOffset, scopeFunc.moduleOffsetEnd),
                    message: `Function '${scopeFunc.name}' violates the Unreal naming convention. Suggested: ${suggestedName}`,
                    source: "angelscript"
                });
            }
        }

        // Check naming convention for variables
        for (let scopeVar of scope.variables)
        {
            let suggestedName = scopeVar.name;
            let hasSuggestion = false;

            if (typedb.CleanTypeName(scopeVar.typename) == "bool")
            {
                // Bools should start with 'b'
                if (suggestedName.length >= 1 && suggestedName[0] != 'b')
                {
                    // Parameters are also allowed to start with "In" or "Out"
                    if (scopeVar.isArgument && (suggestedName.startsWith("In") || suggestedName.startsWith("Out")))
                        continue;

                    suggestedName = "b"+suggestedName;
                    hasSuggestion = true;
                }

                // Ensure the second character after the 'b' is uppercase
                if (suggestedName.length >= 2)
                {
                    let charCode = suggestedName.charCodeAt(1);
                    if (charCode >= 97 && charCode <= 122)
                    {
                        suggestedName = suggestedName[0] + suggestedName[1].toUpperCase() + suggestedName.substr(2);
                        hasSuggestion = true;
                    }
                }

                // If we could still be typing a function name, don't add this hint
                if (hasSuggestion)
                {
                    if (scope.scopetype == scriptfiles.ASScopeType.Class
                        || scope.scopetype == scriptfiles.ASScopeType.Global
                        || scope.scopetype == scriptfiles.ASScopeType.Namespace)
                    {
                        if (scope.module.isEditingInside(scopeVar.start_offset_name, scopeVar.end_offset_name)
                            && scopeVar.start_offset_expression == -1)
                        {
                            hasSuggestion = false;
                        }
                    }
                }
            }
            else
            {
                // Loop variables are allowed to have a single lowercase character
                if (suggestedName.length == 1 && scopeVar.isLoopVariable)
                    continue;

                // Ensure the first character is uppercase
                if (suggestedName.length >= 1)
                {
                    let charCode = suggestedName.charCodeAt(0);
                    if (charCode >= 97 && charCode <= 122)
                    {
                        // We allow functions that start with 'op' because these are angelscript operator overloads
                        suggestedName = suggestedName[0].toUpperCase() + suggestedName.substr(1);
                        hasSuggestion = true;
                    }
                }
            }

            if (hasSuggestion)
            {
                diagnostics.push(<Diagnostic> {
                    severity: DiagnosticSeverity.Hint,
                    range: scope.module.getRange(scopeVar.start_offset_name, scopeVar.end_offset_name),
                    message: `Variable '${scopeVar.name}' violates the Unreal naming convention. Suggested: ${suggestedName}`,
                    source: "angelscript"
                });
            }
        }
    }

    for (let subscope of scope.scopes)
        AddScopeNamingConventionDiagnostics(subscope, diagnostics);
}