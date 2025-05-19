import * as scriptfiles from './as_parser';
import * as typedb from './database';
import { node_types } from './as_parser';
import { Range, Location, Position, Command, MarkedString, InlayHint, InlayHintLabelPart, InlayHintKind } from "vscode-languageserver";

export interface InlayHintSettings
{
    inlayHintsEnabled : boolean;
    parameterHintsForConstants : boolean;
    parameterReferenceHints : boolean;
    parameterHintsForSingleParameterFunctions : boolean;
    parameterHintsForComplexExpressions : boolean;
    typeHintsForAutos : boolean;
    typeHintsIgnoredTypes : Set<string>;
    parameterHintsIgnoredParameterNames : Set<string>;
    parameterHintsIgnoredFunctionNames : Set<string>;
};

let InlayHintSettings : InlayHintSettings = {
    inlayHintsEnabled : true,
    parameterHintsForConstants : true,
    parameterReferenceHints : true,
    parameterHintsForSingleParameterFunctions : false,
    parameterHintsForComplexExpressions : true,
    typeHintsForAutos : true,
    typeHintsIgnoredTypes : new Set<string>(),
    parameterHintsIgnoredParameterNames : new Set<string>(),
    parameterHintsIgnoredFunctionNames : new Set<string>(),
};

let HintIgnoredMathFunctions = new Set<string>(
[
    "Math::Clamp",
    "Math::Wrap",
    "Math::IsWithin",
    "Math::Lerp",
    "Math::VLerp",
    "Math::LogX",
    "Math::Pow",
]);

export function GetInlayHintSettings() : InlayHintSettings
{
    return InlayHintSettings;
}

export function GetInlayHintsForRange(asmodule : scriptfiles.ASModule, range : Range) : Array<InlayHint>
{
    if (!InlayHintSettings.inlayHintsEnabled)
        return [];

    let hints = new Array<InlayHint>();
    let start_offset = asmodule.getOffset(range.start);
    let end_offset = asmodule.getOffset(range.end);

    GetInlayHintsForScope(asmodule.rootscope, start_offset, end_offset, hints);

    return hints;
}

