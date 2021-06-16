import { CodeAction, CodeActionKind, Command, Diagnostic, Position, Range, WorkspaceEdit, TextEdit, SymbolTag } from "vscode-languageserver-types";
import * as typedb from "./database";
import * as scriptfiles from "./as_parser";
import * as scriptsymbols from "./symbols";

export function GetCodeActions(asmodule : scriptfiles.ASModule, range : Range, diagnostics : Array<Diagnostic>) : Array<CodeAction>
{
    let actions = new Array<CodeAction>();
    let range_start = asmodule.getOffset(Position.create(range.start.line, 0));
    let range_end = asmodule.getOffset(Position.create(range.end.line, 10000));

    // Actions for adding missing imports
    AddImportActions(asmodule, range_start, range_end, actions, diagnostics);

    // Actions for autos
    AddAutoActions(asmodule, range_start, range_end, actions, diagnostics);

    // Actions for generating delegate bind functions
    AddGenerateDelegateFunctionActions(asmodule, range_start, range_end, actions, diagnostics);

    // Actions for method override snippets
    AddMethodOverrideSnippets(asmodule, range_start, range_end, actions, diagnostics);

    // Actions for adding casts
    AddCastHelpers(asmodule, range_start, range_end, actions, diagnostics);

    // Actions for adding super calls
    AddSuperCallHelper(asmodule, range_start, range_end, actions, diagnostics);

    return actions;
}

export function ResolveCodeAction(asmodule : scriptfiles.ASModule, action : CodeAction, data : any) : CodeAction
{
    if (data.type == "import")
        ResolveImportAction(asmodule, action, data);
    else if (data.type == "delegateBind")
        ResolveGenerateDelegateFunctionAction(asmodule, action, data);
    else if (data.type == "methodOverride")
        ResolveMethodOverrideSnippet(asmodule, action, data);
    else if (data.type == "addCast")
        ResolveCastHelper(asmodule, action, data);
    else if (data.type == "superCall")
        ResolveSuperCallHelper(asmodule, action, data);
    else if (data.type == "materializeAuto")
        ResolveAutoAction(asmodule, action, data);
    return action;
}

function AddImportActions(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    for (let symbol of asmodule.symbols)
    {
        if (!symbol.isUnimported)
            continue;
        if (!symbol.overlapsRange(range_start, range_end))
            continue;

        let appliedTo = new Array<Diagnostic>();
        for (let diag of diagnostics)
        {
            if (diag.data)
            {
                let data = diag.data as any;
                if (data.type && data.type == "import")
                {
                    if (data.symbol[0] == symbol.type
                        && data.symbol[1] == symbol.container_type
                        && data.symbol[2] == symbol.symbol_name)
                    {
                        appliedTo.push(diag);
                    }
                }
            }
        }

        let symbolDisplayName = symbol.symbol_name;
        if (symbolDisplayName.startsWith("__"))
            symbolDisplayName = symbolDisplayName.substr(2);

        actions.push(<CodeAction> {
            kind: CodeActionKind.QuickFix,
            title: "Import "+symbolDisplayName,
            source: "angelscript",
            diagnostics: appliedTo,
            isPreferred: true,
            data: {
                uri: asmodule.uri,
                type: "import",
                symbol: symbol,
            }
        });
    }
}

function ResolveImportAction(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let definitions = scriptsymbols.GetSymbolDefinition(asmodule, data.symbol);
    if (!definitions || definitions.length == 0)
        return action;

    let moduleName = definitions[0].module.modulename;
    if (asmodule.isModuleImported(moduleName))
        return action;

    // Find the first line to insert on
    let lastImportLine = 0;

    // Find if the module is already imported, or the position to append the new import
    let lineCount = asmodule.textDocument.lineCount;
    let hasEmptyLine = false;
    let alreadyImported = false;
    let importRegex = /\s*import\s+([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*);/;

    for(let i = 0; i < lineCount; ++i)
    {
        let line = asmodule.textDocument.getText(
            Range.create(Position.create(i, 0), Position.create(i, 10000))
        );

        let match = importRegex.exec(line);
        if (match)
        {
            if (match[1] == moduleName)
            {
                alreadyImported = true;
                break;
            }

            lastImportLine = i + 1;
            hasEmptyLine = false;
        }
        else if (line.trim().length != 0)
        {
            // Break if we find a line that's not empty, signalling the end of the import-block
            break;
        }
        else
        {
            hasEmptyLine = true;
        }
    }

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    if (alreadyImported)
        return;

    let insertString = "import "+moduleName+";\n";
    if (!hasEmptyLine)
        insertString += "\n";

    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(Position.create(lastImportLine, 0), insertString)
    ];
}

