import {
    CompletionItem, CompletionItemKind, Position, MarkupContent, MarkupKind,
    SignatureHelp, SignatureInformation, ParameterInformation, Range, TextEdit
} from 'vscode-languageserver/node';
import * as typedb from './database';
import * as scriptfiles from './as_parser';
import * as specifiers from './specifiers';

let CommonTypenames = new Set<string>([
    "FVector", "FRotator", "FTransform", "FQuat"
]);
let CommonTemplateTypes = new Set<string>(
    ['TArray', 'TMap', 'TSet', 'TSubclassOf', 'TSoftObjectPtr', 'TSoftClassPtr', 'TInstigated', 'TPerPlayer'],
);

class CompletionContext
{
    scope : scriptfiles.ASScope = null;
    statement : scriptfiles.ASStatement = null;
    baseStatement : scriptfiles.ASStatement = null;

    completingSymbol : string = null;
    completingNode : any = null;
    priorExpression : any = null;
    priorType : typedb.DBType = null;

    isRightExpression : boolean = false;
    isSubExpression : boolean = false;
    isNamingVariable : boolean = false;
    isIgnoredCode : boolean = false;
    isIncompleteNamespace : boolean = false;
    isFunctionDeclaration : boolean = false;
    isInsideType : boolean = false;
    maybeTypename : boolean = false;

    subOuterStatement : scriptfiles.ASStatement = null;
    subOuterFunctions : Array<typedb.DBMethod> = null;
    subOuterArgumentIndex : number = -1;
    fullOuterStatement : scriptfiles.ASStatement = null;
}

class CompletionExpressionCandidate
{
    start : number = -1;
    end : number = -1;
    code : string = null;
    isRightExpression : boolean = false;
};

class CompletionArguments
{
    isAfterNamedArgument : boolean = false;
    currentArgumentName : string = null;
    usedArgumentNames : Array<string> = [];
};

export function Complete(asmodule : scriptfiles.ASModule, position : Position) : Array<CompletionItem>
{
    if (!asmodule)
        return null;
    let completions = new Array<CompletionItem>();

    let offset = asmodule.getOffset(position);
    let context = GenerateCompletionContext(asmodule, offset-1);

    // No completions when in ignored code (comments, strings, etc)
    if (context.isIgnoredCode)
        return [];

    // No completions at all when we are typing the name in a variable declaration
    if (context.isNamingVariable)
        return [];

    // Add completions from import statements
    if (AddCompletionsFromImportStatement(context, completions))
        return completions;

    // Add completions from unreal macro specifiers
    if (AddCompletionsFromUnrealMacro(context, completions))
        return completions;

    if (context.completingSymbol == null)
        return null;

    let searchTypes = new Array<typedb.DBType>();
    let insideType = context.scope ? context.scope.getParentType() : null;

    if (context.priorType)
    {
        // Complete from the type of the expression before us
        searchTypes.push(context.priorType);
    }
    else if (context.scope)
    {
        // Complete from the class we're in
        if (insideType)
            searchTypes.push(insideType);

        // Complete from global types available here
        searchTypes = searchTypes.concat(context.scope.getAvailableGlobalTypes());

        // Complete from local variables and parameters
        let checkscope = context.scope;
        while (checkscope)
        {
            if (!checkscope.isInFunctionBody())
                break;
            AddCompletionsFromLocalVariables(context, checkscope, completions);
            checkscope = checkscope.parentscope;
        }

        // Add 'this' and 'Super' if in a class
        if (insideType)
            AddCompletionsFromClassKeywords(context, completions);
    }

    // Search for completions in all global and real types we are looking in
    for (let dbtype of searchTypes)
    {
        let showEvents = !context.scope || context.scope.scopetype != scriptfiles.ASScopeType.Class || !insideType || dbtype.typename != dbtype.typename;
        AddCompletionsFromType(context, dbtype, completions, showEvents);
    }

    // Add completions for global functions we haven't imported
    if (!context.isInsideType)
        AddUnimportedCompletions(context, completions);
    
    // Add completions for mixin calls to global functions
    if (context.priorType)
        AddMixinCompletions(context, completions);

    // Complete typenames if we're in a context where that is possible
    if (!context.isInsideType && !context.isIncompleteNamespace)
        AddTypenameCompletions(context, completions);

    // Complete keywords if appropriate
    if (!context.isInsideType)
        AddCompletionsFromKeywords(context, completions);

    // Check if we're inside a function call and complete argument names
    if (context.isSubExpression && context.subOuterFunctions && !context.isInsideType)
        AddCompletionsFromCallSignature(context, completions);

    // Check for snippet completions for method overrides
    if (context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class
            && !context.isRightExpression && !context.isSubExpression && !context.isInsideType)
    {
        AddMethodOverrideSnippets(context, completions, position);
    }

    // Add snippet completion for super call if we can
    AddSuperCallSnippet(context, completions);

    return completions;
}

function GenerateCompletionArguments(context : CompletionContext) : CompletionArguments
{
    let args = new CompletionArguments();
    if (context.fullOuterStatement && context.fullOuterStatement.ast)
    {
        if (context.fullOuterStatement.ast.type == scriptfiles.node_types.FunctionCall
            || context.fullOuterStatement.ast.type == scriptfiles.node_types.ConstructorCall)
        {
            let arglist = context.fullOuterStatement.ast.children[1];
            if (arglist && arglist.children)
            {
                for (let i = 0; i < arglist.children.length; ++i)
                {
                    let argnode = arglist.children[i];
                    if (argnode && argnode.type == scriptfiles.node_types.NamedArgument)
                    {
                        if (argnode.children[0])
                            args.usedArgumentNames.push(argnode.children[0].value);
                        if (i <= context.subOuterArgumentIndex)
                            args.isAfterNamedArgument = true;
                        if (i == context.subOuterArgumentIndex && argnode.children[0])
                            args.currentArgumentName = argnode.children[0].value;
                    }
                }
            }
        }
    }
    return args;
}

function ScoreMethodForArguments(context : CompletionContext, argContext : CompletionArguments, func : typedb.DBMethod) : [number, number]
{
    let score = 0;

    // Check if we've passed too many arguments
    if (context.subOuterArgumentIndex >= func.args.length)
    {
        if(context.subOuterArgumentIndex > 0 || (context.statement.content && context.statement.content.length > 0))
            score -= 50;
    }

    // Check if all named arguments we're using are matched
    let activeArg = -1;
    for (let usedName of argContext.usedArgumentNames)
    {
        let foundArg = -1;
        for (let argIndex = 0; argIndex < func.args.length; ++argIndex)
        {
            if (func.args[argIndex].name == usedName)
            {
                foundArg = argIndex;
                break;
            }
        }

        if (foundArg == -1)
        {
            if (argContext.currentArgumentName && usedName == argContext.currentArgumentName)
                score -= 100;
            else
                score -= 10;
        }
        else
        {
            if (argContext.currentArgumentName && usedName == argContext.currentArgumentName)
                activeArg = foundArg;
        }
    }

    return [score, activeArg];
}

