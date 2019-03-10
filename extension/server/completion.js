"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_languageserver_1 = require("vscode-languageserver");
const scriptfiles = require("./as_file");
const typedb = require("./database");
var ASTermType;
(function (ASTermType) {
    ASTermType[ASTermType["Name"] = 0] = "Name";
    ASTermType[ASTermType["Namespace"] = 1] = "Namespace";
    ASTermType[ASTermType["PropertyAccess"] = 2] = "PropertyAccess";
    ASTermType[ASTermType["FunctionCall"] = 3] = "FunctionCall";
    ASTermType[ASTermType["IndexOperator"] = 4] = "IndexOperator";
    ASTermType[ASTermType["ImportStatement"] = 5] = "ImportStatement";
})(ASTermType || (ASTermType = {}));
;
class ASTerm {
}
;
function ParseTerms(strTerm) {
    let terms = new Array();
    let termPos = 0;
    let brackets = 0;
    let pos = 0;
    let squarebrackets = 0;
    let finalizeTerm = function () {
        if (pos > termPos) {
            terms.push({
                type: ASTermType.Name,
                name: strTerm.substring(termPos, pos),
            });
        }
    };
    for (pos = 0; pos < strTerm.length; ++pos) {
        let char = strTerm[pos];
        switch (char) {
            case ".":
                if (brackets == 0 && squarebrackets == 0) {
                    finalizeTerm();
                    terms.push({
                        type: ASTermType.PropertyAccess
                    });
                    termPos = pos + 1;
                }
                break;
            case ":":
                if (brackets == 0 && squarebrackets == 0 && pos > 0 && strTerm[pos - 1] == ":") {
                    pos -= 1;
                    finalizeTerm();
                    pos += 1;
                    terms.push({
                        type: ASTermType.Namespace
                    });
                    termPos = pos + 1;
                }
                break;
            case "(":
                if (brackets == 0 && squarebrackets == 0) {
                    finalizeTerm();
                    terms.push({
                        type: ASTermType.FunctionCall
                    });
                }
                brackets += 1;
                break;
            case ")":
                brackets -= 1;
                if (brackets == 0 && squarebrackets == 0)
                    termPos = pos + 1;
                break;
            case "[":
                if (squarebrackets == 0 && brackets == 0) {
                    finalizeTerm();
                    terms.push({
                        type: ASTermType.IndexOperator
                    });
                }
                squarebrackets += 1;
                break;
            case "]":
                squarebrackets -= 1;
                if (squarebrackets == 0 && brackets == 0)
                    termPos = pos + 1;
                break;
        }
    }
    terms.push({
        type: ASTermType.Name,
        name: strTerm.substring(termPos, strTerm.length)
    });
    return terms;
}
function ExtractCompletingTerm(params) {
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos == -1)
        return [[], null];
    return ExtractCompletingTermAt(pos, params.textDocument.uri);
}
function ExtractCompletingTermAt(pos, uri) {
    let file = scriptfiles.GetFile(uri);
    if (file == null)
        return [[], null];
    let termstart = pos;
    let brackets = 0;
    let braces = 0;
    let squarebrackets = 0;
    while (termstart > 0) {
        let char = file.rootscope.content[termstart];
        let end = false;
        switch (char) {
            case ';':
                end = true;
                break;
            case '[':
                if (squarebrackets > 0)
                    squarebrackets -= 1;
                else
                    end = true;
                break;
            case ']':
                squarebrackets += 1;
                break;
            case '(':
                if (brackets > 0)
                    brackets -= 1;
                else
                    end = true;
                break;
            case ')':
                brackets += 1;
                break;
            case '{':
            case '}':
            case '/':
            case '+':
            case '-':
            case '=':
            case '*':
            case '@':
            case '!':
            case ' ':
            case '<':
            case '\n':
                if (brackets == 0 && squarebrackets == 0)
                    end = true;
                break;
        }
        if (end) {
            termstart += 1;
            break;
        }
        termstart -= 1;
    }
    let fullTerm = file.rootscope.content.substring(termstart, pos + 1).trim();
    let scope = file.GetScopeAt(pos);
    if (termstart >= 7) {
        let importBefore = file.rootscope.content.substr(termstart - 7, 7);
        if (importBefore == "import ") {
            return [[
                    {
                        type: ASTermType.ImportStatement,
                        name: fullTerm
                    }
                ], scope];
        }
    }
    return [ParseTerms(fullTerm), scope];
}
function CanCompleteTo(completing, suggestion) {
    return suggestion.toLowerCase().indexOf(completing.toLowerCase()) != -1;
}
function GetTypeCompletions(initialTerm, completions) {
    for (let [typename, dbtype] of typedb.GetDatabase()) {
        if (dbtype.isShadowedNamespace())
            continue;
        let kind = vscode_languageserver_1.CompletionItemKind.Class;
        if (dbtype.isNamespace()) {
            typename = dbtype.rawName;
            kind = vscode_languageserver_1.CompletionItemKind.Module;
        }
        if (typename.startsWith("//"))
            continue;
        if (CanCompleteTo(initialTerm, typename)) {
            completions.push({
                label: typename,
                detail: typename,
                kind: kind,
            });
        }
    }
}
function GetGlobalScopeTypes(scope, includeClass, includeRoot = true) {
    let types = new Array();
    let glob = typedb.GetType("__");
    if (glob && includeRoot)
        types.push(glob);
    let checkScope = scope;
    while (checkScope) {
        if (checkScope.scopetype == scriptfiles.ASScopeType.Global
            || (includeClass && checkScope.scopetype == scriptfiles.ASScopeType.Class)) {
            let dbscope = typedb.GetType(checkScope.typename);
            if (dbscope)
                types.push(dbscope);
        }
        checkScope = checkScope.parentscope;
    }
    return types;
}
function GetScopeCompletions(initialTerm, scope, completions) {
    if (scope.scopetype != scriptfiles.ASScopeType.Class
        && scope.scopetype != scriptfiles.ASScopeType.Global) {
        for (let scopevar of scope.variables) {
            if (CanCompleteTo(initialTerm, scopevar.name)) {
                completions.push({
                    label: scopevar.name,
                    detail: scopevar.typename + " " + scopevar.name,
                    kind: vscode_languageserver_1.CompletionItemKind.Variable
                });
            }
        }
    }
    if (scope.parentscope)
        GetScopeCompletions(initialTerm, scope.parentscope, completions);
}
function GetVariableType(variable, scope) {
    for (let scopevar of scope.variables) {
        if (scopevar.name == variable) {
            return scopevar.typename;
        }
    }
    if (scope.parentscope)
        return GetVariableType(variable, scope.parentscope);
    return null;
}
function ResolvePropertyType(term, type, scope) {
    if (scope != null) {
        let typename = GetVariableType(term, scope);
        if (typename != null) {
            let dbtype = typedb.GetType(typename);
            if (dbtype != null)
                return dbtype;
        }
    }
    if (type == null && scope != null) {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes) {
            let prop = globaltype.getProperty(term);
            if (prop != null) {
                return typedb.GetType(prop.typename);
            }
            let accessortype = globaltype.getPropertyAccessorType(term);
            if (accessortype) {
                return typedb.GetType(accessortype);
            }
        }
    }
    else if (type != null) {
        let prop = type.getProperty(term);
        if (prop != null) {
            return typedb.GetType(prop.typename);
        }
        let accessortype = type.getPropertyAccessorType(term);
        if (accessortype) {
            return typedb.GetType(accessortype);
        }
    }
    return null;
}
function GetFunctionRetType(name, scope) {
    for (let subscope of scope.subscopes) {
        if (subscope.scopetype == scriptfiles.ASScopeType.Function && subscope.funcname == name) {
            return subscope.funcreturn;
        }
    }
    if (scope.parentscope)
        return GetFunctionRetType(name, scope.parentscope);
    return null;
}
function ResolveFunctionType(term, type, scope, globScope = null) {
    if (type == null && scope != null) {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes) {
            let mthd = globaltype.getMethod(term);
            if (mthd) {
                let dbtype = typedb.GetType(mthd.returnType);
                if (dbtype)
                    return dbtype;
            }
        }
    }
    if (type != null) {
        let func = type.getMethod(term);
        if (func) {
            return typedb.GetType(func.returnType);
        }
        if (globScope != null) {
            // Deal with unified call syntax from global functions
            let ucsScopes = GetGlobalScopeTypes(globScope, false, false);
            for (let globaltype of ucsScopes) {
                let func = globaltype.getMethod(term);
                if (func) {
                    return typedb.GetType(func.returnType);
                }
            }
        }
    }
    return null;
}
let re_cast = /Cast<([A-Za-z0-9_]+)>/;
function GetTypeFromTerm(initialTerm, startIndex, endIndex, scope, finalizeResolve = false) {
    // Terms in between the first and last are properties of types
    let curtype = null;
    let curname = null;
    let curscope = scope;
    let globscope = scope;
    for (let index = startIndex; index < endIndex; ++index) {
        let term = initialTerm[index];
        switch (term.type) {
            case ASTermType.Name:
                curname = term.name;
                break;
            case ASTermType.PropertyAccess:
                if (curname != null) {
                    curtype = ResolvePropertyType(curname, curtype, curscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null) {
                        return null;
                    }
                }
                break;
            case ASTermType.FunctionCall:
                if (curname != null) {
                    if (curname.startsWith("Cast")) {
                        let castmatch = re_cast.exec(curname);
                        if (castmatch) {
                            curtype = typedb.GetType(castmatch[1]);
                            curscope = null;
                            curname = null;
                            if (curtype == null)
                                return null;
                            break;
                        }
                    }
                    curtype = ResolveFunctionType(curname, curtype, curscope, globscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                        return null;
                }
                break;
            case ASTermType.IndexOperator:
                if (curname != null) {
                    curtype = ResolvePropertyType(curname, curtype, curscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                        return null;
                }
                curtype = ResolveFunctionType("opIndex", curtype, curscope, globscope);
                curscope = null;
                if (curtype == null)
                    return null;
                break;
            case ASTermType.Namespace:
                if (curname != null) {
                    curtype = typedb.GetType("__" + curname);
                    curname = null;
                    curscope = null;
                    if (curtype == null)
                        return null;
                }
                break;
        }
    }
    if (finalizeResolve && curname)
        curtype = ResolvePropertyType(curname, curtype, curscope);
    return curtype;
}
function GetTermCompletions(initialTerm, inScope, completions) {
    let curtype = GetTypeFromTerm(initialTerm, 0, initialTerm.length - 1, inScope);
    if (curtype == null)
        return;
    // The last term is always the name we're trying to complete    
    let completingStr = initialTerm[initialTerm.length - 1].name.toLowerCase();
    AddCompletionsFromType(curtype, completingStr, completions);
    // Deal with unified call syntax from global functions
    let globaltypes = GetGlobalScopeTypes(inScope, false, false);
    for (let globaltype of globaltypes) {
        for (let func of globaltype.allMethods()) {
            if (func.args && func.args.length >= 1 && curtype.inheritsFrom(func.args[0].typename)) {
                if (CanCompleteTo(completingStr, func.name)) {
                    if (!func.name.startsWith("op")) {
                        completions.push({
                            label: func.name,
                            detail: func.format(null, true),
                            kind: vscode_languageserver_1.CompletionItemKind.Method,
                            data: [curtype.typename, func.name],
                        });
                    }
                }
            }
        }
    }
}
function AddCompletionsFromType(curtype, completingStr, completions) {
    let props = new Set();
    for (let prop of curtype.allProperties()) {
        if (CanCompleteTo(completingStr, prop.name)) {
            props.add(prop.name);
            completions.push({
                label: prop.name,
                detail: prop.typename + " " + prop.name,
                kind: vscode_languageserver_1.CompletionItemKind.Field
            });
        }
    }
    let getterStr = "Get" + completingStr;
    for (let func of curtype.allMethods()) {
        if (CanCompleteTo(getterStr, func.name)) {
            let propname = func.name.substr(3);
            if (!props.has(propname)) {
                completions.push({
                    label: propname,
                    detail: func.returnType + " " + propname,
                    kind: vscode_languageserver_1.CompletionItemKind.Field,
                });
                props.add(propname);
            }
        }
        if (CanCompleteTo(completingStr, func.name)) {
            if (!func.name.startsWith("op")) {
                completions.push({
                    label: func.name,
                    detail: func.format(),
                    kind: vscode_languageserver_1.CompletionItemKind.Method,
                    data: [curtype.typename, func.name],
                });
            }
        }
    }
}
exports.AddCompletionsFromType = AddCompletionsFromType;
function AddKeywordCompletions(completingStr, completions) {
    for (let kw of [
        "if", "else", "while", "for",
        "default", "UFUNCTION", "UCLASS", "UPROPERTY",
        "delegate", "event", "class", "struct",
        "void", "float", "bool", "int", "double",
        "nullptr", "return", "true", "false", "this",
        "const", "override",
        "BlueprintOverride", "BlueprintEvent", "BlueprintCallable", "NotBlueprintCallable", "BlueprintPure", "NetFunction", "DevFunction", "Category", "Meta", "NetMulticast", "Client", "Server", "BlueprintAuthorityOnly", "CallInEditor", "Unreliable",
        "EditAnywhere", "EditDefaultsOnly", "EditInstanceOnly", "BlueprintReadWrite", "BlueprintReadOnly", "NotBlueprintVisible", "NotEditable", "DefaultComponent", "RootComponent", "Attach", "Transient", "NotVisible", "EditConst", "BlueprintHidden", "Replicated", "ReplicationCondition",
    ]) {
        if (CanCompleteTo(completingStr, kw)) {
            completions.push({
                label: kw,
                kind: vscode_languageserver_1.CompletionItemKind.Keyword
            });
        }
    }
}
function ImportCompletion(term) {
    let completions = new Array();
    let untilDot = "";
    let dotPos = term.lastIndexOf(".");
    if (dotPos != -1)
        untilDot = term.substr(0, dotPos + 1);
    for (let file of scriptfiles.GetAllFiles()) {
        if (CanCompleteTo(term, file.modulename)) {
            completions.push({
                label: file.modulename,
                kind: vscode_languageserver_1.CompletionItemKind.File,
                insertText: file.modulename.substr(untilDot.length),
            });
        }
    }
    return completions;
}
function Complete(params) {
    let [initialTerm, inScope] = ExtractCompletingTerm(params);
    if (initialTerm.length == 1 && initialTerm[0].type == ASTermType.ImportStatement)
        return ImportCompletion(initialTerm[0].name);
    let completions = new Array();
    // Add completions local to the angelscript scope
    let allowScopeCompletions = initialTerm.length == 1;
    if (allowScopeCompletions && inScope != null) {
        GetScopeCompletions(initialTerm[0].name, inScope, completions);
    }
    // If we're not inside a type, also complete to type names for static functions / declarations
    if (allowScopeCompletions) {
        GetTypeCompletions(initialTerm[0].name, completions);
    }
    // If we're not inside a type, also complete to anything is global scope
    if (allowScopeCompletions) {
        let globaltypes = GetGlobalScopeTypes(inScope, true);
        for (let globaltype of globaltypes)
            AddCompletionsFromType(globaltype, initialTerm[0].name, completions);
        AddKeywordCompletions(initialTerm[0].name, completions);
    }
    // We are already inside a type, so we need to complete based on that type
    if (initialTerm.length >= 2 && inScope != null) {
        GetTermCompletions(initialTerm, inScope, completions);
    }
    return completions;
}
exports.Complete = Complete;
function Resolve(item) {
    if (!item.data)
        return item;
    let type = typedb.GetType(item.data[0]);
    if (type == null)
        return item;
    let func = type.getMethod(item.data[1]);
    if (func) {
        item.documentation = func.documentation;
    }
    return item;
}
exports.Resolve = Resolve;
function Signature(params) {
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;
    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;
    // Find the opening bracket in front of our current pos
    let brackets = 0;
    while (true) {
        let char = file.rootscope.content[pos];
        if (char == ';' || char == '{' || char == '}')
            return null;
        if (char == ')')
            brackets += 1;
        if (char == '(') {
            brackets -= 1;
            if (brackets < 0)
                break;
        }
        pos -= 1;
        if (pos < 0)
            return null;
    }
    pos -= 1;
    if (pos < 0)
        return null;
    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);
    let checkTypes;
    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;
    let sigHelp = {
        signatures: new Array(),
        activeSignature: 0,
        activeParameter: null,
    };
    for (let type of checkTypes) {
        for (let func of type.allMethods()) {
            if (func.name != term[term.length - 1].name)
                continue;
            /*let params = new Array<ParameterInformation>();

            for (let arg of func.args)
            {
                params.push(<ParameterInformation>{
                    label: arg.format(),
                });
            }*/
            let sig = {
                label: func.format(),
                parameters: new Array(),
                documentation: func.documentation,
            };
            sigHelp.signatures.push(sig);
        }
    }
    // Deal with unified call syntax from global functions
    if (curtype != null && scope != null) {
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes) {
            for (let func of globaltype.allMethods()) {
                if (func.name != term[term.length - 1].name)
                    continue;
                if (!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                    continue;
                let sig = {
                    label: func.format(null, true),
                    parameters: new Array(),
                    documentation: func.documentation,
                };
                sigHelp.signatures.push(sig);
            }
        }
    }
    return sigHelp.signatures.length == 0 ? null : sigHelp;
}
exports.Signature = Signature;
function GetScopeHover(initialTerm, scope) {
    if (scope.scopetype != scriptfiles.ASScopeType.Class
        && scope.scopetype != scriptfiles.ASScopeType.Global) {
        for (let scopevar of scope.variables) {
            if (scopevar.name == initialTerm) {
                return scopevar.typename + " " + scopevar.name;
            }
        }
    }
    if (scope.parentscope)
        return GetScopeHover(initialTerm, scope.parentscope);
    return null;
}
function AddScopeSymbols(file, scope, symbols) {
    let scopeSymbol = {
        name: scope.typename,
        location: file.GetLocationRange(scope.startPosInFile, scope.endPosInFile),
    };
    if (scope.scopetype == scriptfiles.ASScopeType.Class) {
        scopeSymbol.kind = vscode_languageserver_1.SymbolKind.Class;
        symbols.push(scopeSymbol);
        for (let classVar of scope.variables) {
            if (classVar.isArgument)
                continue;
            symbols.push({
                name: classVar.name,
                kind: vscode_languageserver_1.SymbolKind.Variable,
                location: file.GetLocation(classVar.posInFile),
                containerName: scope.typename,
            });
        }
    }
    else if (scope.scopetype == scriptfiles.ASScopeType.Enum) {
        scopeSymbol.kind = vscode_languageserver_1.SymbolKind.Enum;
        symbols.push(scopeSymbol);
    }
    else if (scope.scopetype == scriptfiles.ASScopeType.Function) {
        scopeSymbol.name = scope.funcname + "()";
        if (scope.parentscope.scopetype == scriptfiles.ASScopeType.Class) {
            scopeSymbol.kind = vscode_languageserver_1.SymbolKind.Method;
            scopeSymbol.containerName = scope.parentscope.typename;
        }
        else {
            scopeSymbol.kind = vscode_languageserver_1.SymbolKind.Function;
        }
        symbols.push(scopeSymbol);
    }
    for (let subscope of scope.subscopes) {
        AddScopeSymbols(file, subscope, symbols);
    }
}
function DocumentSymbols(uri) {
    let symbols = new Array();
    let file = scriptfiles.GetFile(uri);
    if (!file)
        return symbols;
    AddScopeSymbols(file, file.rootscope, symbols);
    return symbols;
}
exports.DocumentSymbols = DocumentSymbols;
function WorkspaceSymbols(query) {
    let symbols = new Array();
    for (let file of scriptfiles.GetAllFiles()) {
        AddScopeSymbols(file, file.rootscope, symbols);
    }
    return symbols;
}
exports.WorkspaceSymbols = WorkspaceSymbols;
function Hover(params) {
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;
    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;
    // Find the end of the identifier
    while (true) {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if (pos >= file.rootscope.content.length)
            break;
    }
    pos -= 1;
    if (pos < 0)
        return null;
    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);
    let checkTypes;
    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;
    let hover = "";
    let settername = "Set" + term[term.length - 1].name;
    let gettername = "Get" + term[term.length - 1].name;
    for (let type of checkTypes) {
        for (let func of type.allMethods()) {
            if (func.name != term[term.length - 1].name && func.name != gettername && func.name != settername)
                continue;
            let prefix = null;
            if (type.typename.startsWith("__")) {
                if (type.typename != "__")
                    prefix = type.typename.substring(2);
            }
            else if (!type.typename.startsWith("//"))
                prefix = type.typename;
            hover = "";
            if (func.documentation) {
                hover += "*";
                hover += func.documentation;
                hover += "*\n\n";
            }
            hover += func.format(prefix);
            break;
        }
        for (let prop of type.allProperties()) {
            if (prop.name != term[term.length - 1].name)
                continue;
            let prefix = null;
            if (type.typename.startsWith("__")) {
                if (type.typename != "__")
                    prefix = type.typename.substring(2);
            }
            else if (!type.typename.startsWith("//"))
                prefix = type.typename;
            hover = prop.format(prefix);
            break;
        }
        if (hover.length != 0)
            break;
    }
    if (term.length == 1 && scope && hover == "") {
        hover = GetScopeHover(term[0].name, scope);
    }
    // Deal with unified call syntax from global functions
    if (term.length != 1 && hover == "") {
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes) {
            for (let func of globaltype.allMethods()) {
                if (func.name != term[term.length - 1].name)
                    continue;
                if (!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                    continue;
                hover = "";
                if (func.documentation) {
                    hover += "*";
                    hover += func.documentation;
                    hover += "*\n\n";
                }
                hover += func.format(null, true);
            }
        }
    }
    if (hover == "")
        return null;
    return { contents: {
            kind: "markdown",
            value: hover,
        } };
}
exports.Hover = Hover;
function ExpandCheckedTypes(checkTypes) {
    let count = checkTypes.length;
    for (let i = 0; i < count; ++i) {
        let checkType = checkTypes[i];
        if (checkType.hasExtendTypes()) {
            for (let extendType of checkType.getExtendTypes()) {
                if (!checkTypes.includes(extendType))
                    checkTypes.push(extendType);
            }
        }
    }
}
function GetScopeUnrealType(scope) {
    // First walk upwards until we find the class we're in
    let inClass;
    let classscope = scope;
    while (classscope && classscope.scopetype != scriptfiles.ASScopeType.Class)
        classscope = classscope.parentscope;
    if (!classscope)
        return "";
    return GetUnrealTypeFor(classscope.typename);
}
function GetUnrealTypeFor(typename) {
    // Walk through the typedb to find parent types until we find a C++ class
    let type = typedb.GetType(typename);
    while (type && type.declaredModule && type.supertype)
        type = typedb.GetType(type.supertype);
    if (!type)
        return "";
    return type.typename;
}
exports.GetUnrealTypeFor = GetUnrealTypeFor;
function GetCompletionTypeAndMember(params) {
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;
    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;
    // Find the end of the identifier
    while (true) {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if (pos >= file.rootscope.content.length)
            break;
    }
    pos -= 1;
    if (pos < 0)
        return null;
    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);
    let checkTypes;
    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype) {
        return [curtype.typename, term[term.length - 1].name];
    }
    else if (scope) {
        return [GetScopeUnrealType(scope), term[term.length - 1].name];
    }
    else {
        return ["", term[term.length - 1].name];
    }
}
exports.GetCompletionTypeAndMember = GetCompletionTypeAndMember;
function GetDefinition(params) {
    let pos = scriptfiles.ResolvePosition(params.textDocument.uri, params.position) - 1;
    if (pos < 0)
        return null;
    let file = scriptfiles.GetFile(params.textDocument.uri);
    if (file == null)
        return null;
    // Find the end of the identifier
    while (true) {
        let char = file.rootscope.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if (pos >= file.rootscope.content.length)
            break;
    }
    pos -= 1;
    if (pos < 0)
        return null;
    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);
    let checkTypes;
    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;
    ExpandCheckedTypes(checkTypes);
    let locations = [];
    for (let type of checkTypes) {
        if (!type.declaredModule)
            continue;
        let loc = scriptfiles.GetSymbolLocation(type.declaredModule, type.typename, term[term.length - 1].name);
        if (loc)
            locations.push(loc);
    }
    if (term.length == 1 && scope) {
        // We could be trying to go to something declared as a variable right inside the scope we're in
        let loc = scriptfiles.GetSymbolLocationInScope(scope, term[0].name);
        if (loc)
            locations.push(loc);
        // We could be trying to go to a type, rather than a variable or function
        let dbtype = typedb.GetType(term[0].name);
        if (!dbtype)
            dbtype = typedb.GetType("__" + term[0].name);
        if (dbtype && dbtype.declaredModule) {
            let loc = scriptfiles.GetTypeSymbolLocation(dbtype.declaredModule, dbtype.typename);
            if (loc)
                locations.push(loc);
        }
        // We could be trying to get a global symbol for any of the many global scopes
        if (locations.length == 0) {
            for (let [typename, dbtype] of typedb.database) {
                if (!typename.startsWith("//"))
                    continue;
                if (!dbtype.declaredModule)
                    continue;
                let loc = scriptfiles.GetSymbolLocation(dbtype.declaredModule, null, term[0].name);
                if (loc)
                    locations.push(loc);
            }
        }
    }
    if (term.length >= 1 && scope) {
        // We could be trying to get a ucs called global function that's in-scope
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes) {
            let func = globaltype.getMethod(term[term.length - 1].name);
            if (!func)
                continue;
            let loc = scriptfiles.GetSymbolLocation(func.declaredModule, null, func.name);
            if (loc)
                locations.push(loc);
        }
        // We could by trying to get a ucs called global function in any global scope
        if (locations.length == 0) {
            for (let [typename, dbtype] of typedb.database) {
                if (!typename.startsWith("//"))
                    continue;
                if (!dbtype.declaredModule)
                    continue;
                let loc = scriptfiles.GetSymbolLocation(dbtype.declaredModule, null, term[term.length - 1].name);
                if (loc)
                    locations.push(loc);
            }
        }
    }
    if (locations && locations.length != 0)
        return locations;
    return null;
}
exports.GetDefinition = GetDefinition;
function ResolveAutos(root) {
    for (let vardesc of root.variables) {
        if (vardesc.typename != "auto")
            continue;
        if (!vardesc.expression)
            continue;
        let terms = ParseTerms(vardesc.expression);
        let resolvedType = GetTypeFromTerm(terms, 0, terms.length, root, true);
        if (resolvedType)
            vardesc.typename = resolvedType.typename;
    }
    for (let subscope of root.subscopes) {
        ResolveAutos(subscope);
    }
}
exports.ResolveAutos = ResolveAutos;
//# sourceMappingURL=completion.js.map