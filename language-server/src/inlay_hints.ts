import * as scriptfiles from './as_parser';
import * as typedb from './database';
import { node_types } from './as_parser';
import { Range, Position, Location, SemanticTokens, SemanticTokensBuilder, SemanticTokensDelta } from "vscode-languageserver";

export interface ASInlayHint
{
    /**
     * The text of the hint.
     */
    text: string;
    /**
     * The position of this hint.
     */
    position: Position;
    /**
     * The kind of this hint.
     */
    kind?: number;
    /**
     * Whitespace before the hint.
     */
    whitespaceBefore?: boolean;
    /**
     * Whitespace after the hint.
     */
    whitespaceAfter?: boolean;
};

export interface InlayHintSettings
{
    inlayHintsEnabled : boolean;
    parameterHintsForConstants : boolean;
    parameterReferenceHints : boolean;
    parameterHintsForSingleParameterFunctions : boolean;
    parameterHintsForComplexExpressions : boolean;
    typeHintsForAutos : boolean;
};

let InlayHintSettings : InlayHintSettings = {
    inlayHintsEnabled : true,
    parameterHintsForConstants : true,
    parameterReferenceHints : true,
    parameterHintsForSingleParameterFunctions : false,
    parameterHintsForComplexExpressions : true,
    typeHintsForAutos : true,
};

let GenericParameterNames = new Set<string>([
    "Object", "Actor", "FunctionName",
    "Value", "InValue", "NewValue",
    "X", "Y", "Z",
]);

export function GetInlayHintSettings() : InlayHintSettings
{
    return InlayHintSettings;
}

export function GetInlayHintsForRange(asmodule : scriptfiles.ASModule, range : Range) : Array<ASInlayHint>
{
    if (!InlayHintSettings.inlayHintsEnabled)
        return [];

    let hints = new Array<ASInlayHint>();
    let start_offset = asmodule.getOffset(range.start);
    let end_offset = asmodule.getOffset(range.end);

    GetInlayHintsForScope(asmodule.rootscope, start_offset, end_offset, hints);

    return hints;
}

export function GetInlayHintsForScope(scope : scriptfiles.ASScope, start_offset : number, end_offset : number, hints : Array<ASInlayHint>)
{
    // Check all statements that are within the range
    for (let statement of scope.statements)
    {
        if (!statement)
            continue;
        if (statement.start_offset > end_offset)
            continue;
        if (statement.end_offset < start_offset)
            continue;

        GetInlayHintsForNode(scope, statement, statement.ast, hints);
    }

    // Add hints for any autos we have
    if (InlayHintSettings.typeHintsForAutos)
    {
        for (let scopevar of scope.variables)
        {
            if (!scopevar.isAuto)
                continue;
            if (!scopevar.node_expression)
                continue;

            let cleanResultType = typedb.CleanTypeName(scopevar.typename);
            if (cleanResultType == "auto")
                continue;

            let showAutoHint = true;

            // If we are still typing within the expression, don't show the label so
            // stuff doesn't jump around a bunch.
            if (scope.module.isEditingInside(scopevar.end_offset_expression - 1, scopevar.end_offset_expression))
                showAutoHint = false;

            // If this is an auto with a Cast<> on the right side we don't show it,
            // the Cast<> makes it obvious what it is.
            if (scopevar.node_expression.type == node_types.CastOperation)
            {
                showAutoHint = false;
            }

            // If the right side is a variable within the type's namespace,
            // don't show the hint
            if (scopevar.node_expression.type == node_types.NamespaceAccess)
            {
                let nsNode = scopevar.node_expression.children[0];
                if (nsNode && nsNode.type == node_types.Identifier && nsNode.value == cleanResultType)
                    showAutoHint = false;
            }

            if (scopevar.node_expression.type == node_types.FunctionCall
                || scopevar.node_expression.type == node_types.ConstructorCall)
            {
                let funcNode = scopevar.node_expression.children[0];

                // Function calls within the type's namespace elide the hint
                if (funcNode && funcNode.type == node_types.NamespaceAccess)
                {
                    let nsNode = funcNode.children[0];
                    if (nsNode && nsNode.type == node_types.Identifier && nsNode.value == cleanResultType)
                        showAutoHint = false;
                }

                // Calls to constructors elide the hint
                if (funcNode && funcNode.type == node_types.Identifier)
                {
                    if (funcNode.value == cleanResultType)
                        showAutoHint = false;
                }
            }

            if (showAutoHint)
            {
                hints.push(<ASInlayHint> {
                    text: ": "+scopevar.typename,
                    position: scope.module.getPosition(scopevar.end_offset_name),
                    kind: 1,
                    whitespaceBefore: true,
                });
            }
        }
    }

    // Recurse into subscopes that overlap the range
    for (let subscope of scope.scopes)
    {
        if (subscope.start_offset > end_offset)
            continue;
        if (subscope.end_offset < start_offset)
            continue;

        GetInlayHintsForScope(subscope, start_offset, end_offset, hints);
    }
}