export function Signature(asmodule : scriptfiles.ASModule, position : Position) : SignatureHelp
{
    if (!asmodule)
        return null;

    let completions = new Array<CompletionItem>();

    let offset = asmodule.getOffset(position);
    let context = GenerateCompletionContext(asmodule, offset-1);

    if (!context.subOuterFunctions)
        return null;
    if (context.subOuterFunctions.length == 0)
        return null;

    let argContext = GenerateCompletionArguments(context);

    let sigHelp = <SignatureHelp> {
        signatures : new Array<SignatureInformation>(),
        activeSignature : 0,
        activeParameter : 0,
    };

    let bestFunction = -1;
    let bestFunctionScore = 0;
    let bestFunctionActiveArg = -1;
    for (let i = 0; i < context.subOuterFunctions.length; ++i)
    {
        let func = context.subOuterFunctions[i];

        // Keep track of the best function
        let [score, activeArg] = ScoreMethodForArguments(context, argContext, func);
        if (score > bestFunctionScore || bestFunction == -1)
        {
            bestFunctionScore = score;
            bestFunction = i;

            if (argContext.currentArgumentName && activeArg != -1)
                bestFunctionActiveArg = activeArg;
            else if (argContext.isAfterNamedArgument)
                bestFunctionActiveArg = -1;
            else
                bestFunctionActiveArg = context.subOuterArgumentIndex;
        }
        
        let skipFirstArg = false;
        if (func.containingType && func.containingType.isNamespaceOrGlobalScope() && func.isMixin)
            skipFirstArg = true;

        let params = new Array<ParameterInformation>();
        if (func.args)
        {
            for (let a = skipFirstArg ? 1 : 0; a < func.args.length; ++a)
            {
                params.push(<ParameterInformation>
                {
                    label: func.args[a].format()
                });
            }
        }

        let sig = <SignatureInformation> {
            label: func.format(null, skipFirstArg),
            parameters: params,
        };

        let doc = func.findAvailableDocumentation(true, false);
        if (doc)
            sig.documentation = doc;

        sigHelp.signatures.push(sig);
    }

    if (bestFunction != -1)
    {
        sigHelp.activeSignature = bestFunction;
        sigHelp.activeParameter = bestFunctionActiveArg;
    }
    return sigHelp.signatures.length == 0 ? null : sigHelp;
}

function AddCompletionsFromCallSignature(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (context.subOuterFunctions.length == 0)
        return;

    let argContext = GenerateCompletionArguments(context);

    // Find the best function to complete with
    let activeMethod : typedb.DBMethod = null;
    let bestScore = 0;
    for (let func of context.subOuterFunctions)
    {
        let [score, activeArg] = ScoreMethodForArguments(context, argContext, func);
        if (score > bestScore || !activeMethod)
        {
            activeMethod = func;
            bestScore = score;
        }
    }

    if (activeMethod.args)
    {
        let completeDefinition = false;
        if (context.scope && activeMethod.containingType && context.isFunctionDeclaration)
        {
            let typeOfScope = context.scope ? context.scope.getParentType() : null;
            if (typeOfScope != null && typeOfScope.canOverrideFromParent(activeMethod.name))
            {
                completeDefinition = true;

                let supertype = typedb.GetType(typeOfScope.supertype);
                if (supertype)
                {
                    let supersymbol = supertype.findFirstSymbol(activeMethod.name, typedb.DBAllowSymbol.FunctionOnly);
                    if (supersymbol instanceof typedb.DBMethod)
                        activeMethod = supersymbol;
                }
            }
        }

        if (completeDefinition)
        {
            if (context.subOuterArgumentIndex < activeMethod.args.length)
            {
                let arg = activeMethod.args[context.subOuterArgumentIndex];
                let complStr = arg.typename+" "+arg.name;
                if (CanCompleteTo(context.completingSymbol, complStr))
                {
                    completions.push({
                        label: complStr,
                        documentation: <MarkupContent> {
                            kind: MarkupKind.Markdown,
                            value: "```angelscript_snippet\n"+complStr+"\n\n```"
                        },
                        kind: CompletionItemKind.Snippet
                    });
                }
            }
        }
        else
        {
            for (let arg of activeMethod.args)
            {
                // Skip named arguments we've already seen
                if (argContext.usedArgumentNames.indexOf(arg.name) != -1)
                    continue;

                let complStr = arg.name+" = ";
                if (CanCompleteTo(context.completingSymbol, complStr))
                {
                    completions.push({
                        label: complStr,
                        documentation: <MarkupContent> {
                            kind: MarkupKind.Markdown,
                            value: "```angelscript_snippet\n"+complStr+"\n\n```"
                        },
                        kind: CompletionItemKind.Snippet
                    });
                }
            }
        }
    }
}

function AddCompletionsFromKeywordList(context : CompletionContext, keywords : Array<string>, completions : Array<CompletionItem>)
{
    for(let kw of keywords)
    {
        if (CanCompleteTo(context.completingSymbol, kw))
        {
            completions.push({
                    label: kw,
                    kind: CompletionItemKind.Keyword
            });
        }
    }
}

function AddCompletionsFromSpecifiers(context : CompletionContext, specifiers : any, completions : Array<CompletionItem>)
{
    for(let spec in specifiers)
    {
        if (!context.completingSymbol || CanCompleteTo(context.completingSymbol, spec))
        {
            completions.push({
                    label: spec,
                    documentation: specifiers[spec],
                    kind: CompletionItemKind.Keyword
            });
        }
    }
}

function AddCompletionsFromImportStatement(context : CompletionContext, completions : Array<CompletionItem>) : boolean
{
    if (context.statement && context.statement.ast && context.statement.ast.type == scriptfiles.node_types.ImportStatement)
    {
        let complString = "";
        if(context.completingSymbol)
            complString = context.completingSymbol;
        
        let untilDot = "";
        let dotPos = complString.lastIndexOf(".");
        if (dotPos != -1)
            untilDot = complString.substr(0, dotPos+1);

        for (let asmodule of scriptfiles.GetAllLoadedModules())
        {
            if (CanCompleteTo(complString, asmodule.modulename))
            {
                completions.push({
                    label: asmodule.modulename,
                    kind: CompletionItemKind.File,
                    filterText: asmodule.modulename.substr(untilDot.length),
                    insertText: asmodule.modulename.substr(untilDot.length),
                });
            }
        }
        return true;
    }

    return false;
}

function AddCompletionsFromUnrealMacro(context : CompletionContext, completions : Array<CompletionItem>) : boolean
{
    if (context.isSubExpression)
    {
        if (/^\s*UCLASS\s*$/.test(context.subOuterStatement.content))
        {
            AddCompletionsFromSpecifiers(context, specifiers.ASClassSpecifiers, completions);
            return true;
        }

        if (/^\s*USTRUCT\s*$/.test(context.subOuterStatement.content))
        {
            AddCompletionsFromSpecifiers(context, specifiers.ASStructSpecifiers, completions);
            return true;
        }

        if (/^\s*UPROPERTY\s*$/.test(context.subOuterStatement.content))
        {
            AddCompletionsFromSpecifiers(context, specifiers.ASPropertySpecifiers, completions);
            return true;
        }

        if (/^\s*UFUNCTION\s*$/.test(context.subOuterStatement.content))
        {
            AddCompletionsFromSpecifiers(context, specifiers.ASFunctionSpecifiers, completions);
            return true;
        }
    }

    return false;
}

