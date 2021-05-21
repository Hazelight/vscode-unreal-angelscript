import { CodeAction, CodeActionKind, Command, Diagnostic, Position, Range, WorkspaceEdit, TextEdit } from "vscode-languageserver-types";
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

    // Actions for generating delegate bind functions
    AddGenerateDelegateFunctionActions(asmodule, range_start, range_end, actions, diagnostics);

    return actions;
}

export function ResolveCodeAction(asmodule : scriptfiles.ASModule, action : CodeAction, data : any) : CodeAction
{
    if (data.type == "import")
        ResolveImportAction(asmodule, action, data);
    else if (data.type == "delegateBind")
        ResolveGenerateDelegateFunctionAction(asmodule, action, data);
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

        actions.push(<CodeAction> {
            kind: CodeActionKind.QuickFix,
            title: "Import "+symbol.symbol_name,
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

    let [insertPosition, indent] = FindInsertPositionForGeneratedMethod(asmodule, data.position);
    let snippet = "\n"+indent+"UFUNCTION()\n";
    snippet += indent+"private ";
    if (delegateType.delegateReturn)
        snippet += delegateType.delegateReturn;
    else
        snippet += "void";

    snippet += " ";
    snippet += data.name;
    snippet += "(";

    let preambleLength = data.name.length + delegateType.delegateReturn.length + 10;
    let lineLength = preambleLength + indent.length;
    if (delegateType.delegateArgs)
    {
        for (let i = 0; i < delegateType.delegateArgs.length; ++i)
        {
            let arg = delegateType.delegateArgs[i];
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

    snippet += ")\n";
    snippet += indent+"{\n";
    snippet += indent+"}\n";

    action.edit = <WorkspaceEdit> {};
    action.edit.changes = {};
    action.edit.changes[asmodule.displayUri] = [
        TextEdit.insert(insertPosition, snippet)
    ];
}

function FindInsertPositionForGeneratedMethod(asmodule : scriptfiles.ASModule, afterPosition : Position) : [Position, string]
{
    let offset = asmodule.getOffset(afterPosition);
    let curScope = asmodule.getScopeAt(offset);

    let classScope = curScope.getParentTypeScope();
    let indent : string = null;

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
        indent = "";

    // Find the first scope in our parent that starts after the position, and insert before it
    for (let subscope of classScope.scopes)
    {
        let scopeEndPos = asmodule.getPosition(subscope.start_offset);
        if (scopeEndPos.line >= afterPosition.line)
            return [Position.create(scopeEndPos.line+1, 0), indent];
    }

    let endOfClass = asmodule.getPosition(classScope.end_offset);
    return [endOfClass, indent];
}