function LabelConstantLiteralNode(node : any, argName : string) : boolean
{
    // Argument names we consider 'Generic' don't get labels
    if (GenericParameterNames.has(argName))
        return false;

    switch (node.type)
    {
        case node_types.This:
        case node_types.ConstBool:
        case node_types.ConstDouble:
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        case node_types.ConstFloat:
        case node_types.ConstNullptr:
            return true;

        case node_types.ConstName:
            // If the name of the argument ends with 'name' we probably don't care what it is
            if (argName.endsWith("Name"))
                return false;
            return true;
    }

    return false;
}

function LabelComplexExpression(node : any, argName : string) : boolean
{
    // Argument names we consider 'Generic' don't get labels
    if (GenericParameterNames.has(argName))
        return false;

    switch (node.type)
    {
        case node_types.FunctionCall:
        case node_types.ConstructorCall:
            return true;

        case node_types.BinaryOperation:
        case node_types.PostfixOperation:
        case node_types.TernaryOperation:
        case node_types.Assignment:
        case node_types.CompoundAssignment:
            return true;

        case node_types.CastOperation:
            return true;
    }

    return false;
}

export function GetInlayHintsForNode(scope : scriptfiles.ASScope, statement : scriptfiles.ASStatement, node : any, hints : Array<ASInlayHint>)
{
    if (!node)
        return;

    // Add symbols for parameters in function declarations
    switch (node.type)
    {
        case node_types.FunctionCall:
        case node_types.ConstructorCall:
        case node_types.VariableDecl:
        {
            let argListNode : any = null;
            let argCount : number = 0;

            // Add symbols for parameters
            let overloads = new Array<typedb.DBMethod>();

            if (node.type == node_types.VariableDecl)
            {
                if (node.inline_constructor && node.expression && node.typename)
                {
                    scriptfiles.ResolveFunctionOverloadsFromIdentifier(scope, node.typename.value, overloads);
                    argListNode = node.expression;
                    argCount = argListNode.children.length;
                }
                else
                {
                    if (node.expression)
                        GetInlayHintsForNode(scope, statement, node.expression, hints);
                    return;
                }
            }
            else
            {
                scriptfiles.ResolveFunctionOverloadsFromExpression(scope, node.children[0], overloads);
                if (!node.children[1])
                    return;

                argListNode = node.children[1];
                argCount = argListNode.children.length;
            }

            // Filter so we only select overloads that support the argument count
            let ambiguous = false;
            let func : typedb.DBMethod = null;
            let fallbackFunc : typedb.DBMethod = null;
            let fallbackAmbiguous = false;
            for (let candidateFunc of overloads)
            {
                let argCount = candidateFunc.args.length;
                if (candidateFunc.isMixin)
                    argCount -= 1;

                if (argCount < argCount)
                    continue;
                
                let requiredArgs = candidateFunc.getRequiredArgumentCount();
                if (candidateFunc.isMixin)
                    requiredArgs -= 1;

                if (requiredArgs > argCount)
                {
                    if (!fallbackFunc)
                        fallbackFunc = candidateFunc;
                    else
                        fallbackAmbiguous = true;
                    continue;
                }

                if (!func)
                {
                    func = candidateFunc;
                }
                else
                {
                    if (!func.isSignatureEqual(candidateFunc))
                        ambiguous = true;
                }
            }

            // Fall back to something we don't have enough arguments for yet
            if (!func && !fallbackAmbiguous)
                func = fallbackFunc;

            // If this is ambiguous based on argument types, don't show hints
            if (ambiguous)
                func = null;

            for (let i = 0; i < argCount; ++i)
            {
                let argNode = argListNode.children[i];
                if (!argNode)
                    continue;

                // If we're currently typing this argument, never show the hint
                if (scope.module.isEditingInside(
                        statement.start_offset + argNode.end - 1,
                        statement.start_offset + argNode.end)
                    && i == argCount-1)
                    continue;

                let paramIndex = i;
                if (func && func.isMixin)
                    paramIndex += 1;

                if (func != null && func.args.length > paramIndex)
                {
                    let dbParam = func.args[paramIndex];
                    let shouldShowNameHint = false;

                    // Show hints when the argument is a literal constant
                    if (InlayHintSettings.parameterHintsForConstants)
                    {
                        if (LabelConstantLiteralNode(argNode, dbParam.name))
                            shouldShowNameHint = true;
                    }

                    // Show hints if the expression is complex 
                    if (InlayHintSettings.parameterHintsForComplexExpressions)
                    {
                        if (LabelComplexExpression(argNode, dbParam.name))
                            shouldShowNameHint = true;
                    }

                    // Never show hints for single argument functions if turned off
                    if (!InlayHintSettings.parameterHintsForSingleParameterFunctions)
                    {
                        if (argCount == 1)
                            shouldShowNameHint = false;
                    }

                    // Never show hints if we already have a named parameter
                    if (argNode.type == node_types.NamedArgument)
                        shouldShowNameHint = false;

                    let shouldShowRefHint = InlayHintSettings.parameterReferenceHints
                        && dbParam.typename.includes("&")
                        && !dbParam.typename.startsWith("const ");

                    if (shouldShowNameHint || shouldShowRefHint)
                    {
                        let hintStr = "";
                        if (shouldShowNameHint)
                            hintStr += dbParam.name+" ="
                        if (shouldShowRefHint)
                        {
                            if (hintStr.length != 0)
                                hintStr += " [&]";
                            else
                                hintStr += "[&]";
                        }

                        hints.push(<ASInlayHint> {
                            text: hintStr,
                            position: scope.module.getPosition(argNode.start + statement.start_offset),
                            kind: 2,
                            whitespaceAfter: true,
                        });
                    }
                }

                // Provide hints within the argument expression as well
                GetInlayHintsForNode(scope, statement, argNode, hints);
            }
        }
        break;
        case node_types.MemberAccess:
        {
            GetInlayHintsForNode(scope, statement, node.children[0], hints);
        }
        break;
        case node_types.ArgumentList:
        case node_types.VariableDeclMulti:
        case node_types.IndexOperator:
        case node_types.BinaryOperation:
        case node_types.UnaryOperation:
        case node_types.PostfixOperation:
        case node_types.TernaryOperation:
        case node_types.Assignment:
        case node_types.CompoundAssignment:
        case node_types.ReturnStatement:
        case node_types.DefaultStatement:
        case node_types.SwitchStatement:
        {
            if (node.children)
            {
                for (let child of node.children)
                    GetInlayHintsForNode(scope, statement, child, hints);
            }
        }
        break;
        case node_types.CastOperation:
        case node_types.NamedArgument:
        {
            GetInlayHintsForNode(scope, statement, node.children[1], hints);
        }
        break;
        // Some nodes can be followed by an optional statement, but this has been parsed into its own statement
        // already when types were generated, so we ignore the last child.
        case node_types.IfStatement:
        case node_types.ElseStatement:
        case node_types.ForLoop:
        case node_types.WhileLoop:
        case node_types.CaseStatement:
        case node_types.DefaultCaseStatement:
        {
            for (let i = 0, count = node.children.length-1; i < count; ++i)
                GetInlayHintsForNode(scope, statement, node.children[i], hints);
        }
        break;
        case node_types.ForEachLoop:
        {
            GetInlayHintsForNode(scope, statement, node.children[2], hints);
        }
        break;
    }
}