function AddCompletionsFromKeywords(context : CompletionContext, completions : Array<CompletionItem>)
{
    let inFunctionBody = !context.scope || context.scope.isInFunctionBody();

    AddCompletionsFromKeywordList(context, [
        "float", "bool", "int", "double",
    ], completions);

    if (context.isRightExpression || context.isSubExpression)
    {
        AddCompletionsFromKeywordList(context, [
            "nullptr", "true", "false",
        ], completions);
    }
    
    if (!context.isRightExpression && !context.isSubExpression)
    {
        AddCompletionsFromKeywordList(context, [
            "const", "case", "default",
        ], completions);
    }

    if ((!context.scope || context.scope.scopetype == scriptfiles.ASScopeType.Global || context.scope.scopetype == scriptfiles.ASScopeType.Namespace)
        && (!context.isSubExpression && !context.isRightExpression))
    {
        AddCompletionsFromKeywordList(context, [
            "delegate", "event", "class", "struct",
            "property"
        ], completions);

        if (CanCompleteTo(context.completingSymbol, "UCLASS"))
        {
            completions.push({
                    label: "UCLASS",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: ["("],
            });
        }

        if (CanCompleteTo(context.completingSymbol, "USTRUCT"))
        {
            completions.push({
                    label: "USTRUCT",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: ["("],
            });
        }
    }

    if (context.scope && inFunctionBody)
    {
        if (!context.isRightExpression && !context.isSubExpression)
        {
            AddCompletionsFromKeywordList(context, [
                "if", "else", "while", "for",
            ], completions);

            completions.push({
                    label: "return",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: [" ", ";"],
            });
        }
    }
    else
    {
        if (!context.isRightExpression && !context.isSubExpression)
        {
            AddCompletionsFromKeywordList(context, [
                "void",
            ], completions);
        }
    }

    if ((context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class)
        || (context.baseStatement && context.baseStatement.ast && context.baseStatement.ast.type == scriptfiles.node_types.FunctionDecl && context.scope.getParentType()))
    {
        if (!context.isRightExpression && !context.isSubExpression)
        {
            AddCompletionsFromKeywordList(context, [
                "override", "final", "property", "private", "protected",
            ], completions);

            if (CanCompleteTo(context.completingSymbol, "UPROPERTY"))
            {
                completions.push({
                        label: "UPROPERTY",
                        kind: CompletionItemKind.Keyword,
                        commitCharacters: ["("],
                });
            }
        }

        let scopeType = context.scope.getParentType();
        if (scopeType && !scopeType.isStruct)
        {
            if (!context.isRightExpression && !context.isSubExpression)
            {
                if (CanCompleteTo(context.completingSymbol, "UFUNCTION"))
                {
                    completions.push({
                            label: "UFUNCTION",
                            kind: CompletionItemKind.Keyword,
                            commitCharacters: ["("],
                    });
                }
            }
        }
    }
    else if((context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Global || context.scope.scopetype == scriptfiles.ASScopeType.Namespace)
        || (context.baseStatement && context.baseStatement.ast && context.baseStatement.ast.type == scriptfiles.node_types.FunctionDecl && !context.scope.getParentType()))
    {
        if (!context.isRightExpression && !context.isSubExpression)
        {
            AddCompletionsFromKeywordList(context, [
                "mixin", "property",
            ], completions)

            if (CanCompleteTo(context.completingSymbol, "UFUNCTION"))
            {
                completions.push({
                        label: "UFUNCTION",
                        kind: CompletionItemKind.Keyword,
                        commitCharacters: ["("],
                });
            }
        }
    }

}

function GetTypenameCommitChars(context : CompletionContext, typename : string, commitChars : Array<string>)
{
    if (context.maybeTypename)
    {
        if (CommonTypenames.has(typename))
            commitChars.push(" ");
        if (CommonTemplateTypes.has(typename))
            commitChars.push("<");
    }
}

function AddTypenameCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    for (let [typename, dbtype] of typedb.GetAllTypes())
    {
        // Ignore template instantations for completion
        if (dbtype.isTemplateInstantiation)
            continue;

        let kind : CompletionItemKind = CompletionItemKind.Class;
        if (dbtype.isNamespace())
        {
            typename = dbtype.rawName;
            kind = CompletionItemKind.Module;

            if (!context.isSubExpression && !context.isRightExpression)
            {
                if (dbtype.isShadowedNamespace())
                    continue;
            }
        }
        else
        {
            if (context.isSubExpression || context.isRightExpression)
                continue;
        }

        if (typename.startsWith("//"))
            continue;

        if (dbtype.isEnum)
        {
            if (CanCompleteSymbol(context, dbtype))
            {
                // Allow completing to qualified enum values when appropriate
                if ((context.isSubExpression && !context.isFunctionDeclaration) || context.isRightExpression)
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
                        commitCharacters: [":"],
                        filterText: GetSymbolFilterText(context, dbtype),
                });
            }
        }
        else
        {
            if (CanCompleteSymbol(context, dbtype))
            {
                let commitChars = [":"];
                GetTypenameCommitChars(context, typename, commitChars);

                completions.push({
                        label: typename,
                        kind: kind,
                        data: ["type", dbtype.typename],
                        commitCharacters: commitChars,
                        filterText: GetSymbolFilterText(context, dbtype),
                });
            }
        }
    }
}

export function AddCompletionsFromClassKeywords(context : CompletionContext, completions : Array<CompletionItem>)
{
    let insideType = context.scope.getParentType();
    if (!insideType)
        return;
    if (CanCompleteTo(context.completingSymbol, "this"))
    {
        completions.push({
                label: "this",
                detail: insideType.typename,
                kind : CompletionItemKind.Keyword,
                commitCharacters: [".", ";", ","],
        });
    }

    if (context.scope.isInFunctionBody() && CanCompleteTo(context.completingSymbol, "Super"))
    {
        let supertype = typedb.GetType(insideType.supertype);
        // Don't complete to Super if it is a C++ class, that doesn't work
        if (supertype && supertype.declaredModule)
        {
            completions.push({
                    label: "Super",
                    detail: insideType.supertype,
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: [":"],
            });
        }
    }
}

export function AddCompletionsFromLocalVariables(context : CompletionContext, scope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    for (let asvar of scope.variables)
    {
        if (CanCompleteTo(context.completingSymbol, asvar.name))
        {
            completions.push({
                label: asvar.name,
                detail: asvar.typename,
                kind : CompletionItemKind.Variable,
                commitCharacters: [".", ";", ","],
            });
        }
    }
}

