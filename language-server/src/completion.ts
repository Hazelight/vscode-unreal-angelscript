import {
    TextDocumentPositionParams, CompletionItem, CompletionItemKind, SignatureHelp,
    SignatureInformation, ParameterInformation, Hover, MarkupContent, SymbolInformation,
    TextDocument, SymbolKind, Definition, Location, InsertTextFormat, TextEdit,
    Range, Position, MarkupKind
} from 'vscode-languageserver';

import * as scriptfiles from './as_parser';
import * as typedb from './database';
import { type } from 'os';

enum ASTermType
{
    Name,
    Namespace,
    PropertyAccess,
    FunctionCall,
    IndexOperator,
    ImportStatement
};

class ASExpressionType
{
    LValue : boolean = true;
    RValue : boolean = true;
    InBrackets : boolean = false;
};

class ASTerm
{
    type : ASTermType;
    name : string;
};

function ParseTerms(strTerm : string) : Array<ASTerm>
{
    let terms = new Array<ASTerm>();

    let termPos = 0;
    let brackets = 0;
    let pos = 0;
    let squarebrackets = 0;

    let finalizeTerm = function() 
    {
        if(pos > termPos)
        {
            terms.push(<ASTerm> {
                type: ASTermType.Name,
                name: strTerm.substring(termPos, pos),
            });
        }
    };

    for (pos = 0; pos < strTerm.length; ++pos)
    {
        let char = strTerm[pos];
        switch (char)
        {
            case ".":
                if (brackets == 0 && squarebrackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.PropertyAccess
                    });
                    termPos = pos+1;
                }
            break;
            case ":":
                if (brackets == 0 && squarebrackets == 0)
                {
                    if (pos > 0 && strTerm[pos-1] == ":")
                    {
                        pos -= 1;
                        finalizeTerm();
                        pos += 1;

                        terms.push(<ASTerm> {
                            type: ASTermType.Namespace
                        });
                        termPos = pos+1;
                    }
                }
            break;
            case "(":
                if (brackets == 0 && squarebrackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.FunctionCall
                    });
                }
                brackets += 1;
            break;
            case ")":
                brackets -= 1;
                if (brackets == 0 && squarebrackets == 0)
                    termPos = pos+1;
            break;
            case "[":
                if (squarebrackets == 0 && brackets == 0)
                {
                    finalizeTerm();
                    terms.push(<ASTerm> {
                        type: ASTermType.IndexOperator
                    });
                }
                squarebrackets += 1;
            break;
            case "]":
                squarebrackets -= 1;
                if (squarebrackets == 0 && brackets == 0)
                    termPos = pos+1;
            break;
        }
    }

    terms.push(<ASTerm> {
        type: ASTermType.Name,
        name: strTerm.substring(termPos, strTerm.length)
    });

    return terms;
}

function ExtractExpressionType(params : TextDocumentPositionParams, inScope : scriptfiles.ASScope) : ASExpressionType
{
    let expressionType = new ASExpressionType();
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (!asmodule)
        return expressionType;
    let pos = asmodule.getOffset(params.position) - 1;
    if (pos == -1 || !inScope)
        return expressionType;

    // Standard search for the left side of the expression
    {
        let foundDefault = false;
        let completePos = pos;
        let commaFound = false;
        let brackets = 0;
        let isInFunction = inScope.isInFunctionBody();

        while (completePos > 0 && completePos > inScope.start_offset)
        {
            let char = asmodule.content[completePos];
            if (char == ';' || char == '{' || char == '}')
            {
                expressionType.RValue = false;
                return expressionType;
            }
            else if (char == ',')
            {
                if (brackets == 0)
                {
                    if (isInFunction)
                    {
                        expressionType.LValue = false;
                        return expressionType;
                    }
                    else
                    {
                        commaFound = true;
                    }
                }
            }
            else if (char == ')')
            {
                brackets += 1;
            }
            else if (char == '(')
            {
                brackets -= 1;
                if (brackets < 0)
                {
                    expressionType.InBrackets = true;
                    if (isInFunction)
                    {
                        expressionType.LValue = false;
                        return expressionType;
                    }
                }
            }
            else if (char == '=')
            {
                if (brackets < 0 || !commaFound || isInFunction)
                {
                    expressionType.LValue = false;
                    return expressionType;
                }
            }
            else if (char == 'n' && pos >= 5 && asmodule.content.substr(completePos-5, 6) == "return")
            {
                expressionType.LValue = false;
                return expressionType;
            }
            else if (char == 'e' && pos >= 3 && asmodule.content.substr(completePos-3, 4) == "case")
            {
                expressionType.LValue = false;
                return expressionType;
            }
            completePos -= 1;
        }
    }

    return expressionType;
}

function ExtractCompletingTerm(params : TextDocumentPositionParams) : [Array<ASTerm>, scriptfiles.ASScope]
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (!asmodule)
        return [[], null];
    let pos = asmodule.getOffset(params.position) - 1;
    return ExtractCompletingTermAt(pos, params.textDocument.uri);
}

function ExtractCompletingTermAt(pos : number, uri : string) : [Array<ASTerm>, scriptfiles.ASScope]
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (asmodule == null)
        return [[], null];
    let termstart = pos;
    let brackets = 0;
    let anglebrackets = 0;
    let braces = 0;
    let squarebrackets = 0;
    while (termstart > 0)
    {
        let char = asmodule.content[termstart];
        let end = false;

        switch(char)
        {
            case ';': end = true; break;
            case '[':
                if(squarebrackets > 0)
                    squarebrackets -= 1;
                else end = true;
            break;
            case ']':
                squarebrackets += 1;
            break;
            case '(':
                if(brackets > 0)
                    brackets -= 1;
                else end = true;
            break;
            case ')':
                brackets += 1;
            break;
            case '<':
                if(anglebrackets > 0)
                    anglebrackets -= 1;
                else end = true;
            break;
            case '>':
                anglebrackets += 1;
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
            case '\n':
                if(brackets == 0 && squarebrackets == 0)
                    end = true;
            break;
        }

        if(end)
        {
            termstart += 1;
            break;
        }
        termstart -= 1;
    }

    let fullTerm = asmodule.content.substring(termstart, pos+1).trim();
    let scope = asmodule.getScopeAt(pos);

    if (termstart >= 7)
    {
        let importBefore = asmodule.content.substr(termstart-7, 7);
        if (importBefore == "import ")
        {
            return [[
                <ASTerm> {
                    type: ASTermType.ImportStatement,
                    name: fullTerm
                }
            ], scope];
        }
    }

    return [ParseTerms(fullTerm), scope];
}

function CanCompleteTo(completing : string, suggestion : string) : boolean
{
    if (completing.startsWith("Get"))
    {
        if (suggestion.startsWith("Get"))
            return suggestion.substr(3).toLowerCase().indexOf(completing.substr(3).toLowerCase()) != -1;
    }
    else if (completing.startsWith("Set"))
    {
        if (suggestion.startsWith("Set"))
            return suggestion.substr(3).toLowerCase().indexOf(completing.substr(3).toLowerCase()) != -1;
    }

    return suggestion.toLowerCase().indexOf(completing.toLowerCase()) != -1;
}