function AddGenerateDelegateFunctionActions(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    for (let diag of diagnostics)
    {
        let data = diag.data as any;
        if (data && data.type == "delegateBind")
        {
            actions.push(<CodeAction> {
                kind: CodeActionKind.QuickFix,
                title: "Generate Method: "+data.name+"()",
                source: "angelscript",
                diagnostics: [diag],
                isPreferred: true,
                data: {
                    uri: asmodule.uri,
                    type: "delegateBind",
                    delegate: data.delegate,
                    name: data.name,
                    position: diag.range.start,
                }
            });
        }
    }
}

function ResolveGenerateDelegateFunctionAction(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let delegateType = typedb.GetType(data.delegate);
    if (!delegateType)
        return;

    let [insertPosition, indent, prefix, suffix] = FindInsertPositionForGeneratedMethod(asmodule, data.position);
    let snippet = prefix;
    snippet += indent+"UFUNCTION()\n";
    snippet += GenerateMethodHeaderString("private ", indent, data.name, delegateType.delegateReturn, delegateType.delegateArgs);
    snippet += "\n";
    snippet += indent+"{\n";
    snippet += indent+"}\n";
    snippet += suffix;

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(insertPosition, snippet)
    ];
}

function GenerateMethodHeaderString(prefix : string, indent : string, name : string, returnType : string, args : Array<typedb.DBArg>) : string
{
    let snippet = indent+prefix;
    let preambleLength = name.length + 2 + prefix.length;
    if (returnType)
    {
        snippet += returnType;
        preambleLength += returnType.length;
    }
    else
    {
        snippet += "void";
        preambleLength += 4;
    }

    snippet += " ";
    snippet += name;
    snippet += "(";

    let lineLength = preambleLength + indent.length;
    if (args)
    {
        for (let i = 0; i < args.length; ++i)
        {
            let arg = args[i];
            let argLength = arg.typename.length;
            if (arg.name)
                argLength += arg.name.length + 1;

            if (lineLength + argLength > 100)
            {
                if (i != 0)
                {
                    snippet += ",";
                    lineLength += 1;
                }
                snippet += "\n"+indent+" ".repeat(preambleLength);
                lineLength = indent.length + preambleLength;
            }
            else if (i != 0)
            {
                snippet += ", ";
                lineLength += 2;
            }

            snippet += arg.typename;
            if (arg.name)
            {
                snippet += " ";
                snippet += arg.name;
            }

            lineLength += argLength;
        }
    }

    snippet += ")";
    return snippet;
}