export function AddCompletionsFromType(context : CompletionContext, curtype : typedb.DBType, completions : Array<CompletionItem>, showEvents : boolean = true)
{
    let props = new Set<string>();
    for (let prop of curtype.allProperties())
    {
        if (CanCompleteSymbol(context, prop))
        {
            if (!isPropertyAccessibleFromScope(curtype, prop, context.scope))
                continue;
            props.add(prop.name);
            let compl = <CompletionItem>{
                    label: prop.name,
                    kind : CompletionItemKind.Field,
                    detail: prop.typename,
                    data: ["prop", curtype.typename, prop.name],
                    commitCharacters: [".", ";", ","],
                    filterText: GetSymbolFilterText(context, prop),
            };

            if (context.isIncompleteNamespace)
                compl.insertText = ":"+compl.label;
            completions.push(compl);
        }
    }

    let getterStr = "Get"+context.completingSymbol;
    let setterStr = "Set"+context.completingSymbol;
    for (let func of curtype.allMethods())
    {
        if (func.isMixin)
            continue;
        if (!CanCompleteSymbol(context, func))
            continue;
        if (!isFunctionAccessibleFromScope(curtype, func, context.scope))
            continue;

        // Don't show constructors if we're probably completing the name of a type
        if (func.isConstructor && context.maybeTypename)
            continue;

        if (func.isProperty)
        {
            if (func.name.startsWith("Get"))
            {
                let propname = func.name.substr(3);
                if(!props.has(propname) && func.args.length == 0)
                {
                    let compl = <CompletionItem>{
                            label: propname,
                            kind: CompletionItemKind.Field,
                            detail: func.returnType,
                            data: ["accessor", curtype.typename, propname],
                            commitCharacters: [".", ";", ","],
                            filterText: GetSymbolFilterText(context, func),
                    };

                    if (context.isIncompleteNamespace)
                        compl.insertText = ":"+compl.label;
                    completions.push(compl);
                    props.add(propname);
                }
            }
            
            if (func.name.startsWith("Set"))
            {
                let propname = func.name.substr(3);
                if(!props.has(propname) && func.args.length == 1 && func.returnType == "void")
                {
                    let compl = <CompletionItem>{
                            label: propname,
                            kind: CompletionItemKind.Field,
                            detail: func.args[0].typename,
                            data: ["accessor", curtype.typename, propname],
                            commitCharacters: [".", ";", ","],
                            filterText: GetSymbolFilterText(context, func),
                    };

                    if (context.isIncompleteNamespace)
                        compl.insertText = ":"+compl.label;
                    completions.push(compl);
                    props.add(propname);
                }
            }

            // If it's explicitly declared with 'property' in script we don't complete
            // to the function call version. We still do for C++ ones because property
            // is implicit there.
            //if (func.declaredModule)
                //continue;
        }

        if(!func.name.startsWith("op") && (!func.isEvent || showEvents))
        {
            let commitChars = ["("];
            if (func.isConstructor)
                GetTypenameCommitChars(context, func.name, commitChars);

            let compl = <CompletionItem>{
                    label: func.name,
                    kind: func.isEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                    data: ["func", curtype.typename, func.name, func.id],
                    commitCharacters: commitChars,
                    filterText: GetSymbolFilterText(context, func),
            };

            if (context.isIncompleteNamespace)
                compl.insertText = ":"+compl.label;
            completions.push(compl);
        }
    }
}

export function AddUnimportedCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (!context.scope)
        return;

    // Not yet imported global symbols
    for (let [name, globalSymbols] of typedb.ScriptGlobals)
    {
        for (let sym of globalSymbols)
        {
            if (!sym.containingType)
                continue;
            if (sym instanceof typedb.DBProperty)
            {
                if (context.scope.module.isModuleImported(sym.declaredModule))
                    continue;
                if (!CanCompleteSymbol(context, sym))
                    continue;

                let compl = <CompletionItem>{
                    label: sym.name,
                    kind : CompletionItemKind.Field,
                    detail: sym.typename,
                    data: ["prop", sym.containingType.typename, sym.name],
                    commitCharacters: [".", ";", ","],
                    filterText: GetSymbolFilterText(context, sym),
                };
                completions.push(compl);
            }
            else if (sym instanceof typedb.DBMethod)
            {
                if (sym.isMixin)
                    continue;
                if (context.scope.module.isModuleImported(sym.declaredModule))
                    continue;
                if (!CanCompleteSymbol(context, sym))
                    continue;

                let compl = <CompletionItem>{
                    label: sym.name,
                    kind: sym.isEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                    data: ["func", sym.containingType.typename, sym.name, sym.id],
                    commitCharacters: ["("],
                    filterText: GetSymbolFilterText(context, sym),
                };
                completions.push(compl);
            }
        }
    }
}

export function AddMixinCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (!context.scope)
        return;

    // Not yet imported mixin functions
    for (let [name, globalSymbols] of typedb.ScriptGlobals)
    {
        for (let sym of globalSymbols)
        {
            if (!sym.containingType)
                continue;
            if (sym instanceof typedb.DBMethod)
            {
                if (!sym.isMixin)
                    continue;
                if (!CanCompleteSymbol(context, sym))
                    continue;
                if (sym.args && sym.args.length != 0 && context.priorType.inheritsFrom(sym.args[0].typename))
                {
                    let compl = <CompletionItem>{
                        label: sym.name,
                        kind: sym.isEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                        data: ["func_mixin", sym.containingType.typename, sym.name, sym.id],
                        commitCharacters: ["("],
                        filterText: GetSymbolFilterText(context, sym),
                    };
                    completions.push(compl);
                }
            }
        }
    }
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

function CanCompleteSymbol(context : CompletionContext, symbol : typedb.DBSymbol | typedb.DBType) : boolean
{
    if (symbol instanceof typedb.DBType)
    {
        if (symbol.keywords)
            return CanCompleteTo(context.completingSymbol, GetSymbolFilterText(context, symbol));
        return CanCompleteTo(context.completingSymbol, symbol.typename);
    }
    else
    {
        if (symbol.keywords)
            return CanCompleteTo(context.completingSymbol, GetSymbolFilterText(context, symbol));
        return CanCompleteTo(context.completingSymbol, symbol.name);
    }
}

function GetSymbolFilterText(context : CompletionContext, symbol : typedb.DBSymbol | typedb.DBType) : string | undefined
{
    if (symbol instanceof typedb.DBType)
    {
        if (!symbol.keywords)
            return undefined;
        return [symbol.typename, ...symbol.keywords].join(" ");
    }
    else
    {
        if (!symbol.keywords)
            return undefined;
        return [symbol.name, ...symbol.keywords].join(" ");
    }
}