export function GetInlayHintsForScope(scope : scriptfiles.ASScope, start_offset : number, end_offset : number, hints : Array<InlayHint>)
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
            if (InlayHintSettings.typeHintsIgnoredTypes.has(cleanResultType))
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

                // If any of the arguments are literals of that type, elide the hint
                if (scopevar.node_expression.children[1]
                    && scopevar.node_expression.children[1].type == node_types.ArgumentList
                    && scopevar.node_expression.children[1].children
                )
                {
                    for (let child of scopevar.node_expression.children[1].children)
                    {
                        if (child && child.type == node_types.Identifier)
                        {
                            if (child.value == cleanResultType)
                                showAutoHint = false;
                        }
                    }
                }
            }

            if (showAutoHint)
            {
                let label : string | InlayHintLabelPart[] = null;
                label = "["+scopevar.typename+"]";

                let varType = typedb.LookupType(scope.getNamespace(), scopevar.typename);
                if (varType && varType.declaredModule)
                {
                    let varModule = scriptfiles.GetModule(varType.declaredModule);
                    if (varModule)
                    {
                        label = [
                            <InlayHintLabelPart> {
                                value: "[",
                            },
                            <InlayHintLabelPart> {
                                value: scopevar.typename,
                                location: varModule.getLocation(varType.moduleOffset),
                            },
                            <InlayHintLabelPart> {
                                value: "]",
                            },
                        ];
                    }
                }

                // Just don't display the actual iterator type if this is a map iterator
                if (varType && scopevar.isIterator
                        && varType.isTemplateInstantiation
                        && (varType.name.startsWith("TMapIterator<") || varType.name.startsWith("TMapConstIterator<"))
                        && varType.templateSubTypes
                        && varType.templateSubTypes.length == 2)
                {
                    label = "["+varType.templateSubTypes[0]+" ➜ "+varType.templateSubTypes[1]+"]";
                }

                hints.push(<InlayHint> {
                    label: label,
                    position: scope.module.getPosition(scopevar.start_offset_name-1),
                    kind: InlayHintKind.Type,
                    paddingLeft: true,
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

let GlobalConstantNames = new Set<string>([
    "MIN_uint8", "MIN_uint16", "MIN_uint32", "MIN_uint64",
    "MIN_int8", "MIN_int16", "MIN_int32", "MIN_int64",

    "MAX_uint8", "MAX_uint16", "MAX_uint32", "MAX_uint64",
    "MAX_int8", "MAX_int16", "MAX_int32", "MAX_int64",

    "MIN_flt", "MAX_flt", "NAN_flt",
    "MIN_dbl", "MAX_dbl", "NAN_dbl",

    "EULERS_NUMBER", "PI", "HALF_PI", "TWO_PI",
    "TAU", "SMALL_NUMBER", "KINDA_SMALL_NUMBER", "BIG_NUMBER",

    "NAME_None"
]);

function ShouldLabelConstantNode(node : any, argName : string) : boolean
{
    if (!node)
        return false;
    switch (node.type)
    {
        case node_types.This:
        case node_types.ConstBool:
        case node_types.ConstDouble:
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        case node_types.ConstOctalInteger:
        case node_types.ConstBinaryInteger:
        case node_types.ConstFloat:
        case node_types.ConstNullptr:
            return true;

        case node_types.UnaryOperation:
            // This could be a - in front of a number literal
            return ShouldLabelConstantNode(node.children[0], argName);

        case node_types.ConstName:
            // If the name of the argument ends with 'name' we probably don't care what it is
            if (argName.endsWith("Name"))
                return false;
            return true;

        case node_types.NamespaceAccess:
        {
            // If this is a variable inside a namespace, and the namespace is
            // a struct, then this is a default constant such as FVector::ZeroVector,
            // and we should label it as a constant
            if (node.children[0] && node.children[0].type == node_types.Identifier)
            {
                let nsType = typedb.GetTypeByName(node.children[0].value);
                if (nsType && nsType.isStruct)
                    return true;
            }

            return false;
        }
        break;

        case node_types.Identifier:
        {
            // If this is a math constant such as MAX_flt,
            // we should also hint it as if it was a typed literal.
            if (GlobalConstantNames.has(node.value))
                return true;
        }
        break;
    }

    return false;
}

function ShouldLabelComplexExpressionNode(node : any, argName : string) : boolean
{
    switch (node.type)
    {
        case node_types.FunctionCall:
        {
            if (node.children[0] && node.children[0].type == node_types.NamespaceAccess)
            {
                if (node.children[0].children[1] && node.children[0].children[1].type == node_types.Identifier)
                {
                    if (node.children[0].children[1].value == "StaticClass")
                        return false;
                }
            }
            return true;
        }
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

function AreParameterNamesEqual(func : typedb.DBMethod, otherFunc : typedb.DBMethod, checkCount : number) : boolean
{
    let funcOffset = func.isMixin ? 1 : 0;
    let otherFuncOffset = otherFunc.isMixin ? 1 : 0;

    for (let argIndex = 0; argIndex < checkCount; ++argIndex)
    {
        if (func.args[argIndex + funcOffset].name != otherFunc.args[argIndex + otherFuncOffset].name)
            return false;
    }

    return true;
}

export function GetInlayHintsForNode(scope : scriptfiles.ASScope, statement : scriptfiles.ASStatement, node : any, hints : Array<InlayHint>)
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

            // Check if this function is ignored or not
            let functionIsIgnored = false;
            if (overloads.length != 0 && overloads[0])
            {
                let functionName = overloads[0].name;
                let qualifiedFunctionName : string = null;
                if (overloads[0].containingType)
                    qualifiedFunctionName = overloads[0].containingType.getDisplayName()+"::"+functionName;

                if (InlayHintSettings.parameterHintsIgnoredFunctionNames.has(functionName))
                    functionIsIgnored = true;
                else if (qualifiedFunctionName && InlayHintSettings.parameterHintsIgnoredFunctionNames.has(qualifiedFunctionName))
                    functionIsIgnored = true;
                else if (qualifiedFunctionName && HintIgnoredMathFunctions.has(qualifiedFunctionName))
                    functionIsIgnored = true;
            }

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

                if (overloads.length != 0)
                {
                    let dbParam : typedb.DBArg = null;
                    let matchFunc : typedb.DBMethod = null;

                    let paramNameAmbiguous = false;
                    let paramIsFallback = false;

                    for (let func of overloads)
                    {
                        let paramIndex = i;
                        if (func.isMixin)
                            paramIndex += 1;

                        if (paramIndex >= func.args.length)
                            continue;

                        let isFallback = func.args.length < argCount;
                        if (dbParam && dbParam.name != func.args[paramIndex].name && (!isFallback || paramIsFallback))
                            paramNameAmbiguous = true;

                        if (!dbParam || (paramIsFallback && !isFallback))
                        {
                            dbParam = func.args[paramIndex];
                            paramIsFallback = isFallback;
                            if (!isFallback)
                                paramNameAmbiguous = false;
                        }
                    }

                    if (dbParam)
                    {
                        let shouldShowNameHint = false;
                        if (!paramNameAmbiguous && !functionIsIgnored)
                        {
                            // Show hints when the argument is a literal constant
                            if (InlayHintSettings.parameterHintsForConstants)
                            {
                                if (ShouldLabelConstantNode(argNode, dbParam.name))
                                    shouldShowNameHint = true;
                            }

                            // Show hints if the expression is complex
                            if (InlayHintSettings.parameterHintsForComplexExpressions)
                            {
                                if (ShouldLabelComplexExpressionNode(argNode, dbParam.name))
                                    shouldShowNameHint = true;
                            }

                            // Never show hints for single argument functions if turned off
                            if (!InlayHintSettings.parameterHintsForSingleParameterFunctions)
                            {
                                if (argCount == 1)
                                    shouldShowNameHint = false;
                            }

                            // Never show hints if we already have a named parameter
                            if (shouldShowNameHint && argNode.type == node_types.NamedArgument)
                                shouldShowNameHint = false;

                            // Argument names that are 1 character long probably aren't worth showing
                            if (shouldShowNameHint && dbParam.name.length == 1)
                                shouldShowNameHint = false;

                            // Argument names we consider 'Generic' don't get labels
                            if (shouldShowNameHint && InlayHintSettings.parameterHintsIgnoredParameterNames.has(dbParam.name))
                                shouldShowNameHint = false;
                        }

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

                            hints.push(<InlayHint> {
                                label: hintStr,
                                position: scope.module.getPosition(argNode.start + statement.start_offset),
                                kind: InlayHintKind.Parameter,
                                paddingRight: true,
                            });
                        }
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