function FindInsertPositionForGeneratedMethod(asmodule : scriptfiles.ASModule, afterPosition : Position) : [Position, string, string, string]
{
    let offset = asmodule.getOffset(afterPosition);
    let curScope = asmodule.getScopeAt(offset);

    let classScope = curScope.getParentTypeScope();
    let indent : string = null;
    let prefix : string = "";
    let suffix : string = "";

    // Just insert right here
    if (!classScope)
        return [Position.create(afterPosition.line, 0), "\t", prefix, suffix];

    // Find the first line in the class that has content, and base indentation on that
    for (let statement of classScope.statements)
    {
        let lines = statement.content.split("\n");
        for (let line of lines)
        {
            if (!/^[ \t\r\n]*$/.test(line))
            {
                indent = "";
                for (let i = 0; i < line.length; ++i)
                {
                    let curchar = line[i];
                    if (curchar == ' ' || curchar == '\t')
                    {
                        indent += curchar;
                    }
                    else if (curchar == '\n' || curchar == '\r')
                    {
                        continue;
                    }
                    else if (curchar == '#')
                    {
                        indent = null;
                        break;
                    }
                    else
                    {
                        break;
                    }
                }
                break;
            }
        }
        if (indent)
            break;
    }
    if (!indent)
        indent = "\t";

    // Find the first scope in our parent that starts after the position, and insert before it
    let classStartPos = asmodule.getPosition(classScope.start_offset);

    for (let subscope of classScope.scopes)
    {
        let startOffset = subscope.start_offset;
        while (startOffset < subscope.end_offset)
        {
            let curchar = asmodule.content[startOffset];
            if (curchar == ' ' || curchar == '\t' || curchar == '\r' || curchar == '\n')
                ++startOffset;
            else
                break;
        }

        let scopeStartPos = asmodule.getPosition(startOffset);
        let checkStartPos = scopeStartPos;
        if (subscope.element_head instanceof scriptfiles.ASStatement)
            checkStartPos = asmodule.getPosition(subscope.element_head.start_offset);
        else if (!subscope.element_head)
            checkStartPos = asmodule.getPosition(subscope.end_offset);

        if (checkStartPos.line >= afterPosition.line)
        {
            prefix += "\n";
            return [Position.create(scopeStartPos.line-1, 10000), indent, prefix, suffix];
        }
    }

    let endOfClass = asmodule.getPosition(classScope.end_offset);
    if (!asmodule.isLineEmpty(endOfClass.line-1))
        prefix += "\n";
    return [endOfClass, indent, prefix, suffix];
}

function AddMethodOverrideSnippets(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    let scope = asmodule.getScopeAt(range_start);
    if (!scope)
        return;

    let typeOfScope = scope.getParentType();
    if (!typeOfScope || !typeOfScope.supertype)
        return;

    let validScope = false;
    if (scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        validScope = true;
    }
    // If we're inside the actual function declaration that's fine too
    else if (scope.scopetype == scriptfiles.ASScopeType.Function)
    {
        let statement = scope.parentscope.getStatementAt(range_start);
        if (statement && statement.ast && statement.ast.type == scriptfiles.node_types.FunctionDecl)
        {
            validScope = true;
        }
    }
    if (!validScope)
        return;

    let foundOverrides = new Set<string>();
    for (let checktype of typeOfScope.getInheritanceTypes())
    {
        for (let method of checktype.methods)
        {
            if (checktype.isUnrealType() && !method.isEvent)
                continue;
            if (foundOverrides.has(method.name))
                continue;

            // Ignore methods we've already overridden
            let existingSymbol = typeOfScope.findFirstSymbol(method.name, typedb.DBAllowSymbol.FunctionOnly);
            if (!existingSymbol || !existingSymbol.containingType)
                continue;
            if (existingSymbol.containingType == typeOfScope)
                continue;

            // Ignore private methods
            if (method.isPrivate)
                continue;

            actions.push(<CodeAction> {
                kind: CodeActionKind.RefactorRewrite,
                title: "Override: "+method.name+"()",
                source: "angelscript",
                data: {
                    uri: asmodule.uri,
                    type: "methodOverride",
                    inside: method.containingType.typename,
                    name: method.name,
                    position: asmodule.getPosition(range_start),
                }
            });

            foundOverrides.add(method.name);
        }
    }
}