function GenerateCompletionContext(asmodule : scriptfiles.ASModule, offset : number) : CompletionContext
{
    let context = new CompletionContext();

    let contentOffset = 0;
    context.baseStatement = asmodule.getStatementAt(offset);
    let content : string = null;

    if (context.baseStatement)
    {
        content = context.baseStatement.content;
        contentOffset = context.baseStatement.start_offset;

        if (context.baseStatement.ast)
        {
            switch (context.baseStatement.ast.type)
            {
                case scriptfiles.node_types.FunctionDecl:
                case scriptfiles.node_types.EventDecl:
                case scriptfiles.node_types.DelegateDecl:
                case scriptfiles.node_types.ConstructorDecl:
                case scriptfiles.node_types.DestructorDecl:
                    context.isFunctionDeclaration = true;
                break;
            }
        }
    }
    else
    {
        content = asmodule.content;
        contentOffset = 0;
    }

    let ignoreTable : Array<number> = GetCodeOffsetIgnoreTable(content);

    // Check if the character we're completing is part of the ignore
    let offsetInTable = offset - contentOffset;
    for (let i = 0; i < ignoreTable.length; i += 2)
    {
        if (offsetInTable >= ignoreTable[i] && offsetInTable < ignoreTable[i+1])
        {
            context.isIgnoredCode = true;
            break;
        }
    }

    let candidates = ExtractExpressionPreceding(content, offset-contentOffset, ignoreTable);
    context.scope = asmodule.getScopeAt(offset);

    // Try to parse each candidate in the scope
    //  In reverse order, we prefer the longest candidate
    context.statement = new scriptfiles.ASStatement();
    for (let i = candidates.length-1; i >= 0; --i)
    {
        let candidate = candidates[i];
        context.statement.content = candidate.code;
        context.isRightExpression = candidate.isRightExpression;
        context.statement.ast = null;

        // Try to parse as a proper statement in the scope
        scriptfiles.ParseStatement(context.scope.scopetype, context.statement);

        // We might want to try to parse this as a global statement if we're in a declaration
        if (!context.statement.ast)
        {
            if (context.baseStatement && context.scope.declaration == context.baseStatement)
                scriptfiles.ParseStatement(context.scope.parentscope.scopetype, context.statement);
        }

        // Try to parse as an expression snippet instead
        if (!context.statement.ast)
            scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.statement);

        if (!context.statement.ast)
            continue;

        // If we managed to parse a statement, extract the prior expression from it
        let haveTerm = ExtractPriorExpressionAndSymbol(context, context.statement.ast);
        if (haveTerm)
            break;
        else
            context.statement.ast = null;
    }

    // We haven't been able to parse it to a valid term, but try an invalid term as well
    if (!context.statement.ast)
    {
        for (let i = candidates.length-1; i >= 0; --i)
        {
            let candidate = candidates[i];
            context.statement.content = candidate.code;
            context.statement.end_offset = offset + 1;
            context.statement.start_offset = offset + 1 - candidate.code.length;
            context.isRightExpression = candidate.isRightExpression;
            context.statement.ast = null;

            // Try to parse as a proper statement in the scope
            scriptfiles.ParseStatement(context.scope.scopetype, context.statement);

            // Try to parse as an expression snippet instead
            if (!context.statement.ast)
                scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.statement);

            if (!context.statement.ast)
                continue;

            // If we managed to parse a statement, extract the prior expression from it
            ExtractPriorExpressionAndSymbol(context, context.statement.ast);
            break;
        }
    }

    // Also find the function call we are a subexpression of
    let [subExprOffset, argumentIndex] = ScanOffsetStartOfOuterExpression(content, offset-contentOffset, ignoreTable);
    if (subExprOffset != -1)
    {
        context.isSubExpression = true;
        context.subOuterStatement = new scriptfiles.ASStatement();
        context.subOuterArgumentIndex = argumentIndex;

        let subCandidates = ExtractExpressionPreceding(content, subExprOffset, ignoreTable);
        for (let i = subCandidates.length-1; i >= 0; --i)
        {
            let candidate = subCandidates[i];
            context.subOuterStatement.content = candidate.code;
            context.subOuterStatement.ast = null;
            context.subOuterStatement.end_offset = subExprOffset + 1 + contentOffset;
            context.subOuterStatement.start_offset = context.subOuterStatement.end_offset - candidate.code.length;

            // Try to parse as a proper statement in the scope
            scriptfiles.ParseStatement(context.scope.scopetype, context.subOuterStatement);

            // Try to parse as an expression snippet instead
            if (!context.subOuterStatement.ast)
                scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.subOuterStatement);

            if (!context.subOuterStatement.ast)
                continue;

            // If we managed to parse a statement, extract the prior expression from it
            context.subOuterFunctions = new Array<typedb.DBMethod>();
            scriptfiles.ResolveFunctionOverloadsFromExpression(context.scope, context.subOuterStatement.ast, context.subOuterFunctions);
            if (context.subOuterFunctions.length != 0)
            {
                break;
            }
        }
    }

    // Try to parse the entire function statement we've found
    if (context.subOuterStatement && context.subOuterStatement.ast)
    {
        let subEndOffset = ScanOffsetEndOfOuterExpression(content, offset-contentOffset, ignoreTable);
        if (subEndOffset != -1)
        {
            let entireExpression = content.substring(
                context.subOuterStatement.start_offset - contentOffset,
                subEndOffset+1
            );

            context.fullOuterStatement = new scriptfiles.ASStatement();
            context.fullOuterStatement.content = entireExpression
            context.fullOuterStatement.ast = null;
            context.fullOuterStatement.end_offset = context.subOuterStatement.start_offset;
            context.fullOuterStatement.start_offset = subEndOffset + 1 + contentOffset;

            // Try to parse as a proper statement in the scope
            scriptfiles.ParseStatement(context.scope.scopetype, context.fullOuterStatement);

            // Try to parse as an expression snippet instead
            if (!context.fullOuterStatement.ast)
                scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.fullOuterStatement);
        }
    }

    // Record some data about the statement we parsed
    if (context.completingNode)
    {
        if (context.completingNode.type == scriptfiles.node_types.Typename)
            context.maybeTypename = true;
        if (context.isFunctionDeclaration && context.isSubExpression && context.completingNode == context.statement.ast)
            context.maybeTypename = true;
        if (context.completingNode == context.statement.ast && !context.isRightExpression && !context.isSubExpression && !context.isNamingVariable)
            context.maybeTypename = true;
    }

    // Check if we're completing in a type, maybe invalid
    if (context.priorType)
        context.isInsideType = true;
    else if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.MemberAccess)
        context.isInsideType = true;
    else if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.NamespaceAccess)
        context.isInsideType = true;
    return context;
}