function GetTypeCompletions(initialTerm : string, completions : Array<CompletionItem>, expressionType : ASExpressionType)
{
    for (let [typename, dbtype] of typedb.GetAllTypes())
    {
        if (dbtype.isShadowedNamespace())
            continue;

        let kind : CompletionItemKind = CompletionItemKind.Class;
        if (dbtype.isNamespace())
        {
            typename = dbtype.rawName;
            kind = CompletionItemKind.Module;
        }

        if (typename.startsWith("//"))
            continue;

        if (dbtype.isEnum)
        {
            if (CanCompleteTo(initialTerm, typename))
            {
                // Allow completing to qualified enum values when appropriate
                if (expressionType.RValue)
                {
                    for (let enumvalue of dbtype.properties)
                    {
                        let enumstr = typename+"::"+enumvalue.name;
                        completions.push({
                                label: enumstr,
                                kind: CompletionItemKind.EnumMember,
                                data: ["enum", dbtype.typename, enumvalue.name],
                        });
                    }
                }

                completions.push({
                        label: typename,
                        kind: CompletionItemKind.Enum,
                        data: ["type", dbtype.typename],
                });
            }
            else if (initialTerm.endsWith(":") && initialTerm == typename+":")
            {
                // Allow completing to qualified enum values when appropriate
                for (let enumvalue of dbtype.properties)
                {
                    let enumstr = typename+"::"+enumvalue.name;
                    completions.push({
                            label: enumstr,
                            insertText: ":"+enumvalue.name,
                            kind: CompletionItemKind.EnumMember,
                            data: ["enum", dbtype.typename, enumvalue.name],
                    });
                }
            }
        }
        else
        {
            if (CanCompleteTo(initialTerm, typename))
            {
                completions.push({
                        label: typename,
                        kind: kind,
                        data: ["type", dbtype.typename],
                });
            }
        }

    }
}

function GetGlobalScopeTypes(scope : scriptfiles.ASScope, includeClass : boolean, includeRoot : boolean = true) : Array<typedb.DBType>
{
    let types = new Array<typedb.DBType>();

    let glob = typedb.GetType("__");
    if(glob && includeRoot)
        types.push(glob);

    let checkScope = scope;
    while (checkScope)
    {
        if (checkScope.scopetype == scriptfiles.ASScopeType.Global
            || (includeClass && checkScope.scopetype == scriptfiles.ASScopeType.Class))
        {
            let dbscope = checkScope.getDatabaseType();
            if(dbscope)
                types.push(dbscope);
        }
        checkScope = checkScope.parentscope;
    }

    return types;
}

function GetScopeCompletions(initialTerm : string, scope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    if (scope.scopetype == scriptfiles.ASScopeType.Class && CanCompleteTo(initialTerm, "this") && scope.getDatabaseType())
    {
        completions.push({
                label: "this",
                detail: scope.getDatabaseType().typename,
                kind : CompletionItemKind.Keyword
        });
    }

    if (scope.scopetype != scriptfiles.ASScopeType.Class
        && scope.scopetype != scriptfiles.ASScopeType.Global
    )
    {
        for (let scopevar of scope.variables)
        {
            if (CanCompleteTo(initialTerm, scopevar.name))
            {
                completions.push({
                        label: scopevar.name,
                        detail: scopevar.typename + " " + scopevar.name,
                        kind : CompletionItemKind.Variable
                });
            }
        }
    }

    if (scope.parentscope)
        GetScopeCompletions(initialTerm, scope.parentscope, completions);
}

function GetVariableType(variable : string, scope : scriptfiles.ASScope) : string | null
{
    if (scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        if (variable == "this")
        {
            let dbtype = scope.getDatabaseType();
            if (dbtype)
                return dbtype.typename;
        }
    }

    for (let scopevar of scope.variables)
    {
        if (scopevar.name == variable)
        {
            return scopevar.typename;
        }
    }

    if (scope.parentscope)
        return GetVariableType(variable, scope.parentscope);
    return null;
}

function ResolvePropertyType(term : string, type : typedb.DBType, scope : scriptfiles.ASScope) : typedb.DBType
{
    if (scope != null)
    {
        let typename = GetVariableType(term, scope);
        if (typename != null)
        {
            let dbtype = typedb.GetType(typename);
            if (dbtype != null)
                return dbtype;
        }
    }

    if (type == null && scope != null)
    {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes)
        {
            let prop = globaltype.getProperty(term);
            if (prop != null)
            {
                return typedb.GetType(prop.typename);
            }

            let accessortype = globaltype.getPropertyAccessorType(term);
            if (accessortype)
            {
                return typedb.GetType(accessortype);
            }
        }
    }
    else if (type != null)
    {
        let prop = type.getProperty(term);
        if (prop != null)
        {
            return typedb.GetType(prop.typename);
        }

        let accessortype = type.getPropertyAccessorType(term);
        if (accessortype)
        {
            return typedb.GetType(accessortype);
        }
    }

    return null;
}

function ResolveFunctionType(term : string, type : typedb.DBType, scope : scriptfiles.ASScope, globScope : scriptfiles.ASScope = null) : typedb.DBType
{
    if (type == null && scope != null)
    {
        let globaltypes = GetGlobalScopeTypes(scope, true);
        for (let globaltype of globaltypes)
        {
            let mthd = globaltype.getMethod(term);
            if(mthd)
            {
                let dbtype = typedb.GetType(mthd.returnType);
                if(dbtype)
                    return dbtype;
            }
        }
    }

    if (type != null)
    {
        let func = type.getMethod(term);
        if (func)
        {
            return typedb.GetType(func.returnType);
        }

        if (globScope != null)
        {
            // Deal with unified call syntax from global functions
            let ucsScopes = GetGlobalScopeTypes(globScope, false, false);
            for (let globaltype of ucsScopes)
            {
                let func = globaltype.getMethod(term);
                if (func)
                {
                    return typedb.GetType(func.returnType);
                }
            }
        }
    }

    return null;
}

