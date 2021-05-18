import { Diagnostic, DiagnosticSeverity, DiagnosticTag, Position } from 'vscode-languageserver/node';
import * as typedb from './database';
import * as scriptfiles from './as_parser';

let node_types = require("../grammar/node_types.js");

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

function NotifyDiagnostics(uri : string, notifyEmpty = true)
{
    let allDiagnostics : Array<Diagnostic> = [];

    let fromCompile = CompileDiagnostics.get(scriptfiles.NormalizeUri(uri));
    if (fromCompile)
    {
        allDiagnostics = allDiagnostics.concat(fromCompile);

        let asmodule = scriptfiles.GetModuleByUri(uri);
        if (asmodule)
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

export function OnDiagnosticsChanged(bindFunction : any)
{
    NotifyFunctions.push(bindFunction);
}

export function UpdateScriptModuleDiagnostics(asmodule : scriptfiles.ASModule)
{
    let diagnostics = new Array<Diagnostic>();

    // Go through all the parsed scopes and add diagnostics
    AddScopeDiagnostics(asmodule.rootscope, diagnostics);

    // Add diagnostics for delegate function bind verification
    VerifyDelegateBinds(asmodule, diagnostics);

    // Update stored diagnostics
    let oldDiagnostics = ParseDiagnostics.get(asmodule.uri);
    ParseDiagnostics.set(asmodule.uri, diagnostics);

    // Notify diagnostics if we have any, or if we had any prior to this
    let notifyEmpty = false;
    if (oldDiagnostics && oldDiagnostics.length != 0)
        notifyEmpty = true;

    NotifyDiagnostics(asmodule.uri, notifyEmpty);
}

function AddScopeDiagnostics(scope : scriptfiles.ASScope, diagnostics : Array<Diagnostic>)
{
    // Function code scopes can emit diagnostics for unused parameters and local variables
    if (scope.isInFunctionBody())
    {
        for (let asvar of scope.variables)
        {
            if (!asvar.isUnused)
                continue;

            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Hint,
                tags: [DiagnosticTag.Unnecessary],
                range: scope.module.getRange(asvar.start_offset_name, asvar.end_offset_name),
                message: (asvar.isArgument ? "Parameter" : "Variable")+" "+asvar.name+" is unused.",
                source: "angelscript"
            });
        }
    }

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
        if (asmodule.isEditingNode(delegateBind.statement, delegateBind.node_name))
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
            diagnostics.push(<Diagnostic> {
                severity: DiagnosticSeverity.Error,
                range: asmodule.getRange(
                    delegateBind.statement.start_offset + delegateBind.node_expression.start,
                    delegateBind.statement.start_offset + delegateBind.node_expression.end),
                message: "Function "+funcName+" does not exist in type "+objType.typename,
                source: "angelscript"
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
                if (!typedb.TypenameEquals(delegateType.delegateArgs[i].typename, foundFunc.args[i].typename))
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
    for (let diag of diagnostics)
    {
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

        if (oldDiag.tags.length != newDiag.tags.length)
            return false;
        for (let j = 0; j < oldDiag.tags.length; ++j)
        {
            if (oldDiag.tags[j] != newDiag.tags[j])
                return false;
        }
    }

    return true;
}