function ExtractPriorExpressionAndSymbol(context : CompletionContext, node : any) : boolean
{
    if (!node)
        return false;

    switch (node.type)
    {
        case scriptfiles.node_types.Identifier:
        {
            context.priorExpression = null;
            context.completingSymbol = node.value;
            context.completingNode = node;
            context.priorType = null;
            return true;
        }
        break;
        case scriptfiles.node_types.MemberAccess:
        {
            context.priorExpression = node.children[0];
            if(node.children[1])
                context.completingSymbol = node.children[1].value;
            else
                context.completingSymbol = "";
            context.completingNode = node.children[1];
            context.priorType = scriptfiles.ResolveTypeFromExpression(context.scope, node.children[0]);
            if (context.priorType)
                return true;
            else
                return false;
        }
        break;
        case scriptfiles.node_types.NamespaceAccess:
        {
            if (!node.children[0].value)
                return false;
            context.priorExpression = node.children[0];
            if(node.children[1])
                context.completingSymbol = node.children[1].value;
            else
                context.completingSymbol = "";
            context.completingNode = node.children[1];
            if (node.children[0].value == "Super" && context.scope.getParentType())
                context.priorType = typedb.GetType(context.scope.getParentType().supertype);
            else
                context.priorType = typedb.GetType("__"+node.children[0].value);
            if (context.priorType)
            {
                if (node.incomplete_colon)
                    context.isIncompleteNamespace = true;
                return true;
            }
            else
            {
                return false;
            }
        }
        break;
        case scriptfiles.node_types.BinaryOperation:
            return ExtractPriorExpressionAndSymbol(context, node.children[1]);
        break;
        case scriptfiles.node_types.UnaryOperation:
        case scriptfiles.node_types.PostfixOperation:
        case scriptfiles.node_types.ElseStatement:
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.ReturnStatement:
        case scriptfiles.node_types.DefaultCaseStatement:
            context.isRightExpression = true;
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.CaseStatement:
            context.isRightExpression = true;
            if (node.children[1])
                return ExtractPriorExpressionAndSymbol(context, node.children[1]);
            else
                return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        break;
        case scriptfiles.node_types.VariableDecl:
        {
            if (node.typename)
            {
                let declType = typedb.GetType(node.typename.value);
                context.priorExpression = null;
                if (node.name)
                {
                    context.isNamingVariable = !!declType;
                    context.completingSymbol = node.name.value;
                    context.completingNode = node.name;
                }
                else
                {
                    context.completingSymbol = node.typename.value;
                    context.completingNode = node.typename;
                }
                context.priorType = null;
                return true;
            }
        }
        break;
        case scriptfiles.node_types.FunctionDecl:
        {
            context.isNamingVariable = true;
            context.priorExpression = null;
            if (node.name)
                context.completingSymbol = node.name.value;
            else
                context.completingSymbol = "";
            context.completingNode = node.name;
            context.priorType = null;
            return true;
        }
        break;
        case scriptfiles.node_types.ClassDefinition:
        {
            context.priorExpression = null;
            context.priorType = null;
            if (node.superclass)
            {
                context.maybeTypename = true;
                context.isRightExpression = false;
                context.completingNode = node.superclass;
                context.completingSymbol = node.superclass.value;
            }
            else
            {
                context.isNamingVariable = true;
                context.completingNode = node.name;
                if (node.name)
                    context.completingSymbol = node.name.value;
                else
                    context.completingSymbol = "";
            }
            return true;
        }
        break;
        case scriptfiles.node_types.StructDefinition:
        case scriptfiles.node_types.EnumDefinition:
        case scriptfiles.node_types.NamespaceDefinition:
        {
            context.priorExpression = null;
            context.priorType = null;
            context.isNamingVariable = true;
            context.completingNode = node.name;
            if (node.name)
                context.completingSymbol = node.name.value;
            else
                context.completingSymbol = "";
            return true;
        }
        break;
        case scriptfiles.node_types.ImportStatement:
        {
            context.priorExpression = null;
            context.priorType = null;
            context.isNamingVariable = false;
            if (node.children && node.children[0])
            {
                context.completingNode = node.children[0];
                context.completingSymbol = node.children[0].value;
            }
            return true;
        }
        break;
    }

    return false;
}

function ExtractExpressionPreceding(content : string, offset : number, ignoreTable : Array<number>) : Array<CompletionExpressionCandidate>
{
    let candidates : Array<CompletionExpressionCandidate> = [];
    let exprEndOffset = offset+1;
    let exprStartOffset = offset;
    let lastExprStartOffset = offset;

    function addCandidate(shiftCurrent : number = 0) : CompletionExpressionCandidate
    {
        let candidate : CompletionExpressionCandidate = null;
        if (exprStartOffset < lastExprStartOffset)
        {
            let code = content.substring(exprStartOffset+shiftCurrent, exprEndOffset);
            if (!IsCodeEmpty(code))
            {
                candidate = new CompletionExpressionCandidate();
                candidate.start = exprStartOffset;
                candidate.end = exprEndOffset;
                candidate.code = code;
                candidates.push(candidate);
            }
            lastExprStartOffset = exprStartOffset;
        }
        return candidate;
    }

    let depth_paren = 0;
    let depth_sqbracket = 0;
    let depth_anglebracket = 0;
    let expectingTerm = false;
    let haveFirstIdentifier = false;

    let ignoreTableIndex = ignoreTable ? ignoreTable.length-2 : -1;

    for (; exprStartOffset > 0; --exprStartOffset)
    {
        let char = content[exprStartOffset];
        let endParse = false;

        // Ignore characters that are in the ignore table completely
        while (ignoreTableIndex >= 0 && exprStartOffset < ignoreTable[ignoreTableIndex])
            ignoreTableIndex -= 2;
        if (ignoreTableIndex >= 0)
        {
            let ignoreStart = ignoreTable[ignoreTableIndex];
            let ignoreEnd = ignoreTable[ignoreTableIndex+1];
            if (exprStartOffset >= ignoreStart && exprStartOffset < ignoreEnd)
                continue;
        }

        // Once we have a term we are no longer expecting one
        let wasExpectingTerm = expectingTerm;
        if (expectingTerm && char != ' ' && char != '\t' && char != '\r' && char != '\n')
            expectingTerm = false;

        switch (char)
        {
            case ';':
            {
                // End expression, we found the previous statement
                let c = addCandidate(1);
                endParse = true;
            }
            break;
            case '(':
            {
                if (depth_sqbracket == 0)
                {
                    if (depth_paren == 0)
                    {
                        // Function(Blah.___)
                        //         ^
                        let c = addCandidate(1);
                        endParse = true;
                    }
                    else
                    {
                        depth_paren -= 1;
                        if (depth_paren == 0)
                            expectingTerm = true;
                    }
                }
            }
            break;
            case ')':
            {
                if (depth_sqbracket == 0)
                {
                    if (!wasExpectingTerm && depth_paren == 0)
                    {
                        let c = addCandidate(1);
                        endParse = true;
                    }
                    else
                    {
                        depth_paren += 1;
                    }
                }
            }
            break;
            case '[':
            {
                if (depth_paren == 0)
                {
                    if (depth_sqbracket == 0)
                    {
                        // Array[Blah.___]
                        //      ^
                        let c = addCandidate(1);
                        endParse = true;
                    }
                    else
                    {
                        depth_sqbracket -= 1;
                    }
                }
            }
            break;
            case ']':
            {
                if (depth_paren == 0)
                {
                    if (!wasExpectingTerm && depth_sqbracket == 0)
                    {
                        let c = addCandidate(1);
                        endParse = true;
                    }
                    else
                    {
                        depth_sqbracket += 1;
                        if (depth_sqbracket == 0)
                            expectingTerm = true;
                    }
                }
            }
            break;
            case '<':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    if (depth_anglebracket == 0)
                    {
                        // Var < Blah.___
                        //     ^
                        let c = addCandidate(1);
                        endParse = true;
                    }
                    else
                    {
                        depth_anglebracket -= 1;
                    }
                }
            }
            break;
            case '>':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    // Could be either a boolean operator,
                    // or the start of a template type
                    let c = addCandidate(1);
                    if (c)
                        c.isRightExpression = true;
                    depth_anglebracket += 1;
                }
            }
            break;
            case ',':
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    // Function(PrevArg, Blah.___)
                    //                 ^
                    let c = addCandidate(1);
                    endParse = true;
                }
            break;
            case '\n':
                // Add a candidate for splitting the expression at this linebreak,
                // but continue searching since the statement could still be going
                addCandidate(1);
            break;
            case ':':
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    // This could be the end of the expression (eg in a ternary or case)
                    // Or it could be a partial namespace lookup
                    let c = addCandidate(1);
                    if (c)
                        c.isRightExpression = true;
                    expectingTerm = true;
                }
            break;
            case '.':
                expectingTerm = true;
            break;
            case '{':
            case '}':
            {
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    // { Blah.___
                    // ^
                    let c = addCandidate(1);
                    endParse = true;
                }
            }
            break;
            case '?':
            case '/':
            case '+':
            case '-':
            case '=':
            case '*':
            case '@':
            case '!':
            case '&':
            case '|':
            case '^':
            {
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    // PrevTerm + Blah.___
                    //          ^
                    let c = addCandidate(1);
                    if (c)
                        c.isRightExpression = true;
                    endParse = true;
                }
            }
            break;
            case ' ':
            case '\t':
            {
                // Always add a candidate for the first full identifier we find
                if (!haveFirstIdentifier)
                {
                    haveFirstIdentifier = true;
                    let c = addCandidate(1);
                }
            }
            break;
        }

        if (endParse)
            break;
    }

    // If we hit the start boundary without making an expression add it now
    if (exprStartOffset < lastExprStartOffset)
        addCandidate(0);

    return candidates;
}