function ResolveMethodOverrideSnippet(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let insideType = typedb.GetType(data.inside);
    if (!insideType)
        return;

    let method = insideType.getMethod(data.name);
    if (!method)
        return;

    let offset = asmodule.getOffset(data.position);
    let scope = asmodule.getScopeAt(offset);
    let scopeType = scope ? scope.getParentType() : null;

    let [insertPosition, indent, prefix, suffix] = FindInsertPositionForGeneratedMethod(asmodule, data.position);
    let snippet = "";
    snippet += prefix;

    if (method.isEvent)
        snippet += indent+"UFUNCTION(BlueprintOverride)\n";

    snippet += GenerateMethodHeaderString("", indent, data.name, method.returnType, method.args);
    if (method.isConst)
        snippet += " const"
    if (!method.isEvent)
        snippet += " override";
    if (!method.isEvent && method.isProperty && method.declaredModule)
        snippet += " property";

    snippet += "\n";
    snippet += indent+"{\n";

    if (scopeType)
    {
        let parentType = typedb.GetType(scopeType.supertype);
        if (parentType)
        {
            let parentMethod = parentType.findFirstSymbol(method.name, typedb.DBAllowSymbol.FunctionOnly);
            if (parentMethod instanceof typedb.DBMethod && parentMethod.declaredModule && !parentMethod.isEmpty)
            {
                if (!method.returnType || method.returnType == "void")
                {
                    snippet += indent+indent+"Super::"+method.name+"(";
                    for (let i = 0; i < method.args.length; ++i)
                    {
                        if (i != 0)
                            snippet += ", ";
                        snippet += method.args[i].name;
                    }
                    snippet += ");\n";
                }
            }
        }
    }

    snippet += indent+"}\n";
    snippet += suffix;

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(insertPosition, snippet)
    ];
}

function AddCastHelpers(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    let scope = asmodule.getScopeAt(range_start);
    if (!scope)
        return;
    let statement = asmodule.getStatementAt(range_start);
    if (!statement)
        return;
    if (!statement.ast)
        return;


    let leftType : typedb.DBType = null;
    let rightType : typedb.DBType = null;

    if (statement.ast.type == scriptfiles.node_types.Assignment)
    {
        let leftNode = statement.ast.children[0];
        let rightNode = statement.ast.children[1];
        if (!leftNode || !rightNode)
            return;

        leftType = scriptfiles.ResolveTypeFromExpression(scope, leftNode);
        rightType = scriptfiles.ResolveTypeFromExpression(scope, rightNode);
    }
    else if (statement.ast.type == scriptfiles.node_types.VariableDecl)
    {
        if (statement.ast.typename)
            leftType = typedb.GetType(statement.ast.typename.value);

        if (statement.ast.expression)
            rightType = scriptfiles.ResolveTypeFromExpression(scope, statement.ast.expression);
    }

    if (!leftType || !rightType)
        return;

    // Don't care about primitives
    if (leftType.isPrimitive || rightType.isPrimitive)
        return;

    // Don't care about structs
    if (leftType.isStruct || rightType.isStruct)
        return;

    // Maybe we can implicitly convert
    if (rightType.inheritsFrom(leftType.typename))
        return;
    
    // Cast needs to make sense
    if (!leftType.inheritsFrom(rightType.typename))
        return;

    actions.push(<CodeAction> {
        kind: CodeActionKind.QuickFix,
        title: "Cast to "+leftType.typename,
        source: "angelscript",
        data: {
            uri: asmodule.uri,
            type: "addCast",
            castTo: leftType.typename,
            position: asmodule.getPosition(range_start),
        }
    });
}

function ResolveCastHelper(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let offset = asmodule.getOffset(data.position);
    let scope = asmodule.getScopeAt(offset);
    if (!scope)
        return;
    let statement = asmodule.getStatementAt(offset);
    if (!statement)
        return;
    if (!statement.ast)
        return;

    let rightNode : any = null;
    if (statement.ast.type == scriptfiles.node_types.Assignment)
    {
        rightNode = statement.ast.children[1];
    }
    else if (statement.ast.type == scriptfiles.node_types.VariableDecl)
    {
        rightNode = statement.ast.expression;
    }

    if (!rightNode)
        return;

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(
            asmodule.getPosition(statement.start_offset + rightNode.start),
            "Cast<"+data.castTo+">("),
        TextEdit.insert(
            asmodule.getPosition(statement.start_offset + rightNode.end),
            ")"),
    ];
}