let re_cast = /Cast<([A-Za-z0-9_]+)>/;
function GetTypeFromTerm(initialTerm : Array<ASTerm>, startIndex : number, endIndex : number, scope : scriptfiles.ASScope, finalizeResolve : boolean = false) : typedb.DBType
{
    // Terms in between the first and last are properties of types
    let curtype : typedb.DBType = null;
    let curname : string = null;
    let curscope : scriptfiles.ASScope = scope;
    let globscope = scope;

    for(let index = startIndex; index < endIndex; ++index)
    {
        let term = initialTerm[index];
        switch(term.type)
        {
            case ASTermType.Name:
                curname = term.name;
            break;
            case ASTermType.PropertyAccess:
                if (curname != null)
                {
                    curtype = ResolvePropertyType(curname, curtype, curscope);
                    curscope = null;
                    curname = null;
                    if (curtype == null)
                    {
                        return null;
                    }
                }
            break;
            case ASTermType.FunctionCall:
                if (curname != null)
                {
                    if (curname.startsWith("Cast"))
                    {
                        let castmatch = re_cast.exec(curname);
                        if (castmatch)
                        {
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
                if (curname != null)
                {
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
                if (curname == "Super")
                {
                    if (curscope != null)
                    {
                        let scopetype = curscope.getDatabaseType();
                        if (scopetype != null)
                            curtype = typedb.GetType(scopetype.supertype);
                        else
                            curtype = null;
                        curname = null;
                        curscope = null;
                        if (curtype == null)
                            return null;
                    }
                }
                else if (curname != null)
                {
                    curtype = typedb.GetType("__"+curname);
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

function GetTermCompletions(initialTerm : Array<ASTerm>, inScope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    let curtype = GetTypeFromTerm(initialTerm, 0, initialTerm.length - 1, inScope);
    if (curtype == null)
        return;

    // The last term is always the name we're trying to complete    
    let completingStr = initialTerm[initialTerm.length - 1].name.toLowerCase();
    AddCompletionsFromType(curtype, completingStr, completions, inScope);

    // Deal with unified call syntax from global functions
    let globaltypes = GetGlobalScopeTypes(inScope, false, false);
    for (let globaltype of globaltypes)
    {
        for (let func of globaltype.allMethods())
        {
            if(func.args && func.args.length >= 1 && curtype.inheritsFrom(func.args[0].typename))
            {
                if (CanCompleteTo(completingStr, func.name))
                {
                    if(!func.name.startsWith("op"))
                    {
                        completions.push({
                                label: func.name,
                                kind: CompletionItemKind.Method,
                                data: ["func", curtype.typename, func.name, func.id],
                        });
                    }
                }
            }
        }
    }
}

function isEditScope(inScope : scriptfiles.ASScope) : boolean
{
    if (!inScope)
        return false;
    let funcScope = inScope.getParentFunctionScope();
    if (funcScope != null)
    {
        let dbFunc = funcScope.getDatabaseFunction();
        if (!dbFunc || dbFunc.name != "ConstructionScript")
            return false;
    }
    else if (inScope.scopetype != scriptfiles.ASScopeType.Class)
    {
        return false;
    }
    return true;
}

function isPropertyAccessibleFromScope(curtype : typedb.DBType, prop : typedb.DBProperty, inScope : scriptfiles.ASScope) : boolean
{
    if (prop.isPrivate || prop.isProtected)
    {
        if (!inScope)
            return false;
        let dbtype = inScope.getParentType();
        if (!dbtype)
            return false;

        if (prop.isPrivate)
        {
            // Needs to be in this class to have access
            if (!curtype || dbtype.typename != curtype.typename)
                return false;
        }
        else if (prop.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(curtype.typename))
                return false;
        }
    }

    if (prop.isEditOnly)
    {
        if (!isEditScope(inScope))
            return false;
    }
    
    if (prop.isNoEdit)
    {
        if (isEditScope(inScope))
            return false;
    }

    return true;
}

function isFunctionAccessibleFromScope(curtype : typedb.DBType, func : typedb.DBMethod, inScope : scriptfiles.ASScope) : boolean
{
    if (func.isPrivate || func.isProtected)
    {
        if (!inScope)
            return false;
        let dbtype = inScope.getParentType();
        if (!dbtype)
            return false;

        if (func.isPrivate)
        {
            // Needs to be in this class to have access
            if (!curtype || dbtype.typename != curtype.typename)
                return false;
        }
        else if (func.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(curtype.typename))
                return false;
        }
    }

    if (func.isDefaultsOnly)
    {
        if (!isEditScope(inScope))
            return false;
    }

    return true;
}

export function AddCompletionsFromType(curtype : typedb.DBType, completingStr : string, completions : Array<CompletionItem>, inScope : scriptfiles.ASScope, showEvents : boolean = true)
{
    let props = new Set<string>();
    for (let prop of curtype.allProperties())
    {
        if (CanCompleteTo(completingStr, prop.name))
        {
            if (!isPropertyAccessibleFromScope(curtype, prop, inScope))
                continue;
            props.add(prop.name);
            completions.push({
                    label: prop.name,
                    kind : CompletionItemKind.Field,
                    data: ["prop", curtype.typename, prop.name],
            });
        }
    }

    let getterStr = "Get"+completingStr;
    let setterStr = "Set"+completingStr;
    for (let func of curtype.allMethods())
    {
        if (func.name.startsWith("Get") && CanCompleteTo(getterStr, func.name) && func.isProperty)
        {
            if (!isFunctionAccessibleFromScope(curtype, func, inScope))
                continue;
            let propname = func.name.substr(3);
            if(!props.has(propname) && func.args.length == 0)
            {
                completions.push({
                        label: propname,
                        kind: CompletionItemKind.Field,
                        data: ["accessor", curtype.typename, propname],
                });
                props.add(propname);
            }
        }
        
        if (func.name.startsWith("Set") && CanCompleteTo(setterStr, func.name) && func.isProperty)
        {
            if (!isFunctionAccessibleFromScope(curtype, func, inScope))
                continue;
            let propname = func.name.substr(3);
            if(!props.has(propname) && func.args.length == 1 && func.returnType == "void")
            {
                completions.push({
                        label: propname,
                        kind: CompletionItemKind.Field,
                        data: ["accessor", curtype.typename, propname],
                });
                props.add(propname);
            }
        }

        if (CanCompleteTo(completingStr, func.name))
        {
            if (!isFunctionAccessibleFromScope(curtype, func, inScope))
                continue;
            if(!func.name.startsWith("op") && (!func.isEvent || showEvents))
            {
                completions.push({
                        label: func.name,
                        kind: func.isEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                        data: ["func", curtype.typename, func.name, func.id],
                });
            }
        }
    }
}

function AddScopeKeywords(keywords : Array<string>, completingStr : string, completions : Array<CompletionItem>)
{
    for(let kw of keywords)
    {
        if (CanCompleteTo(completingStr, kw))
        {
            completions.push({
                    label: kw,
                    kind: CompletionItemKind.Keyword
            });
        }
    }
}

function AddKeywordCompletions(completingStr : string, completions : Array<CompletionItem>, scope : scriptfiles.ASScope, expressionType : ASExpressionType)
{
    let inFunctionBody = scope && scope.getParentFunctionScope() != null;

    AddScopeKeywords([
        "float", "bool", "int", "double",
    ], completingStr, completions);

    if (expressionType.RValue)
    {
        AddScopeKeywords([
            "nullptr", "true", "false",
        ], completingStr, completions);
    }
    
    if (expressionType.LValue)
    {
        AddScopeKeywords([
            "const",
        ], completingStr, completions);
    }

    if ((!scope || scope.scopetype == scriptfiles.ASScopeType.Global || scope.scopetype == scriptfiles.ASScopeType.Namespace)
        && expressionType.LValue)
    {
        AddScopeKeywords([
            "UCLASS",
            "delegate", "event", "class", "struct",
            "property"
        ], completingStr, completions);
    }

    if (scope && inFunctionBody)
    {
        if (expressionType.LValue)
        {
            AddScopeKeywords([
                "return",
                "if", "else", "while", "for",
            ], completingStr, completions);
        }
    }
    else
    {
        if (expressionType.LValue)
        {
            AddScopeKeywords([
                "void",
            ], completingStr, completions);
        }
    }

    if (scope && scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        if (expressionType.LValue)
        {
            AddScopeKeywords([
                "UPROPERTY", "override", "final", "property", "private", "protected",
                "EditAnywhere","EditDefaultsOnly","EditInstanceOnly","BlueprintReadWrite","BlueprintReadOnly","NotBlueprintVisible","NotEditable","DefaultComponent","RootComponent","Attach","Transient","NotVisible","EditConst","BlueprintHidden","Replicated","NotReplicated","ReplicationCondition","Interp","NoClear",
            ], completingStr, completions);
        }

        let scopeType = scope.getDatabaseType();
        if (scopeType && !scopeType.isStruct)
        {
            if (expressionType.LValue)
            {
                AddScopeKeywords([
                    "default", "UFUNCTION",
                    "BlueprintOverride","BlueprintEvent","BlueprintCallable","NotBlueprintCallable","BlueprintPure","NetFunction","CrumbFunction","DevFunction","Category","Meta","NetMulticast","Client","Server","WithValidation","BlueprintAuthorityOnly","CallInEditor","Unreliable",
                ], completingStr, completions);
            }
        }
    }
}

function ImportCompletion(term : string) : Array<CompletionItem>
{
    let completions = new Array<CompletionItem>();

    let untilDot = "";
    let dotPos = term.lastIndexOf(".");
    if (dotPos != -1)
        untilDot = term.substr(0, dotPos+1);

    for (let asmodule of scriptfiles.GetAllModules())
    {
        if (CanCompleteTo(term, asmodule.modulename))
        {
            completions.push({
                label: asmodule.modulename,
                kind: CompletionItemKind.File,
                insertText: asmodule.modulename.substr(untilDot.length),
            });
        }
    }
    return completions;
}

export function Complete(params : TextDocumentPositionParams) : Array<CompletionItem>
{
    let [initialTerm, inScope] = ExtractCompletingTerm(params);
    let expressionType = ExtractExpressionType(params, inScope);

    if (initialTerm.length == 1 && initialTerm[0].type == ASTermType.ImportStatement)
        return ImportCompletion(initialTerm[0].name);

    let completions = new Array<CompletionItem>();
    let scopeType = inScope ? inScope.getDatabaseType() : null;

    // Add completions local to the angelscript scope
    let allowScopeCompletions = initialTerm.length == 1;
    if (allowScopeCompletions && inScope != null)
    {
        GetScopeCompletions(initialTerm[0].name, inScope, completions);
    }

    // If we're not inside a type, also complete to type names for static functions / declarations
    if (allowScopeCompletions)
    {
        GetTypeCompletions(initialTerm[0].name, completions, expressionType);
    }
    
    // If we're not inside a type, also complete to anything is global scope
    if (allowScopeCompletions)
    {
        let globaltypes = GetGlobalScopeTypes(inScope, true);
        for(let globaltype of globaltypes)
        {
            let showEvents = !inScope || inScope.scopetype != scriptfiles.ASScopeType.Class || !scopeType || globaltype.typename != scopeType.typename;
            AddCompletionsFromType(globaltype, initialTerm[0].name, completions, inScope, showEvents);
        }

        AddKeywordCompletions(initialTerm[0].name, completions, inScope, expressionType);
    }

    // We are already inside a type, so we need to complete based on that type
    if (initialTerm.length >= 2 && inScope != null)
        GetTermCompletions(initialTerm, inScope, completions);

    // Check if we're inside a function call and complete argument names
    let insideSignature = false;
    if (initialTerm.length == 1)
        insideSignature = AddSignatureCompletions(initialTerm[0].name, params, completions, inScope);

    // Check for snippet completions for method overrides
    if (inScope && inScope.scopetype == scriptfiles.ASScopeType.Class && initialTerm.length == 1
            && expressionType.LValue && !expressionType.InBrackets
            && !insideSignature)
    {
        AddMethodOverrideSnippets(params, initialTerm[0].name, completions, inScope);
    }

    return completions;
}

function AddSignatureCompletions(initialTerm : string, params : TextDocumentPositionParams, completions : Array<CompletionItem>, inScope : scriptfiles.ASScope) : boolean
{
    let typeOfScope : typedb.DBType = null;
    if (inScope && inScope.scopetype == scriptfiles.ASScopeType.Class)
        typeOfScope = inScope.getDatabaseType();

    // Check if we're inside a function call and complete argument names
    let signatures = GetMethodSignaturesAroundPosition(params);
    if (signatures && signatures.methods.length> 0 && signatures.isStartOfArg)
    {
        if (signatures.activeSignature < signatures.methods.length)
        {
            let method = signatures.methods[signatures.activeSignature];
            let objType = signatures.objectTypes[signatures.activeSignature];

            let completeDefinition = false;
            if (typeOfScope != null && objType && typeOfScope.inheritsFrom(objType.typename) && typeOfScope.canOverrideFromParent(method.name))
                completeDefinition = true;
            if (method.args)
            {
                for (let arg of method.args)
                {
                    let complStr = completeDefinition ? arg.typename+" "+arg.name : arg.name+" = ";
                    if (CanCompleteTo(initialTerm, complStr))
                    {
                        completions.push({
                            label: complStr,
                            documentation: <MarkupContent> {
                                kind: MarkupKind.Markdown,
                                value: "```angelscript\n"+complStr+"\n\n```"
                            },
                            kind: CompletionItemKind.Snippet,
                        });
                    }
                }
            }
        }
    }

    return signatures && signatures.methods.length != 0;
}

function GetDeclarationSnippet(method : typedb.DBMethod, includeReturnType : boolean) : string
{
    let complStr = "";
    if (includeReturnType)
        complStr += method.returnType+" ";
    complStr += method.name+"(";
    if (method.args)
    {
        let firstArg = true;
        for (let arg of method.args)
        {
            if (!firstArg)
                complStr += ", ";
            firstArg = false;

            complStr += arg.typename+" "+arg.name;
        }
    }
    complStr += ")";
    if (method.isConst)
        complStr += " const";
    if (!method.isEvent)
        complStr += " override";
    if (!method.isEvent && method.isProperty && method.declaredModule)
        complStr += " property";
    complStr += "\n";
    return complStr;
}

function NoBreakingSpaces(decl : string) : string
{
    return decl.replace(/ /g, "\xa0");
}

function AddMethodOverrideSnippets(positionParams : TextDocumentPositionParams, initialTerm : string, completions : Array<CompletionItem>, inScope : scriptfiles.ASScope)
{
    let typeOfScope = inScope ? inScope.getDatabaseType() : null;
    if (!typeOfScope || !typeOfScope.supertype)
        return;
    if (initialTerm.length == 0)
        return;

    let asmodule = scriptfiles.GetModuleByUri(positionParams.textDocument.uri);
    let position = positionParams.position;

    let prevLineText = asmodule.textDocument.getText(
        Range.create(
            Position.create(position.line-1, 0),
            Position.create(position.line, 0)
        )
    );

    let curLineText = asmodule.textDocument.getText(
        Range.create(
            Position.create(position.line, 0),
            Position.create(position.line+1, 0)
        )
    );

    let hasUFunctionMacro = prevLineText.indexOf("UFUNCTION") != -1;
    let textEdits = new Array<TextEdit>();

    let currentIndent = "";
    for (let char of curLineText)
    {
        if (char == ' ' || char == '\t')
            currentIndent += char;
        else
            break;
    }

    let hasReturnType = curLineText.trim().indexOf(initialTerm) != 0;

    // Add the closing brace
    textEdits.push(TextEdit.insert(
        Position.create(position.line+1, 0),
        currentIndent+"}\n",
    ));

    // Add the UFUNCTION() macro if we don't have one
    let textEditsForEvent = [];
    if (!hasUFunctionMacro)
    {
        textEditsForEvent.push(TextEdit.insert(
            Position.create(position.line, 0),
            currentIndent+"UFUNCTION(BlueprintOverride)\n"
        ))
    }

    let checktype = typedb.GetType(typeOfScope.supertype);
    let foundOverrides = new Set<string>();
    while (checktype)
    {
        for (let method of checktype.methods)
        {
            let includeReturnType = false;
            let includeParamsOnly = false;

            if (method.name && CanCompleteTo(initialTerm, method.name))
                includeParamsOnly = true;
            if (method.returnType && CanCompleteTo(initialTerm, method.returnType))
                includeReturnType = true;

            if (!includeParamsOnly && !includeReturnType)
                continue;

            if (checktype.isUnrealType() && !method.isEvent)
                continue;
            if (foundOverrides.has(method.name))
                continue;

            let complStr = GetDeclarationSnippet(method, false);
            let complEdits = textEdits;

            if (method.isEvent)
                complEdits = complEdits.concat(textEditsForEvent);

            let superStr = "";
            if (method.declaredModule && (!method.returnType || method.returnType == "void"))
            {
                superStr += "Super::"+method.name+"(";
                for (let i = 0; i < method.args.length; ++i)
                {
                    if (i != 0)
                        superStr += ", ";
                    superStr += method.args[i].name;
                }
                superStr += ");\n"+currentIndent;
            }

            if (includeParamsOnly)
            {
                if (!hasReturnType)
                {
                    complEdits = complEdits.concat(
                        TextEdit.replace(
                            Range.create(
                                Position.create(position.line, 0),
                                Position.create(position.line, position.character-1),
                            ),
                            currentIndent + method.returnType+" "
                        )
                    );
                }

                completions.push({
                    label: method.returnType+" "+method.name+"(...)",
                    filterText: method.name+"(...)",
                    insertText: complStr+"{\n"+currentIndent+superStr,
                    kind: CompletionItemKind.Snippet,
                    data: ["decl_snippet", checktype.typename, method.name, method.id],
                    additionalTextEdits: complEdits,
                });
            }
            else if (includeReturnType)
            {
                completions.push({
                    label: method.returnType+" "+method.name+"(...)",
                    insertText: method.returnType+" "+complStr+"{\n"+currentIndent+superStr,
                    kind: CompletionItemKind.Snippet,
                    data: ["decl_snippet", checktype.typename, method.name, method.id],
                    additionalTextEdits: complEdits,
                });
            }

            foundOverrides.add(method.name);
        }

        if (!checktype.supertype)
            break;
        checktype = typedb.GetType(checktype.supertype);
    }
}

function NicifyDefinition(func : typedb.DBMethod, def : string) : string
{
    if (def.length < 40 || !func.args || func.args.length == 0)
        return def;

    def = def.replace("(", "(\n\t");
    def = def.replace(/, /g, ",\n\t");
    return def;
}

export function Resolve(item : CompletionItem) : CompletionItem
{
    if (!item.data)
        return item;

    let kind = item.data[0];
    let type = typedb.GetType(item.data[1]);
    if (type == null)
        return item;

    if (kind == "type")
    {
        if (type.documentation)
            item.documentation = type.documentation.replace(/\n/g,"\n\n");
        return item;
    }
    else if (kind == "enum" || kind == "prop")
    {
        let prop = type.getProperty(item.data[2]);
        if (prop)
        {
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript\n"+NoBreakingSpaces(prop.format())+"\n```\n\n",
            };
            if (prop.documentation)
                item.documentation.value += "\n"+prop.documentation.replace(/\n/g,"\n\n")+"\n\n";
        }
    }
    else if (kind == "accessor")
    {
        let getFunc = type.getMethod("Get"+item.data[2]);
        let setFunc = type.getMethod("Set"+item.data[2]);

        let docStr = "";
        if (getFunc)
        {
            docStr += "```angelscript\n"+getFunc.returnType+"\xa0"+item.data[2]+"\n```\n\n";
        }
        else if (setFunc && setFunc.args && setFunc.args.length >= 1)
        {
            docStr += "```angelscript\n"+setFunc.args[0].typename+"\xa0"+item.data[2]+"\n```\n\n";
        }

        if (getFunc && getFunc.documentation && getFunc.documentation.length != 0)
            docStr += "\n"+getFunc.documentation.replace(/\n/g,"\n\n")+"\n\n";
        else if (setFunc && setFunc.documentation && setFunc.documentation.length != 0)
            docStr += "\n"+setFunc.documentation.replace(/\n/g,"\n\n")+"\n\n";
            
        item.documentation = <MarkupContent> {
            kind: MarkupKind.Markdown,
            value: docStr,
        };
    }
    else if (kind == "func")
    {
        let func = type.getMethodWithIdHint(item.data[2], item.data[3]);
        if (func)
        {
            let complStr = NoBreakingSpaces(NicifyDefinition(func, func.format()));
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript\n"+complStr+"\n```\n\n",
            };

            if (func.documentation)
                item.documentation.value += "\n"+func.documentation.replace(/\n/g,"\n\n")+"\n\n";
        }
    }
    else if (kind == "decl_snippet")
    {
        let func = type.getMethodWithIdHint(item.data[2], item.data[3]);
        if (func)
        {
            let complStr = NoBreakingSpaces(GetDeclarationSnippet(func, true));
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript\n"+complStr+"\n```\n\n",
            };

            if (func.documentation)
                item.documentation.value += "\n"+func.documentation.replace(/\n/g,"\n\n")+"\n\n";
        }
    }

    return item;
}

class MethodSignatures
{
    isStartOfArg : boolean = true;
    paramCount : number = 0;
    activeSignature : number = 0;
    methods : Array<typedb.DBMethod>;
    objectTypes : Array<typedb.DBType>;
};

function GetMethodSignaturesAroundPosition(params : TextDocumentPositionParams) : MethodSignatures
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule == null)
        return null;

    let pos = asmodule.getOffset(params.position) - 1;
    let originalPos = pos;
    if (pos < 0)
        return null;


    // Find the opening bracket in front of our current pos
    let brackets = 0;
    let commaFound = false;
    let isStartOfArg = true;
    while (true)
    {
        let char = asmodule.content[pos];
        if (char == ';' || char == '{' || char == '}')
            return null;
        if (char == ')')
            brackets += 1;
        if (char == '(')
        {
            brackets -= 1;
            if(brackets < 0)
                break;
        }
        if (char == ',' && brackets == 0)
            commaFound = true;
        if (char == '=' && !commaFound)
            isStartOfArg = false;

        pos -= 1;
        if(pos < 0)
            return null;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;

    let signatures = new MethodSignatures();
    signatures.methods = new Array<typedb.DBMethod>();
    signatures.objectTypes = new Array<typedb.DBType>();
    signatures.paramCount = GetActiveParameterCount(originalPos, params.textDocument.uri);
    signatures.isStartOfArg = isStartOfArg;

    let scopeType = scope.getDatabaseType();

    let foundFunc = false;
    for (let type of checkTypes)
    {
        if (scope.scopetype == scriptfiles.ASScopeType.Class)
        {
            // Ignore functions from the class if we're in the
            // class' scope. Since we're most likely completing
            // an override function declaration at this point.
            if (scopeType && type.typename == scopeType.typename)
            {
                // Switch to the parent type so we can complete overrides for its functions
                type = type.supertype ? typedb.GetType(type.supertype) : null;
                if (!type)
                    continue;
            }
        }

        for (let func of type.allMethods())
        {
            if (func.name != term[term.length-1].name)
                continue;

            // Show the active signature for the least amount of arguments
            if (func.args.length > signatures.paramCount && !foundFunc)
            {
                signatures.activeSignature = signatures.methods.length;
                foundFunc = true;
            }

            signatures.methods.push(func);
            signatures.objectTypes.push(type);
        }
    }

    // Deal with unified call syntax from global functions
    if(curtype != null && scope != null)
    {
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes)
        {
            for (let func of globaltype.allMethods())
            {
                if (func.name != term[term.length-1].name)
                    continue;
                if(!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                    continue;

                signatures.methods.push(func);
                signatures.objectTypes.push(null);
            }
        }
    }

    return signatures;
}

export function Signature(params : TextDocumentPositionParams) : SignatureHelp
{
    let signatures = GetMethodSignaturesAroundPosition(params);
    if (!signatures)
        return null;

    let sigHelp = <SignatureHelp> {
        signatures : new Array<SignatureInformation>(),
        activeSignature : signatures.activeSignature,
        activeParameter : signatures.paramCount,
    };

    for (let i = 0; i < signatures.methods.length; ++i)
    {
        let func = signatures.methods[i];
        let type = signatures.objectTypes[i];

        let params = new Array<ParameterInformation>();
        if (func.args)
        {
            for (let a = type ? 0 : 1; a < func.args.length; ++a)
            {
                params.push(<ParameterInformation>
                {
                    label: func.args[a].format()
                });
            }
        }

        let sig = <SignatureInformation> {
            label: func.format(null, !type),
            parameters: params,
        };
        if (func.documentation)
            sig.documentation = func.documentation;

        sigHelp.signatures.push(sig);
    }

    return sigHelp.signatures.length == 0 ? null : sigHelp;
}

function GetScopeHover(initialTerm : string, scope : scriptfiles.ASScope) : string | null
{
    if (scope.scopetype != scriptfiles.ASScopeType.Class
        && scope.scopetype != scriptfiles.ASScopeType.Global
    )
    {
        for (let scopevar of scope.variables)
        {
            if (scopevar.name == initialTerm)
            {
                let hover = "";
                if(scopevar.documentation)
                {
                    hover += "*";
                    hover += scopevar.documentation.replace("\n","*\n\n*");
                    hover += "*\n\n";
                }

                hover += "```angelscript\n"+scopevar.typename+" "+scopevar.name+"\n```";
                return hover;
            }
        }
    }

    if (scope.scopetype == scriptfiles.ASScopeType.Class)
    {
        if (initialTerm == "this")
        {
            let typeOfScope = scope.getDatabaseType();
            if (typeOfScope)
                return "```angelscript\n"+typeOfScope.typename+" this\n```";
        }
    }

    if (scope.parentscope)
        return GetScopeHover(initialTerm, scope.parentscope);
    return null;
}

function AddScopeSymbols(asmodule : scriptfiles.ASModule, scope : scriptfiles.ASScope, symbols: Array<SymbolInformation>)
{
    let scopeType = scope.getDatabaseType();
    if (scopeType)
    {
        let scopeSymbol = <SymbolInformation> {
            name : scopeType.typename,
            location : asmodule.getLocationRange(scope.start_offset, scope.end_offset),
        };

        if (scope.scopetype == scriptfiles.ASScopeType.Class)
        {
            scopeSymbol.kind = SymbolKind.Class;
            symbols.push(scopeSymbol);

            for (let classVar of scope.variables)
            {
                if (classVar.isArgument)
                    continue;

                symbols.push(<SymbolInformation> {
                    name : classVar.name,
                    kind : SymbolKind.Variable,
                    location : asmodule.getLocationRange(classVar.start_offset_name, classVar.end_offset_name),
                    containerName : scopeType.typename,
                });
            }
        }
        else if (scope.scopetype == scriptfiles.ASScopeType.Enum)
        {
            scopeSymbol.kind = SymbolKind.Enum;
            symbols.push(scopeSymbol);
        }
    }

    let scopeFunc = scope.getDatabaseFunction();
    if (scopeFunc)
    {
        let scopeSymbol = <SymbolInformation> {
            name : scopeFunc.name+"()",
            location : asmodule.getLocationRange(scope.start_offset, scope.end_offset),
        };

        if (scope.scopetype == scriptfiles.ASScopeType.Function)
        {
            if (scope.parentscope.scopetype == scriptfiles.ASScopeType.Class)
            {
                scopeSymbol.kind = SymbolKind.Method;
                scopeSymbol.containerName = scope.parentscope.getDatabaseType().typename;
            }
            else
            {
                scopeSymbol.kind = SymbolKind.Function;
            }

            symbols.push(scopeSymbol);
        }
    }

    for (let subscope of scope.scopes)
        AddScopeSymbols(asmodule, subscope, symbols);
}

export function DocumentSymbols( uri : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (!asmodule)
        return symbols;

    AddScopeSymbols(asmodule, asmodule.rootscope, symbols);
    return symbols;
}

export function WorkspaceSymbols( query : string ) : SymbolInformation[]
{
    let symbols = new Array<SymbolInformation>();
    for (let asmodule of scriptfiles.GetAllModules())
        AddScopeSymbols(asmodule, asmodule.rootscope, symbols);
    return symbols;
}

function FormatHoverDocumentation(doc : string) : string
{
    if (doc)
    {
        let outDoc = "*";
        outDoc += doc.replace(/\s*\r?\n\s*/g,"*\n\n*");
        outDoc += "*\n\n";
        return outDoc;
    }
    return "";
}

export function GetHover(params : TextDocumentPositionParams) : Hover
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule == null)
        return null;

    let pos = asmodule.getOffset(params.position);
    if (pos < 0)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = asmodule.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= asmodule.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;

    let hover = "";
    let settername = "Set"+term[term.length-1].name;
    let gettername = "Get"+term[term.length-1].name;
    let hadPropertyDoc = false;
    for (let type of checkTypes)
    {
        for (let func of type.allMethods())
        {
            if (func.name != term[term.length-1].name && func.name != gettername && func.name != settername)
                continue;
            if (func.isConstructor)
                continue;

            let prefix = null;
            if(type.typename.startsWith("__"))
            {
                if(type.typename != "__")
                    prefix = type.typename.substring(2)+"::";
            }
            else if(!type.typename.startsWith("//"))
                prefix = type.typename+".";

            hover = "";

            if (func.documentation)
            {
                hover += FormatHoverDocumentation(func.documentation);
            }
            else if (type.supertype)
            {
                // Fall back to using the documentation from the parent class
                let supertype = typedb.GetType(type.supertype);
                if (supertype)
                {
                    let parentFunc = supertype.getMethod(func.name);
                    if (parentFunc && parentFunc.documentation)
                        hover += FormatHoverDocumentation(parentFunc.documentation);
                }
            }

            if (func.documentation)
                hadPropertyDoc = true;
            if (func.name == gettername)
                hover += "```angelscript\n"+func.returnType+" "+prefix+term[term.length-1].name+"\n```";
            else if (func.name == settername && func.args.length >= 1)
                hover += "```angelscript\n"+func.args[0].typename+" "+prefix+term[term.length-1].name+"\n```";
            else
                hover += "```angelscript\n"+func.format(prefix)+"\n```";

            if ((func.name == gettername || func.name == settername) && !hadPropertyDoc)
                continue;
            else
                break;
        }

        if (hover.length != 0 && hadPropertyDoc)
            break;

        for (let prop of type.allProperties())
        {
            if (prop.name != term[term.length-1].name)
                continue;

            let prefix = null;
            if(type.typename.startsWith("__"))
            {
                if(type.typename != "__")
                    prefix = type.typename.substring(2)+"::";
            }
            /*else if(!type.typename.startsWith("//"))
                prefix = type.typename+".";*/

            hover = "";
            hover += FormatHoverDocumentation(prop.documentation);
            hover += "```angelscript\n"+prop.format(prefix)+"\n```";
            if (prop.documentation)
                hadPropertyDoc = true;
            break;
        }

        if(hover.length != 0)
            break;
    }

    if (term.length == 1 && scope && hover == "")
    {
        hover = GetScopeHover(term[0].name, scope);
    }

    // Deal with unified call syntax from global functions
    if(term.length != 1 && hover == "")
    {
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes)
        {
            for (let func of globaltype.allMethods())
            {
                if (func.name != term[term.length-1].name)
                    continue;
                if (!func.args || func.args.length == 0 || !curtype.inheritsFrom(func.args[0].typename))
                    continue;

                hover = "";
                hover += FormatHoverDocumentation(func.documentation);
                hover += "```angelscript\n"+func.format(null, true)+"\n```";
            }
        }
    }

    if (term.length == 1 && (!hover || hover.length == 0) && term[0].name.length != 0)
    {
        let hoveredType = typedb.GetType(term[0].name);
        if (hoveredType)
        {
            let hover = "";
            hover += FormatHoverDocumentation(hoveredType.documentation);
            hover += "```angelscript\n";
            if (hoveredType.isDelegate)
            {
                hover += "delegate ";
                let mth = hoveredType.getMethod("ExecuteIfBound");
                if (mth)
                    hover += mth.format(null, false, false, hoveredType.typename);
                else
                    hover += hoveredType.typename;
            }
            else if (hoveredType.isEvent)
            {
                hover += "event ";
                let mth = hoveredType.getMethod("Broadcast");
                if (mth)
                    hover += mth.format(null, false, false, hoveredType.typename);
                else
                    hover += hoveredType.typename;
            }
            else
            {
                if (!hoveredType.isPrimitive)
                {
                    if (hoveredType.isStruct)
                        hover += "struct ";
                    else
                        hover += "class ";
                }
                hover += hoveredType.typename;
                if (hoveredType.supertype)
                    hover += " : "+hoveredType.supertype;
                else if (hoveredType.unrealsuper)
                    hover += " : "+hoveredType.unrealsuper;
            }

            hover += "\n```";
            return <Hover> {contents: <MarkupContent> {
                kind: "markdown",
                value: hover,
            }};
        }

        let nsType = typedb.GetType("__"+term[0].name);
        if (nsType)
        {
            let hover = "";
            hover += FormatHoverDocumentation(nsType.documentation);
            hover += "```angelscript\n";
            nsType.resolveNamespace();
            if (nsType.isEnum)
                hover += "enum ";
            else
                hover += "namespace ";
            hover += nsType.rawName;
            hover += "\n```";

            return <Hover> {contents: <MarkupContent> {
                kind: "markdown",
                value: hover,
            }};
        }
    }

    if (hover == "")
        return null;

    return <Hover> {contents: <MarkupContent> {
        kind: "markdown",
        value: hover,
    }};
}

function ExpandCheckedTypes(checkTypes : Array<typedb.DBType>)
{
    let count = checkTypes.length;
    for (let i = 0; i < count; ++i)
    {
        let checkType = checkTypes[i];
        if (checkType.hasExtendTypes())
        {
            for (let extendType of checkType.getExtendTypes())
            {
                if (!checkTypes.includes(extendType))
                    checkTypes.push(extendType);
            }
        }
    }
}

function GetScopeUnrealType(scope : scriptfiles.ASScope) : string
{
    let insideType = scope.getParentType();
    if (!insideType)
        return "";
    return GetUnrealTypeFor(insideType.typename);
}

export function GetUnrealTypeFor(typename : string) : string
{
    // Walk through the typedb to find parent types until we find a C++ class
    let type = typedb.GetType(typename);
    while(type && type.declaredModule && type.supertype)
        type = typedb.GetType(type.supertype);

    if (!type)
        return "";

    return type.typename;
}

export function GetCompletionTypeAndMember(params : TextDocumentPositionParams) : Array<string>
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule == null)
        return null;

    let pos = asmodule.getOffset(params.position);
    if (pos < 0)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = asmodule.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= asmodule.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
    {
        return [curtype.typename, term[term.length-1].name];
    }
    else if(scope)
    {
        return [GetScopeUnrealType(scope), term[term.length-1].name];
    }
    else
    {
        return ["", term[term.length-1].name];
    }
}

export function GetDefinition(params : TextDocumentPositionParams) : Definition
{
    let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
    if (asmodule == null)
        return null;

    let pos = asmodule.getOffset(params.position);
    if (pos < 0)
        return null;

    // Find the end of the identifier
    while (true)
    {
        let char = asmodule.content[pos];
        if (!/[A-Za-z0-9_]/.test(char))
            break;
        pos += 1;
        if(pos >= asmodule.content.length)
            break;
    }

    pos -= 1;
    if(pos < 0)
        return null;

    let [term, scope] = ExtractCompletingTermAt(pos, params.textDocument.uri);

    let checkTypes : Array<typedb.DBType>;

    let curtype = GetTypeFromTerm(term, 0, term.length - 1, scope);
    if (curtype)
        checkTypes = [curtype];
    else if (curtype == null && term.length == 1)
        checkTypes = GetGlobalScopeTypes(scope, true);
    else
        return null;

    ExpandCheckedTypes(checkTypes);

    let locations : Array<Location> = [];

    for (let type of checkTypes)
    {
        if (type.declaredModule)
        {
            let loc = scriptfiles.GetSymbolLocation(type.declaredModule, type.typename, term[term.length-1].name);
            if (loc)
                locations.push(loc);
        }
        else
        {
            // Namespaces don't always have a declared module, if they are merged from multiple files
            // Find the symbol first and then check the declared module on the symbol
            let method = type.getMethod(term[term.length-1].name);
            if (method)
            {
                if (method.declaredModule)
                {
                    let loc = scriptfiles.GetSymbolLocation(method.declaredModule, type.typename, term[term.length-1].name);
                    if (loc)
                        locations.push(loc);
                }
            }
            else
            {
                let prop = type.getProperty(term[term.length-1].name);
                if (prop)
                {
                    if (prop.declaredModule)
                    {
                        let loc = scriptfiles.GetSymbolLocation(prop.declaredModule, type.typename, term[term.length-1].name);
                        if (loc)
                            locations.push(loc);
                    }
                }
            }
        }
    }

    if (term.length == 1 && scope)
    {
        // We could be trying to go to something declared as a variable right inside the scope we're in
        let loc = scriptfiles.GetSymbolLocationInScope(scope, term[0].name);
        if (loc)
            locations.push(loc);

        // We could be trying to go to a type, rather than a variable or function
        let dbtype = typedb.GetType(term[0].name);
        if(!dbtype)
            dbtype = typedb.GetType("__"+term[0].name);
        if (!dbtype && term[0].name == "Super")
        {
            let scopetype = scope.getParentType();
            if (scopetype)
                dbtype = typedb.GetType(scopetype.supertype);
        }

        if (dbtype && dbtype.declaredModule)
        {
            let loc = scriptfiles.GetTypeSymbolLocation(dbtype.declaredModule, dbtype.typename);
            if (loc)
                locations.push(loc);
        }

        // We could be trying to get a global symbol for any of the many global scopes
        if (locations.length == 0)
        {
            for(let [typename, dbtype] of typedb.database)
            {
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

    if (term.length >= 1 && scope)
    {
        // We could be trying to get a ucs called global function that's in-scope
        let ucsScopes = GetGlobalScopeTypes(scope, false, false);
        for (let globaltype of ucsScopes)
        {
            let func = globaltype.getMethod(term[term.length-1].name);
            if(!func)
                continue;

            let loc = scriptfiles.GetSymbolLocation(func.declaredModule, null, func.name);
            if (loc)
                locations.push(loc);
        }

        // We could by trying to get a ucs called global function in any global scope
        if (locations.length == 0)
        {
            for(let [typename, dbtype] of typedb.database)
            {
                if (!typename.startsWith("//"))
                    continue;
                if (!dbtype.declaredModule)
                    continue;

                let loc = scriptfiles.GetSymbolLocation(dbtype.declaredModule, null, term[term.length-1].name);
                if (loc)
                    locations.push(loc);
            }
        }
    }

    if (locations && locations.length != 0)
        return locations;
    return null;
}

let re_literal_float = /^-?[0-9]+\.[0-9]*f$/;
let re_literal_int = /^-?[0-9]+$/;

export function ResolveAutos(root : scriptfiles.ASScope)
{
    /*for (let vardesc of root.variables)
    {
        if (vardesc.typename.indexOf("auto") == -1)
            continue;
        if (!vardesc.expression)
            continue;

        let originalType = vardesc.typename;
        let cleanedType = typedb.CleanTypeName(vardesc.typename);
        if (cleanedType != "auto")
            continue;

        let terms = ParseTerms(vardesc.expression);
        let isAutoRef = vardesc.typename.endsWith("&");
        let resolvedType = GetTypeFromTerm(terms, 0, terms.length, root, true);
        if(resolvedType)
            vardesc.typename = resolvedType.typename;

        // Parse basic literal types
        if (!resolvedType)
        {
            if (terms.length == 1)
            {
                let literalExpr = terms[0].name.trim();
                if (literalExpr.endsWith("\""))
                {
                    if (literalExpr.startsWith("\""))
                    {
                        vardesc.typename = "FString";
                    }
                    else if (literalExpr.startsWith("n\""))
                    {
                        vardesc.typename = "FName";
                    }
                }
                else if (re_literal_int.test(literalExpr))
                {
                    vardesc.typename = "int";
                }
            }
            else if (terms.length == 3)
            {
                if (terms[1].type == ASTermType.PropertyAccess)
                {
                    if (re_literal_float.test(terms[0].name + "." + terms[2].name))
                    {
                        vardesc.typename = "float";
                    }
                }
            }
        }

        vardesc.typename = typedb.TransferTypeQualifiers(originalType, vardesc.typename);
    }

    for (let subscope of root.subscopes)
    {
        ResolveAutos(subscope);
    }*/
}

function GetActiveParameterCount(pos : number, uri : string) : number
{
    let asmodule = scriptfiles.GetModuleByUri(uri);
    if (asmodule == null)
        return null;

    let paramCount = 0;

    let termstart = pos;
    let brackets = 0;
    while (termstart > 0)
    {
        let char = asmodule.content[termstart];
        let end = false;

        switch(char)
        {
            case ';':
            case '{':
            case '}':
                end = true; break;

            case '(':
                if(brackets > 0)
                    brackets -= 1;
                else end = true;
            break;

            case ')':
                brackets += 1;
            break;

            case ',':
                if (brackets == 0)
                    paramCount += 1;
            break;
        }

        if(end)
            break;
        termstart -= 1;
    }

    return paramCount;
}