function ScanOffsetStartOfOuterExpression(content : string, offset : number, ignoreTable : Array<number>) : [number, number]
{
    let depth_paren = 0;
    let depth_sqbracket = 0;
    let depth_anglebracket = 0;
    let sq_string = false;
    let dq_string = false;
    let argumentIndex = 0;

    let ignoreTableIndex = ignoreTable ? ignoreTable.length-2 : -1;

    for (let curOffset = offset; curOffset > 0; --curOffset)
    {
        let char = content[curOffset];

        // Ignore characters that are in the ignore table completely
        while (ignoreTableIndex >= 0 && curOffset < ignoreTable[ignoreTableIndex])
            ignoreTableIndex -= 2;
        if (ignoreTableIndex >= 0)
        {
            let ignoreStart = ignoreTable[ignoreTableIndex];
            let ignoreEnd = ignoreTable[ignoreTableIndex+1];
            if (curOffset >= ignoreStart && curOffset < ignoreEnd)
                continue;
        }

        switch (char)
        {
            case ';':
            {
                if (!sq_string && !dq_string)
                {
                    return [-1, 0];
                }
            }
            break;
            case '(':
            {
                if (depth_sqbracket == 0)
                {
                    if (depth_paren == 0)
                    {
                        return [curOffset-1, argumentIndex];
                    }
                    else
                    {
                        depth_paren -= 1;
                    }
                }
            }
            break;
            case ')':
            {
                if (depth_sqbracket == 0)
                {
                    depth_paren += 1;
                }
            }
            break;
            case '[':
            {
                if (depth_paren == 0)
                {
                    if (depth_sqbracket == 0)
                    {
                        return [-1, 0];
                    }
                    else
                    {
                        depth_sqbracket -= 1;
                    }
                }
            }
            break;
            case ']':
            {
                if (depth_paren == 0)
                {
                    depth_sqbracket += 1;
                }
            }
            break;
            case '<':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    if (depth_anglebracket != 0)
                    {
                        depth_anglebracket -= 1;
                    }
                }
            }
            break;
            case '>':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    depth_anglebracket += 1;
                }
            }
            break;
            case ',':
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    argumentIndex += 1;
                }
            break;
            case '{':
            case '}':
            {
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    return [-1, 0];
                }
            }
            break;
        }
    }

    return [-1, 0];
}

function ScanOffsetEndOfOuterExpression(content : string, offset : number, ignoreTable : Array<number>) : number
{
    let depth_paren = 0;
    let depth_sqbracket = 0;
    let depth_anglebracket = 0;
    let sq_string = false;
    let dq_string = false;
    let argumentIndex = 0;

    let ignoreTableIndex = 0;
    for (let curOffset = offset; curOffset < content.length; ++curOffset)
    {
        let char = content[curOffset];

        // Ignore characters that are in the ignore table completely
        while (ignoreTableIndex < ignoreTable.length && curOffset > ignoreTable[ignoreTableIndex+1])
            ignoreTableIndex += 2;
        if (ignoreTableIndex < ignoreTable.length)
        {
            let ignoreStart = ignoreTable[ignoreTableIndex];
            let ignoreEnd = ignoreTable[ignoreTableIndex+1];
            if (curOffset >= ignoreStart && curOffset < ignoreEnd)
                continue;
        }

        switch (char)
        {
            case ';':
            {
                if (!sq_string && !dq_string)
                {
                    return -1;
                }
            }
            break;
            case ')':
            {
                if (depth_sqbracket == 0)
                {
                    if (depth_paren == 0)
                    {
                        return curOffset;
                    }
                    else
                    {
                        depth_paren -= 1;
                    }
                }
            }
            break;
            case '(':
            {
                if (depth_sqbracket == 0)
                {
                    depth_paren += 1;
                }
            }
            break;
            case ']':
            {
                if (depth_paren == 0)
                {
                    if (depth_sqbracket == 0)
                    {
                        return -1;
                    }
                    else
                    {
                        depth_sqbracket -= 1;
                    }
                }
            }
            break;
            case '[':
            {
                if (depth_paren == 0)
                {
                    depth_sqbracket += 1;
                }
            }
            break;
            case '>':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    if (depth_anglebracket != 0)
                    {
                        depth_anglebracket -= 1;
                    }
                }
            }
            break;
            case '<':
            {
                if (depth_paren == 0 && depth_sqbracket == 0)
                {
                    depth_anglebracket += 1;
                }
            }
            break;
            case '{':
            case '}':
            {
                if (depth_paren == 0 && depth_sqbracket == 0 && depth_anglebracket == 0)
                {
                    return -1;
                }
            }
            break;
        }
    }

    return -1;
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
    if (!prop.containingType)
        return true;

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
            if (!curtype || dbtype.typename != prop.containingType.typename)
                return false;
        }
        else if (prop.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(prop.containingType.typename))
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
    if (!func.containingType)
        return true;

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
            if (!curtype || dbtype.typename != func.containingType.typename)
                return false;
        }
        else if (func.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(func.containingType.typename))
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

function IsCodeEmpty(code : string)
{
    return /^[\t \r\n]*$/.test(code);
}

// Get a table of start,end pairs of character sequences
// that belong to comments, strings, etc, that we should ignore for processing.
function GetCodeOffsetIgnoreTable(code : string) : Array<number>
{
    let ignoreTable = new Array<number>();

    let inLineComment = false;
    let inBlockComment = false;
    let inPreproc = false;

    let sq_string = false;
    let dq_string = false;

    for (let index = 0, count = code.length; index < count; ++index)
    {
        let char = code[index];

        if (inLineComment)
        {
            if (char == '\n')
            {
                ignoreTable.push(index);
                inLineComment = false;
            }
            continue;
        }

        if (inBlockComment)
        {
            if (char == '*' && index+1 < code.length && code[index+1] == '/')
            {
                ignoreTable.push(index+2);
                inBlockComment = false;
                index += 1;
            }
            continue;
        }

        if (inPreproc)
        {
            if (char == '\n')
            {
                ignoreTable.push(index);
                inPreproc = false;
            }
            continue;
        }

        // Strings
        if (char == '"' && !sq_string)
        {
            if (dq_string)
            {
                if (index <= 0 || code[index-1] != '\\')
                {
                    ignoreTable.push(index+1);
                    dq_string = false;
                }
            }
            else
            {
                ignoreTable.push(index);
                dq_string = true;
            }
        }
        else if (dq_string)
            continue;

        if (char == "'" && !dq_string)
        {
            if (sq_string)
            {
                if (index <= 0 || code[index-1] != '\\')
                {
                    ignoreTable.push(index+1);
                    sq_string = false;
                }
            }
            else
            {
                ignoreTable.push(index);
                sq_string = true;
            }
        }
        else if (sq_string)
            continue;

        // Comments
        if (char == '/')
        {
            if (index+1 < code.length)
            {
                let nextchar = code[index+1];
                if (nextchar == '/')
                {
                    ignoreTable.push(index);
                    inLineComment = true;
                    continue;
                }
                else if (nextchar == '*')
                {
                    ignoreTable.push(index);
                    index += 1;
                    inBlockComment = true;
                    continue;
                }
            }
        }

        // Preprocessors
        if (char == '#')
        {
            ignoreTable.push(index);
            inPreproc = true;
            continue;
        }
    }

    // Finish final part of new code
    if (inLineComment || inBlockComment || inPreproc || sq_string || dq_string)
        ignoreTable.push(code.length);

    return ignoreTable;
}