function AddSuperCallHelper(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    for (let diag of diagnostics)
    {
        let data = diag.data as any;
        if (data && data.type == "superCall")
        {
            actions.push(<CodeAction> {
                kind: CodeActionKind.QuickFix,
                title: "Add call to Super::"+data.name+"(...)",
                source: "angelscript",
                diagnostics: [diag],
                isPreferred: true,
                data: {
                    uri: asmodule.uri,
                    type: "superCall",
                    name: data.name,
                    inType: data.inType,
                    position: asmodule.getPosition(range_end),
                }
            });
        }
    }
}

function ResolveSuperCallHelper(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let offset = asmodule.getOffset(data.position);
    let scope = asmodule.getScopeAt(offset)
    if (!scope)
        return;

    let scopeFunc = scope.getParentFunction();
    if (!scopeFunc)
        return;

    let superType = typedb.GetType(data.inType);
    if (!superType)
        return;
    let superMethod = superType.findFirstSymbol(data.name, typedb.DBAllowSymbol.FunctionOnly);
    if (!superMethod)
        return;
    if (!(superMethod instanceof typedb.DBMethod))
        return;

    let [insertPosition, indent, prefix, suffix] = FindInsertPositionFunctionStart(scope);

    let callString = prefix+indent+"Super::"+superMethod.name+"(";
    if (scopeFunc.args)
    {
        for (let i = 0; i < scopeFunc.args.length; ++i)
        {
            if (i != 0)
                callString += ", ";
            callString += scopeFunc.args[i].name;
        }
    }

    callString += ");"+suffix;

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(insertPosition, callString)
    ];
}

function FindInsertPositionFunctionStart(scope : scriptfiles.ASScope) : [Position, string, string, string]
{
    let indent : string = null;
    let prefix : string = "";
    let suffix : string = "";

    // Find the first line in the class that has content, and base indentation on that
    let endLine = scope.module.getPosition(scope.end_offset).line;
    let curLine = scope.module.getPosition(scope.declaration.end_offset).line + 1;
    while (curLine < endLine)
    {
        let lineText = scope.module.getLineText(curLine);
        if (!/^[\r\n]*$/.test(lineText))
        {
            indent = "";
            for (let i = 0; i < lineText.length; ++i)
            {
                let curchar = lineText[i];
                if (curchar == ' ' || curchar == '\t')
                {
                    indent += curchar;
                }
                else if (curchar == '\n' || curchar == '\r')
                {
                    continue;
                }
                else if (curchar == '#')
                {
                    indent = null;
                    break;
                }
                else
                {
                    break;
                }
            }
            if (indent != null)
                break;
        }
    }

    if(indent == null)
    {
        // Double the class indent
        let [subPos, subIndent, subPrefix, subSuffix] = FindInsertPositionForGeneratedMethod(
            scope.module,
            scope.module.getPosition(scope.declaration.end_offset));
        indent = subIndent + subIndent;
    }

    if (indent == null)
        indent = "\t\t";

    let headPos = scope.module.getPosition(scope.declaration.end_offset);
    prefix += "\n";
    return [Position.create(headPos.line, 100000), indent, prefix, suffix];
}

function AddAutoActions(asmodule : scriptfiles.ASModule, range_start : number, range_end : number, actions : Array<CodeAction>, diagnostics : Array<Diagnostic>)
{
    for (let symbol of asmodule.symbols)
    {
        if (!symbol.isAuto)
            continue;
        if (!symbol.overlapsRange(range_start, range_end))
            continue;

        let realTypename = symbol.symbol_name;
        let dbtype = typedb.GetType(realTypename);
        if (!dbtype)
            continue;

        actions.push(<CodeAction> {
            kind: CodeActionKind.RefactorInline,
            title: "Change auto to "+realTypename,
            source: "angelscript",
            isPreferred: true,
            data: {
                uri: asmodule.uri,
                type: "materializeAuto",
                typename: realTypename,
                symbol: symbol,
            }
        });
    }
}

function ResolveAutoAction(asmodule : scriptfiles.ASModule, action : CodeAction, data : any)
{
    let symbol = data.symbol as scriptfiles.ASSymbol;
    let typename = data.typename;

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};

    action.edit.changes[asmodule.displayUri] = [
        TextEdit.replace(
            asmodule.getRange(symbol.start, symbol.end),
            typename,
        )
    ];
}