function AddMethodOverrideSnippets(context : CompletionContext, completions : Array<CompletionItem>, position : Position)
{
    let typeOfScope = context.scope ? context.scope.getDatabaseType() : null;
    if (!typeOfScope || !typeOfScope.supertype)
        return;

    let prevLineText = position.line == 0 ? "" : context.scope.module.textDocument.getText(
        Range.create(
            Position.create(position.line-1, 0),
            Position.create(position.line, 0)
        )
    );

    let curLineText = context.scope.module.textDocument.getText(
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

    let hasReturnType = curLineText.trim().indexOf(context.completingSymbol) != 0;

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

    let foundOverrides = new Set<string>();
    for (let checktype of typeOfScope.getInheritanceTypes())
    {
        if (checktype == typeOfScope)
            continue;
        for (let method of checktype.methods)
        {
            let includeReturnType = false;
            let includeParamsOnly = false;

            if (method.name && CanCompleteTo(context.completingSymbol, method.name))
                includeParamsOnly = true;
            if (method.returnType && CanCompleteTo(context.completingSymbol, method.returnType))
                includeReturnType = true;
            if (method.isPrivate)
                continue;

            if (!includeParamsOnly && !includeReturnType)
                continue;

            if (checktype.isUnrealType() && !method.isEvent)
                continue;
            if (foundOverrides.has(method.name))
                continue;

            let complStr = GetDeclarationSnippet(method, currentIndent, false);
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
    }
}

function GetDeclarationSnippet(method : typedb.DBMethod, indent : string, includeReturnType : boolean) : string
{
    let preambleLength = method.name.length + 2;
    if (method.returnType)
        preambleLength += method.returnType.length;
    else
        preambleLength += 4;

    let complStr = "";
    if (includeReturnType)
        complStr += method.returnType+" ";
    complStr += method.name+"(";

    let lineLength = preambleLength;
    if (indent)
        lineLength += indent.length;
    if (method.args)
    {
        for (let i = 0; i < method.args.length; ++i)
        {
            let arg = method.args[i];
            let argLength = arg.typename.length;
            if (arg.name)
                argLength += arg.name.length + 1;

            if (lineLength + argLength > 100 && indent != null)
            {
                if (i != 0)
                {
                    complStr += ",";
                    lineLength += 1;
                }
                complStr += "\n"+" ".repeat(preambleLength);
                lineLength = indent.length + preambleLength;
            }
            else if (i != 0)
            {
                complStr += ", ";
                lineLength += 2;
            }

            complStr += arg.typename;
            if (arg.name)
            {
                complStr += " ";
                complStr += arg.name;
            }

            lineLength += argLength;
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
                value: "```angelscript_snippet\n"+NoBreakingSpaces(prop.format())+"\n```\n\n",
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
            docStr += "```angelscript_snippet\n"+getFunc.returnType+"\xa0"+item.data[2]+"\n```\n\n";
        }
        else if (setFunc && setFunc.args && setFunc.args.length >= 1)
        {
            docStr += "```angelscript_snippet\n"+setFunc.args[0].typename+"\xa0"+item.data[2]+"\n```\n\n";
        }

        let doc : string = null;
        if (getFunc)
            doc = getFunc.findAvailableDocumentation();
        if (!doc && setFunc)
            doc = setFunc.findAvailableDocumentation();
        if (doc)
            docStr += "\n"+doc.replace(/\n/g,"\n\n")+"\n\n";
            
        item.documentation = <MarkupContent> {
            kind: MarkupKind.Markdown,
            value: docStr,
        };
    }
    else if (kind == "func" || kind == "func_mixin")
    {
        let func = type.getMethodWithIdHint(item.data[2], item.data[3]);
        if (func)
        {
            let isMixin = (kind == "func_mixin");
            let complStr = NoBreakingSpaces(NicifyDefinition(func, func.format(null, isMixin)));
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript_snippet\n"+complStr+"\n```\n\n",
            };

            let doc = func.findAvailableDocumentation();
            if (doc)
                item.documentation.value += "\n"+doc.replace(/\n/g,"\n\n")+"\n\n";
        }
    }
    else if (kind == "decl_snippet")
    {
        let func = type.getMethodWithIdHint(item.data[2], item.data[3]);
        if (func)
        {
            let complStr = NoBreakingSpaces(GetDeclarationSnippet(func, null, true));
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript_snippet\n"+complStr+"\n```\n\n",
            };

            let doc = func.findAvailableDocumentation();
            if (doc)
                item.documentation.value += "\n"+doc.replace(/\n/g,"\n\n")+"\n\n";
        }
    }

    return item;
}

function AddSuperCallSnippet(context : CompletionContext, completions : Array<CompletionItem>)
{
    // Make sure we're in the right context for this snippet
    if (!context.statement || !context.statement.ast)
        return;

    let nsNode = context.statement.ast;
    if (nsNode.type != scriptfiles.node_types.NamespaceAccess)
        return;
    if (!nsNode.children[0] || nsNode.children[0].value != 'Super')
        return;

    let scopeFunction = context.scope.getParentFunction();
    let scopeType = context.scope.getParentType();
    if (!scopeType || !scopeFunction)
        return;

    let superType = typedb.GetType(scopeType.supertype);
    if (!superType)
        return;

    let superFunction = superType.findFirstSymbol(scopeFunction.name, typedb.DBAllowSymbol.FunctionOnly);
    if (!(superFunction instanceof typedb.DBMethod))
        return;

    let insertText = "";
    if (context.isIncompleteNamespace)
        insertText += ":";
    insertText += superFunction.name;
    insertText += "(";
    if (scopeFunction.args)
    {
        for (let i = 0; i < scopeFunction.args.length; ++i)
        {
            if (i != 0)
                insertText += ", ";
            insertText += scopeFunction.args[i].name;
        }
    }
    insertText += ");";

    completions.push({
        label: "Super::"+scopeFunction.name+"(...)",
        filterText: scopeFunction.name+"(...)",
        insertText: insertText,
        kind: CompletionItemKind.Snippet,
        preselect: true,
    });
}