import {
    CompletionItem, CompletionItemKind, Position, MarkupContent, MarkupKind,
    SignatureHelp, SignatureInformation, ParameterInformation, Range, TextEdit,
    CompletionItemLabelDetails, Command, WorkspaceEdit
} from 'vscode-languageserver/node';
import * as typedb from './database';
import * as scriptfiles from './as_parser';
import * as specifiers from './specifiers';
import { FormatFunctionDocumentation, FormatPropertyDocumentation } from './documentation';
import * as path from 'path';

let CommonTypenames = new Set<string>([
    "FVector", "FRotator", "FTransform", "FQuat",
]);
let CommonObjectTypes = new Set<string>([
    "AActor", "UActorComponent", "UObject",
]);
let CommonNamespaces = new Set<string>([
    "Math",
]);
let CommonTemplateTypes = new Set<string>(
    ['TArray', 'TMap', 'TSet', 'TSubclassOf', 'TSoftObjectPtr', 'TSoftClassPtr', 'TInstigated', 'TPerPlayer', 'TOptional'],
);

export interface CompletionSettings
{
    mathCompletionShortcuts : boolean,
    correctFloatLiteralsWhenExpectingDoublePrecision: boolean,
    dependencyRestrictions: Array<any>,
};

let CompletionSettings : CompletionSettings = {
    mathCompletionShortcuts: true,
    correctFloatLiteralsWhenExpectingDoublePrecision: false,
    dependencyRestrictions: [],
};

export function GetCompletionSettings() : CompletionSettings
{
    return CompletionSettings;
}

export function RefreshDependencyRestrictions()
{
    ResolvedModuleDependencyIsolations.clear();
    IsolateRegexes = [];

    for (let restriction of CompletionSettings.dependencyRestrictions)
    {
        if (restriction.isolate)
        {
            let pattern = "^"+(restriction.isolate as string).replace(/\./g, "\\.").replace(/\$/g, "[^.]+");
            IsolateRegexes.push(new RegExp(pattern));
        }
        else if (restriction.unisolate)
        {
            let pattern = "^"+(restriction.unisolate as string).replace(/\./g, "\\.").replace(/\$/g, "[^.]+");
            UnisolateRegexes.push(new RegExp(pattern));
        }
    }
}

let FunctionLabelSuffix = "()";
let FunctionLabelWithParamsSuffix = "(…)";

let IsolateRegexes = new Array<RegExp>();
let UnisolateRegexes = new Array<RegExp>();
let ResolvedModuleDependencyIsolations = new Map<string, string>();

namespace Sort
{
    export const EnumValue_Expected = "1";
    export const EnumName_Expected = "0";
    export const EnumValue_Max_Expected = "2";
    export const Local_Expected = "2";
    export const Local = "4";
    export const Keyword_Expected = "8a";
    export const Keyword = "8b";
    export const ImportModule = "8c";
    export const MemberProp_Direct = "a";
    export const MemberProp_Parent = "c";
    export const MemberProp_Direct_Expected = "6";
    export const MemberProp_Parent_Expected = "7";
    export const Method_Direct_Expected = "8a";
    export const Method_Parent_Expected = "9";
    export const Method_Direct = "b";
    export const Method_Parent = "d";
    export const EnumValue = "h";
    export const EnumValue_Max = "j";
    export const GlobalProp = "j";
    export const GlobalProp_Expected = "d";
    export const Global = "k";
    export const Global_Expected = "d";
    export const Typename_Common = "fa";
    export const Typename_SameFile = "fb";
    export const Typename_NearbyUsage = "fc";
    export const Typename_CommonObject = "fd";
    export const Typename = "fe";
    export const Typename_Expected = "3";
    export const Unimported = "x";
    export const Method_Override_Snippet = "0";
    export const Namespace_Unexpected = "z";
    export const Snippet = "z";
    export const Math_Shortcut = "z";
};

class CompletionContext
{
    scope: scriptfiles.ASScope = null;
    statement: scriptfiles.ASStatement = null;
    baseStatement: scriptfiles.ASStatement = null;
    completeOffset : number = -1;

    completingSymbol: string = null;
    completingNode: any = null;
    priorExpression: any = null;
    previousLineContent : string = null;

    priorType: typedb.DBType | typedb.DBNamespace = null;
    priorTypeWasNamespace : boolean = false;

    requiresPriorType : boolean = false;
    completingDot : boolean = false;
    completingNamespace : boolean = false;

    completingSymbolLowerCase : string = null;
    completingSymbolGetter : string = null;
    completingSymbolSetter : string = null;

    isRightExpression : boolean = false;
    isEqualityExpression : boolean = false;
    rightOperator : string = null;

    isSubExpression: boolean = false;
    isAssignment: boolean = false;
    isNamingSomethingNew: boolean = false;
    isNamingNewClass : boolean = false;
    isNamingNewStruct : boolean = false;
    isTypingAccessSpecifier: boolean = false;
    isIgnoredCode: boolean = false;
    isIncompleteNamespace: boolean = false;
    isFunctionDeclaration: boolean = false;
    isInsideType: boolean = false;
    expectedType: typedb.DBType = null;

    maybeTypename: boolean = false;
    typenameExpected : string = null

    subOuterStatement: scriptfiles.ASStatement = null;
    subOuterFunctions: Array<typedb.DBMethod> = null;
    subOuterArgumentIndex: number = -1;
    fullOuterStatement: scriptfiles.ASStatement = null;

    leftStatement : scriptfiles.ASStatement = null;
    leftType : typedb.DBType = null;
    outerAssignIdentifier : string = null;

    completionsMatchingExpected : Array<CompletionItem> = [];
    havePreselection : boolean = false;
    forceCaseInsensitive : boolean = false;
    nearbyTypenames = new Set<string>();

    isTypeExpected(typename : string) : boolean
    {
        if (!this.expectedType)
            return false;
        if (!typename || typename == "void")
            return false;
        if (this.expectedType.name == typename)
            return true;

        let dbtype = typedb.GetTypeByName(typename);
        if (!dbtype)
            return false;
        return dbtype.inheritsFrom(this.expectedType.name);
    }
}

class CompletionExpressionCandidate
{
    start: number = -1;
    end: number = -1;
    code: string = null;
    isRightExpression: boolean = false;
    rightOperator : string = null;
};

class CompletionArguments
{
    isAfterNamedArgument: boolean = false;
    currentArgumentName: string = null;
    usedArgumentNames: Array<string> = [];
    nodesForPositionalArguments: Array<any> = [];
};

export function Complete(asmodule: scriptfiles.ASModule, position: Position): Array<CompletionItem>
{
    if (!asmodule)
        return null;
    let completions = new Array<CompletionItem>();

    let offset = asmodule.getOffset(position);
    let context = GenerateCompletionContext(asmodule, offset - 1);

    // No completions when in ignored code (comments, strings, etc)
    if (context.isIgnoredCode)
        return [];

    // If we're typing a name for a new symbol, we only do special completions
    if (context.isNamingSomethingNew)
    {
        AddCompletionsForNamingSomethingNew(context, completions);
        return completions;
    }

    // Add completions from import statements
    if (AddCompletionsFromImportStatement(context, completions))
        return completions;

    // Add completions from unreal macro specifiers
    if (AddCompletionsFromUnrealMacro(context, completions))
        return completions;

    // Add completions from access specifiers
    if (AddCompletionsFromAccessSpecifiers(context, completions))
        return completions;

    if (context.completingSymbol == null)
        return null;

    let searchTypes = new Array<typedb.DBType | typedb.DBNamespace>();
    let insideType = context.scope ? context.scope.getParentType() : null;

    if (context.priorType)
    {
        if (context.requiresPriorType)
        {
            // Don't offer completions if we are using the wrong access type
            if (context.priorTypeWasNamespace != context.completingNamespace)
                return null;
        }

        // Complete from the type of the expression before us
        searchTypes.push(context.priorType);
    }
    else if (context.requiresPriorType)
    {
        return null;
    }
    else if (context.scope)
    {
        // Complete from the class we're in
        if (insideType)
            searchTypes.push(insideType);

        // Complete from available namespaces
        let checkNamespace = context.scope.getNamespace();
        while (checkNamespace)
        {
            searchTypes.push(checkNamespace);
            checkNamespace = checkNamespace.parentNamespace;
        }

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

        // Shortcut completions from Math:: if enabled
        AddMathShortcutCompletions(context, completions);
    }

    // Search for completions in all global and real types we are looking in
    for (let dbtype of searchTypes)
    {
        let showEvents = !context.scope || context.scope.scopetype != scriptfiles.ASScopeType.Class || !insideType;
        AddCompletionsFromType(context, dbtype, completions, showEvents);
    }

    // Add completions for mixin calls to global functions
    if (context.priorType || (!context.isInsideType && context.scope.getParentType()))
    {
        AddMixinCompletions(context, completions);
    }

    // Complete keywords if appropriate
    if (!context.isInsideType)
        AddCompletionsFromKeywords(context, completions);

    // Check if we're inside a function call and complete argument names
    if (context.isSubExpression && context.subOuterFunctions && !context.isInsideType)
        AddCompletionsFromCallSignature(context, completions);

    // Check for snippet completions for method overrides
    if (context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class
        && !context.isRightExpression && !context.isSubExpression && !context.isInsideType) {
        AddMethodOverrideSnippets(context, completions, position);
    }

    // General completion shortcuts
    AddShortcutCompletions(context, completions);

    // Add snippet completion for super call if we can
    AddSuperCallSnippet(context, completions);

    // We sometimes want to pre-select one of the completion items if we're confident the user
    // wants that specific one over all the others.
    // This should be done after all comletions are added.
    if (!context.havePreselection)
        DeterminePreSelectedCompletion(context);

    // Some completions force the entire completion list to be case-insensitivy for usability reasons
    if (context.forceCaseInsensitive)
        MakeCompletionsLowerCase(completions);

    return completions;
}

function MakeCompletionsLowerCase(completions : Array<CompletionItem>)
{
    for (let compl of completions)
    {
        if (compl.filterText)
        {
            compl.filterText = compl.filterText.toLowerCase();
        }
        else
        {
            let lowercaseLabel = compl.label.toLowerCase();
            if (lowercaseLabel != compl.label)
                compl.filterText = lowercaseLabel;
        }
    }
}

function DeterminePreSelectedCompletion(context: CompletionContext)
{
    if (context.havePreselection)
        return;
    if (context.completionsMatchingExpected.length == 0)
        return;

    // If any of our matching completions start with the term we're completing,
    // then don't consider completions that _don't_ start with it for preselection.
    if (context.completingSymbol && context.completingSymbol.length != 0)
    {
        let startWithCompletions : Array<CompletionItem> = [];
        for (let compl of context.completionsMatchingExpected)
        {
            let complText = compl.filterText ? compl.filterText : compl.label;
            if (CanCompleteToOnlyStart(context, complText))
                startWithCompletions.push(compl);
        }

        if (startWithCompletions.length != 0)
            context.completionsMatchingExpected = startWithCompletions;
    }

    // Only trigger preselection if we only have one candidate for preselection,
    // otherwise we don't preselect to let vscode handle MRU and fuzzy matching.
    if (context.completionsMatchingExpected.length == 1)
    {
        context.completionsMatchingExpected[0].preselect = true;
        context.havePreselection = true;
        return;
    }

    // If all items are actually the same, then preselect them all anyway
    let completionsIdentical = true;
    let identicalText : string = null;

    for (let compl of context.completionsMatchingExpected)
    {
        let complText = compl.insertText ? compl.insertText : compl.label;
        if (identicalText == null || complText == identicalText)
        {
            identicalText = complText;
        }
        else
        {
            completionsIdentical = false;
            break;
        }
    }

    if (completionsIdentical)
    {
        context.havePreselection = true;
        for (let compl of context.completionsMatchingExpected)
            compl.preselect = true;
    }
}

function GenerateCompletionArguments(context: CompletionContext): CompletionArguments
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
                    else
                    {
                        args.nodesForPositionalArguments.push(argnode);
                    }
                }
            }
        }
    }
    return args;
}

function ScoreTypeMatch(wantedType : typedb.DBType, providedType : typedb.DBType) : number
{
    if (wantedType == providedType)
        return 2;

    if (wantedType.isPrimitive && providedType.isPrimitive)
    {
        if (typedb.ArePrimitiveTypesEquivalent(wantedType.name, providedType.name))
            return 2;

        let wantedFloat = typedb.IsPrimitiveFloatType(wantedType.name);
        let providedFloat = typedb.IsPrimitiveFloatType(providedType.name);

        if (wantedFloat && !providedFloat)
            return 1;
        if (providedFloat && !wantedFloat)
            return 0;
    }

    return -2;
}

function ScoreMethodOverload(context: CompletionContext, func: typedb.DBMethod, argContext: CompletionArguments) : [number, number]
{
    let score = 0;
    let argumentIndex = context.subOuterArgumentIndex;
    let argumentLength = func.args.length;
    let argumentOffset = 0;

    if (func.isMixin)
    {
        argumentOffset = 1;
        argumentIndex += 1;
    }

    // Check if we've passed too many arguments
    if (argumentIndex >= argumentLength)
    {
        if (argumentIndex > argumentOffset || (context.statement.content && context.statement.content.length > 0))
            score -= 50;
    }

    // Check if all named arguments we're using are matched
    let activeArg = -1;
    for (let usedName of argContext.usedArgumentNames)
    {
        let foundArg = -1;
        for (let argIndex = argumentOffset; argIndex < func.args.length; ++argIndex)
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
                activeArg = foundArg - argumentOffset;
        }
    }

    // 0-argument constructors are prioritized a little lower so we see the arguments earlier
    if (func.isConstructor && (!func.args || func.args.length == 0))
        score -= 1;

    // See if we can match the types of all the arguments
    let posArgCount = Math.min(argContext.nodesForPositionalArguments.length, argumentLength - argumentOffset);
    for (let posArg = 0; posArg < posArgCount; ++posArg)
    {
        let argnode = argContext.nodesForPositionalArguments[posArg];
        let argType = scriptfiles.ResolveTypeFromExpression(context.scope, argnode);
        if (!argType)
            continue;

        let wantedType = typedb.LookupType(func.namespace, func.args[posArg].typename);
        if (!wantedType)
            continue;

        score += ScoreTypeMatch(wantedType, argType);
    }

    return [score, activeArg];
}

export function SortMethodsBasedOnArgumentTypes(methods: Array<typedb.DBMethod>, asmodule: scriptfiles.ASModule, offset: number)
{
    let context = GenerateCompletionContext(asmodule, offset - 1);
    let argContext = GenerateCompletionArguments(context);
    context.subOuterArgumentIndex = argContext.nodesForPositionalArguments.length - 1;

    let scoredFunctions = new Array<[typedb.DBMethod, number]>();

    for (let func of methods)
        scoredFunctions.push([func, ScoreMethodOverload(context, func, argContext)[0]]);

    scoredFunctions.sort(
        (first, second) => {
            if (first[1] > second[1])
                return -1;
            else if (first[1] < second[1])
                return 1;
            else
                return 0;
        }
    );

    methods.splice(0, methods.length);
    for (let [func, score] of scoredFunctions)
        methods.push(func);
}

export function GetDetermineTypeFromArguments(asmodule : scriptfiles.ASModule, offset : number, argumentIndex : number) : typedb.DBType
{
    if (argumentIndex < 0)
        return null;
    let context = GenerateCompletionContext(asmodule, offset - 1);
    let argContext = GenerateCompletionArguments(context);
    if (argContext && argumentIndex < argContext.nodesForPositionalArguments.length)
    {
        let argnode = argContext.nodesForPositionalArguments[argumentIndex];
        let argType = scriptfiles.ResolveTypeFromExpression(context.scope, argnode);
        return argType;
    }

    return null;
}

export function Signature(asmodule: scriptfiles.ASModule, position: Position): SignatureHelp
{
    if (!asmodule)
        return null;

    let completions = new Array<CompletionItem>();

    let offset = asmodule.getOffset(position);
    let context = GenerateCompletionContext(asmodule, offset - 1);

    if (!context.subOuterFunctions)
        return null;
    if (context.subOuterFunctions.length == 0)
        return null;

    let argContext = GenerateCompletionArguments(context);

    let sigHelp = <SignatureHelp>{
        signatures: new Array<SignatureInformation>(),
        activeSignature: 0,
        activeParameter: 0,
    };

    let bestFunction = -1;
    let bestFunctionScore = 0;
    let bestFunctionActiveArg = -1;
    for (let i = 0; i < context.subOuterFunctions.length; ++i)
    {
        let func = context.subOuterFunctions[i];

        let determineType : typedb.DBType = null;
        if (func.determinesOutputTypeArgumentIndex != -1)
        {
            if (argContext && func.determinesOutputTypeArgumentIndex < argContext.nodesForPositionalArguments.length)
            {
                let argnode = argContext.nodesForPositionalArguments[func.determinesOutputTypeArgumentIndex];
                determineType = scriptfiles.ResolveTypeFromExpression(context.scope, argnode);
            }
        }

        // Keep track of the best function
        let [score, activeArg] = ScoreMethodOverload(context, func, argContext);
        if (score > bestFunctionScore || bestFunction == -1)
        {
            bestFunctionScore = score;
            bestFunction = i;

            if (argContext.currentArgumentName && activeArg != -1)
                bestFunctionActiveArg = activeArg;
            else if (argContext.isAfterNamedArgument)
                activeArg = bestFunctionActiveArg = -1;
            else
                activeArg = bestFunctionActiveArg = context.subOuterArgumentIndex;
        }

        let skipFirstArg = false;
        if (func.isMixin)
            skipFirstArg = true;

        let params = new Array<ParameterInformation>();
        if (func.args)
        {
            for (let a = skipFirstArg ? 1 : 0; a < func.args.length; ++a)
            {
                if (determineType && a == func.determinesOutputTypeArgumentIndex)
                {
                    params.push(<ParameterInformation>
                        {
                            label: func.args[a].format(determineType.name)
                        });
                }
                else
                {
                    params.push(<ParameterInformation>
                        {
                            label: func.args[a].format()
                        });
                }
            }
        }

        let sig = <SignatureInformation>{
            label: func.format(null, skipFirstArg, false, null, determineType),
            parameters: params,
        };

        let doc = func.findAvailableDocumentation(true, false);
        if (doc)
        {
            sig.documentation = {
                kind: MarkupKind.Markdown,
                value: FormatFunctionDocumentation(doc, func, activeArg),
            };
        }

        sigHelp.signatures.push(sig);
    }

    if (bestFunction != -1)
    {
        sigHelp.activeSignature = bestFunction;
        sigHelp.activeParameter = bestFunctionActiveArg;
    }
    return sigHelp.signatures.length == 0 ? null : sigHelp;
}

function AddCompletionsFromCallSignature(context: CompletionContext, completions: Array<CompletionItem>)
{
    if (context.subOuterFunctions.length == 0)
        return;

    let argContext = GenerateCompletionArguments(context);

    // Find the best function to complete with
    let activeMethod: typedb.DBMethod = null;
    let bestScore = 0;
    for (let func of context.subOuterFunctions)
    {
        let [score, activeArg] = ScoreMethodOverload(context, func, argContext);
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

                let supertype = typeOfScope.getSuperType();
                if (supertype)
                {
                    let supersymbol = supertype.findFirstSymbol(activeMethod.name, typedb.DBAllowSymbol.Functions);
                    if (supersymbol instanceof typedb.DBMethod)
                        activeMethod = supersymbol;
                }
            }
        }

        if (completeDefinition)
        {
            let argumentIndex = context.subOuterArgumentIndex;
            if (activeMethod.isMixin)
                argumentIndex += 1;

            if (argumentIndex < activeMethod.args.length)
            {
                let arg = activeMethod.args[argumentIndex];
                let complStr = arg.typename + " " + arg.name;
                if (CanCompleteTo(context, complStr))
                {
                    completions.push({
                        label: complStr,
                        documentation: <MarkupContent>{
                            kind: MarkupKind.Markdown,
                            value: "```angelscript_snippet\n" + complStr + "\n\n```"
                        },
                        kind: CompletionItemKind.Snippet,
                        sortText: Sort.Snippet,
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

                let complStr = arg.name+" =";
                if (CanCompleteTo(context, complStr))
                {
                    completions.push({
                        label: complStr,
                        insertText: complStr+" ",
                        documentation: <MarkupContent> {
                            kind: MarkupKind.Markdown,
                            value: "```angelscript_snippet\n"+complStr+"\n\n```"
                        },
                        kind: CompletionItemKind.Snippet,
                        sortText: Sort.Snippet,
                    });
                }
            }
        }
    }
}

function AddCompletionsFromKeywordList(context : CompletionContext, keywords : Array<string>, completions : Array<CompletionItem>, expectedIf : string = null)
{
    for(let kw of keywords)
    {
        if (CanCompleteTo(context, kw))
        {
            completions.push({
                label: kw,
                kind: CompletionItemKind.Keyword,
                sortText: context.isTypeExpected(expectedIf) ? Sort.Keyword_Expected : Sort.Keyword,
            });
        }
    }
}

function AddCompletionsFromSpecifiers(context : CompletionContext, specifiers : any, completions : Array<CompletionItem>)
{
    for(let spec in specifiers)
    {
        if (!context.completingSymbol || CanCompleteTo(context, spec))
        {
            completions.push({
                label: spec,
                documentation: specifiers[spec],
                kind: CompletionItemKind.Keyword,
                sortText: Sort.Keyword,
            });
        }
    }
}

function AddCompletionsForNamingSomethingNew(context : CompletionContext, completions : Array<CompletionItem>) : boolean
{
    if (!context.scope)
        return false;
    if (!context.scope.module)
        return false;

    let filebasename = path.basename(context.scope.module.filename, ".as");

    let proposedNames = [];
    if (context.isNamingNewClass)
    {
        proposedNames.push("U"+filebasename);
        proposedNames.push("A"+filebasename);
    }
    else if (context.isNamingNewStruct)
    {
        proposedNames.push("F"+filebasename);
    }

    if (proposedNames.length == 0)
        return false;

    for (let proposed of proposedNames)
    {
        // Only allow it if we're already typing it
        if (!CanCompleteToOnlyStart(context, proposed))
            continue;

        // Don't allow the suggested name if we already have a type by that name
        let hasType = false;
        for (let existingType of context.scope.module.types)
        {
            if (existingType.name == proposed)
            {
                hasType = true;
                break;
            }
        }

        if (hasType)
            continue;

        completions.push({
            label: proposed,
            kind: CompletionItemKind.Text,
        });
    }

    return true;
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
            if (CanCompleteStringTo(complString, asmodule.modulename))
            {
                completions.push({
                    label: asmodule.modulename,
                    kind: CompletionItemKind.File,
                    filterText: asmodule.modulename.substr(untilDot.length),
                    insertText: asmodule.modulename.substr(untilDot.length),
                    sortText: Sort.ImportModule,
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
        if (context.outerAssignIdentifier)
        {
            let subspecifiers = [];

            let isInsideMacro = false;
            let macroContent : string = null;
            if (context.baseStatement.ast && context.baseStatement.ast.macro)
            {
                let macro_start = context.baseStatement.start_offset + context.baseStatement.ast.macro.start;
                let macro_end = context.baseStatement.start_offset + context.baseStatement.ast.macro.end;

                if (context.completeOffset >= macro_start && context.completeOffset < macro_end)
                {
                    isInsideMacro = true;
                    macroContent = context.baseStatement.content.substring(
                        context.baseStatement.ast.macro.start,
                        context.baseStatement.ast.macro.end);
                }
            }

            // Detect if we're inside a sub-specifier
            let isPropertySpec = false;
            if (/[\r\n\s]*UPROPERTY\s*\(.*\)[\r\n\s]*$/.test(context.baseStatement.content))
            {
                subspecifiers.push(specifiers.ASPropertySubSpecifiers);
                isPropertySpec = true;
            }
            else if (/[\r\n\s]*UFUNCTION\s*\(.*\)[\r\n\s]*$/.test(context.baseStatement.content))
            {
                subspecifiers.push(specifiers.ASFunctionSubSpecifiers);
            }
            else if (/[\r\n\s]*UCLASS\s*\(.*\)[\r\n\s]*$/.test(context.baseStatement.content))
            {
                subspecifiers.push(specifiers.ASClassSubSpecifiers);
            }
            else if (/[\r\n\s]*USTRUCT\s*\(.*\)[\r\n\s]*$/.test(context.baseStatement.content))
            {
                subspecifiers.push(specifiers.ASStructSubSpecifiers);
            }
            else if (isInsideMacro && /^\s*UPROPERTY\s*\(/.test(macroContent))
            {
                subspecifiers.push(specifiers.ASPropertySubSpecifiers);
                isPropertySpec = true;
            }
            else if (isInsideMacro && /^\s*UFUNCTION\s*\(/.test(macroContent))
            {
                subspecifiers.push(specifiers.ASFunctionSubSpecifiers);
            }
            else if (isInsideMacro && /^\s*UCLASS\s*\(/.test(macroContent))
            {
                subspecifiers.push(specifiers.ASClassSubSpecifiers);
            }
            else if (isInsideMacro && /^\s*USTRUCT\s*\(/.test(macroContent))
            {
                subspecifiers.push(specifiers.ASStructSubSpecifiers);
            }

            let foundSubSpecifier = false;
            let lowerIdentifier = context.outerAssignIdentifier.toLowerCase();
            for (let sublist of subspecifiers)
            {
                if (lowerIdentifier in sublist)
                {
                    foundSubSpecifier = true;
                    AddCompletionsFromSpecifiers(context, sublist[lowerIdentifier], completions);
                }
            }

            // If we're completing an 'Attach' also complete component names
            if (isPropertySpec && lowerIdentifier == "attach")
            {
                let dbtype = context.scope.getDatabaseType();
                if (dbtype && dbtype.inheritsFrom("AActor"))
                {
                    dbtype.forEachSymbol(function (sym : typedb.DBSymbol)
                    {
                        if (!(sym instanceof typedb.DBProperty))
                            return;
                        let prop = sym;

                        // We can't complete to C++ components unfortunately because we only know the variable
                        // name, not the name of the component, and we need the name of the component.
                        if (!prop.declaredModule)
                            return;

                        let propType = typedb.LookupType(prop.namespace, prop.typename);
                        if (!propType)
                            return;
                        if (!propType.inheritsFrom("USceneComponent"))
                            return;
                        if (!prop.macroSpecifiers || !prop.macroSpecifiers.has("DefaultComponent"))
                            return;

                        if (!context.completingSymbol || CanCompleteTo(context, prop.name))
                        {
                            let documentation = "Attach this component to "+prop.name;
                            if (prop.documentation)
                                documentation += ":\n"+prop.documentation;

                            completions.push({
                                label: prop.name,
                                documentation: documentation,
                                kind: CompletionItemKind.Field,
                                sortText: Sort.Keyword,
                            });
                        }
                    });

                    foundSubSpecifier = true;
                }
            }

            if (foundSubSpecifier)
                return true;
        }

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

            if (scriptfiles.GetScriptSettings().useAngelscriptHaze)
                AddCompletionsFromSpecifiers(context, specifiers.ASPropertySpecifiers_HAZE, completions);
            else
                AddCompletionsFromSpecifiers(context, specifiers.ASPropertySpecifiers_NO_HAZE, completions);
            return true;
        }

        if (/^\s*UFUNCTION\s*$/.test(context.subOuterStatement.content))
        {
            AddCompletionsFromSpecifiers(context, specifiers.ASFunctionSpecifiers, completions);

            if (scriptfiles.GetScriptSettings().useAngelscriptHaze)
                AddCompletionsFromSpecifiers(context, specifiers.ASFunctionSpecifiers_HAZE, completions);
            else
                AddCompletionsFromSpecifiers(context, specifiers.ASFunctionSpecifiers_NO_HAZE, completions);
            return true;
        }
    }

    return false;
}

function AddCompletionsFromKeywords(context : CompletionContext, completions : Array<CompletionItem>)
{
    let inFunctionBody = !context.scope || context.scope.isInFunctionBody();

    let scopeType = context.scope ? context.scope.getParentType() : null;
    let isInClass = (context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class) && scopeType && !scopeType.isStruct;
    let isInStruct = (context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class) && scopeType && scopeType.isStruct;

    let isInSwitch = false;
    let isInLoop = false;

    let checkScope = context.scope;
    while (checkScope)
    {
        if (checkScope.previous && checkScope.previous instanceof scriptfiles.ASStatement)
        {
            let heading = checkScope.previous;
            if (heading.ast)
            {
                if (heading.ast.type == scriptfiles.node_types.SwitchStatement)
                {
                    isInSwitch = true;
                }
                else if (
                    heading.ast.type == scriptfiles.node_types.ForLoop
                    || heading.ast.type == scriptfiles.node_types.ForEachLoop
                    || heading.ast.type == scriptfiles.node_types.WhileLoop
                )
                {
                    isInLoop = true;
                }
            }
        }

        if (checkScope.element_head && checkScope.element_head instanceof scriptfiles.ASStatement)
        {
            let heading = checkScope.element_head;
            if (heading.ast)
            {
                if (
                    heading.ast.type == scriptfiles.node_types.ForLoop
                    || heading.ast.type == scriptfiles.node_types.ForEachLoop
                )
                {
                    isInLoop = true;
                    break;
                }
            }
        }

        checkScope = checkScope.parentscope;
    }

    AddCompletionsFromKeywordList(context, [
        "auto"
    ], completions);

    if (context.isRightExpression || context.isSubExpression)
    {
        AddCompletionsFromKeywordList(context, [
            "true", "false",
        ], completions, "bool");

        AddCompletionsFromKeywordList(context, [
            "nullptr",
        ], completions, "UObject");

        if (context.expectedType && !context.expectedType.isValueType())
        {
            AddCompletionsFromKeywordList(context, [
                "Cast",
            ], completions);
        }
    }

    if (!context.isRightExpression && !context.isSubExpression)
    {
        AddCompletionsFromKeywordList(context, [
            "const",
        ], completions);

        if (isInSwitch)
        {
            if (CanCompleteTo(context, "case"))
            {
                completions.push({
                        label: "case",
                        kind: CompletionItemKind.Keyword,
                        commitCharacters: [" "],
                        sortText: Sort.Keyword,
                });
            }

            if (CanCompleteTo(context, "fallthrough"))
            {
                completions.push({
                        label: "fallthrough",
                        kind: CompletionItemKind.Keyword,
                        commitCharacters: [";"],
                        sortText: Sort.Keyword,
                });
            }
        }

        if (isInClass || isInSwitch)
        {
            if (CanCompleteTo(context, "default"))
            {
                completions.push({
                        label: "default",
                        kind: CompletionItemKind.Keyword,
                        commitCharacters: [" ", ":"],
                        sortText: Sort.Keyword,
                });
            }
        }
    }

    if ((!context.scope || context.scope.scopetype == scriptfiles.ASScopeType.Global || context.scope.scopetype == scriptfiles.ASScopeType.Namespace)
        && (!context.isSubExpression && !context.isRightExpression))
    {
        AddCompletionsFromKeywordList(context, [
            "delegate", "event", "class", "struct",
            "property"
        ], completions);

        if (CanCompleteTo(context, "UCLASS"))
        {
            completions.push({
                    label: "UCLASS",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: ["("],
                    sortText: Sort.Keyword,
            });
        }

        if (CanCompleteTo(context, "USTRUCT"))
        {
            completions.push({
                    label: "USTRUCT",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: ["("],
                    sortText: Sort.Keyword,
            });
        }

        if (CanCompleteToOnlyStart(context, "UENUM"))
        {
            completions.push({
                    label: "UENUM",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: ["("],
                    sortText: Sort.Keyword,
            });
        }
    }

    if (context.scope && inFunctionBody)
    {
        if (!context.isRightExpression && !context.isSubExpression)
        {
            AddCompletionsFromKeywordList(context, [
                "if", "else", "while", "for", "switch",
            ], completions);

            if (isInLoop)
            {
                if (CanCompleteTo(context, "continue"))
                {
                    completions.push({
                            label: "continue",
                            kind: CompletionItemKind.Keyword,
                            commitCharacters: [";"],
                            sortText: Sort.Keyword,
                    });
                }
            }

            if (isInSwitch || isInLoop)
            {
                if (CanCompleteTo(context, "break"))
                {
                    completions.push({
                            label: "break",
                            kind: CompletionItemKind.Keyword,
                            commitCharacters: [";"],
                            sortText: Sort.Keyword,
                    });
                }
            }

            completions.push({
                    label: "return",
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: [" ", ";"],
                    sortText: Sort.Keyword,
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
                "override", "final", "property", "private", "protected", "access"
            ], completions);

            if (CanCompleteToOnlyStart(context, "UPROPERTY"))
            {
                // Don't complete to a macro if there was already a macro on the previous line
                if (!/[\r\n\s]*(UFUNCTION|UPROPERTY)\s*\(/.test(context.previousLineContent))
                {
                    completions.push({
                            label: "UPROPERTY",
                            kind: CompletionItemKind.Keyword,
                            commitCharacters: ["("],
                            sortText: Sort.Keyword,
                    });
                    context.forceCaseInsensitive = true;
                }
            }
        }

        let scopeType = context.scope.getParentType();
        if (scopeType && !scopeType.isStruct)
        {
            if (!context.isRightExpression && !context.isSubExpression)
            {
                if (CanCompleteToOnlyStart(context, "UFUNCTION"))
                {
                    // Don't complete to a macro if there was already a macro on the previous line
                    if (!/[\r\n\s]*(UFUNCTION|UPROPERTY)\s*\(/.test(context.previousLineContent))
                    {
                        completions.push({
                                label: "UFUNCTION",
                                kind: CompletionItemKind.Keyword,
                                commitCharacters: ["("],
                                sortText: Sort.Keyword,
                        });
                        context.forceCaseInsensitive = true;
                    }
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

            if (CanCompleteToOnlyStart(context, "UFUNCTION"))
            {
                // Don't complete to a macro if there was already a macro on the previous line
                if (!/[\r\n\s]*(UFUNCTION|UPROPERTY)\s*\(/.test(context.previousLineContent))
                {
                    completions.push({
                            label: "UFUNCTION",
                            kind: CompletionItemKind.Keyword,
                            commitCharacters: ["("],
                            sortText: Sort.Keyword,
                    });
                    context.forceCaseInsensitive = true;
                }
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

function AddShortcutCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (context.isInsideType || context.isIncompleteNamespace)
        return;

    // Special case completion for automatically completing FMath:: to Math::
    if (CanCompleteTo(context, "FMath"))
    {
        let OldNamespace = typedb.LookupNamespace(null, "FMath");
        let MathNamespace = typedb.LookupNamespace(null, "Math");
        if (MathNamespace && !OldNamespace)
        {
            let commitChars = [":"];
            GetTypenameCommitChars(context, "FMath", commitChars);

            completions.push({
                    label: "Math",
                    kind: CompletionItemKind.Module,
                    data: ["namespace", "Math"],
                    commitCharacters: commitChars,
                    insertText: "Math",
                    filterText: "FMath",
                    sortText: Sort.Typename,
            });
        }
    }
}

export function AddCompletionsFromClassKeywords(context : CompletionContext, completions : Array<CompletionItem>)
{
    let insideType = context.scope.getParentType();
    if (!insideType)
        return;
    if (CanCompleteTo(context, "this"))
    {
        completions.push({
                label: "this",
                labelDetails: <CompletionItemLabelDetails>
                {
                    description: insideType.name,
                },
                kind : CompletionItemKind.Keyword,
                commitCharacters: [".", ";", ","],
                sortText: context.isTypeExpected(insideType.name) ? Sort.Keyword_Expected : Sort.Keyword,
        });
    }

    if (context.scope.isInFunctionBody() && CanCompleteTo(context, "Super"))
    {
        let supertype = insideType.getSuperType();
        // Don't complete to Super if it is a C++ class, that doesn't work
        if (supertype && supertype.declaredModule)
        {
            completions.push({
                    label: "Super",
                    labelDetails: <CompletionItemLabelDetails>
                    {
                        description: insideType.supertype,
                    },
                    kind: CompletionItemKind.Keyword,
                    commitCharacters: [":"],
                    sortText: Sort.Keyword,
            });
        }
    }
}

export function AddCompletionsFromLocalVariables(context : CompletionContext, scope : scriptfiles.ASScope, completions : Array<CompletionItem>)
{
    for (let asvar of scope.variables)
    {
        if (CanCompleteTo(context, asvar.name))
        {
            let complItem = <CompletionItem> {
                label: asvar.name,
                labelDetails: <CompletionItemLabelDetails>
                {
                    description: asvar.typename,
                },
                kind : CompletionItemKind.Variable,
                commitCharacters: [".", ";", ","],
                sortText: Sort.Local,
            };

            if (context.isTypeExpected(asvar.typename))
            {
                context.completionsMatchingExpected.push(complItem);
                complItem.sortText = Sort.Local_Expected;
            }

            completions.push(complItem);
        }
    }
}

export function AddCompletionsFromType(context : CompletionContext, curtype : typedb.DBType | typedb.DBNamespace, completions : Array<CompletionItem>, showEvents : boolean = true)
{
    let scopeType = context.scope ? context.scope.getParentType() : null;
    let props = new Set<string>();

    let expectedSubclassOf : string = null;
    if (context.expectedType && context.expectedType.templateBaseType && context.expectedType.templateBaseType == "TSubclassOf")
    {
        if (context.expectedType.templateSubTypes && context.expectedType.templateSubTypes[0])
            expectedSubclassOf = context.expectedType.templateSubTypes[0];
    }
    else if (context.expectedType && context.expectedType.name == "UClass")
    {
        expectedSubclassOf = "UObject";
    }

    // Complete symbols
    let propertyIndex = 0;
    curtype.forEachSymbol(function(symbol : typedb.DBSymbol)
    {
        if (symbol instanceof typedb.DBProperty)
        {
            if (!CanCompleteSymbol(context, symbol))
                return;

            let prop : typedb.DBProperty = symbol;
            propertyIndex += 1;

            if (!isPropertyAccessibleFromScope(curtype, prop, context.scope))
                return;
            props.add(prop.name);

            let compl = <CompletionItem>{
                    label: prop.name,
                    kind : CompletionItemKind.Field,
                    labelDetails: <CompletionItemLabelDetails>
                    {
                        description: prop.typename,
                    },
                    commitCharacters: [".", ";", ","],
                    filterText: GetSymbolFilterText(context, prop),
            };

            if (prop.containingType)
            {
                if (prop.containingType.isEnum)
                {
                    // Append the index of the enum value so they get sorted correctly
                    let sortNumber = propertyIndex.toString().padStart(3, '0');
                    if (prop.name.includes("MAX"))
                        compl.sortText = Sort.EnumValue_Max+sortNumber;
                    else
                        compl.sortText = Sort.EnumValue+sortNumber;
                }
                else if (prop.containingType == scopeType)
                    compl.sortText = Sort.MemberProp_Direct;
                else
                    compl.sortText = Sort.MemberProp_Parent;

                compl.data = ["prop", prop.containingType.name, prop.name];
            }
            else
            {
                compl.sortText = Sort.GlobalProp;
                compl.data = ["global_prop", prop.namespace.getQualifiedNamespace(), prop.name];
            }

            if (context.isTypeExpected(prop.typename))
            {
                if (prop.containingType || !prop.namespace.isRootNamespace())
                    context.completionsMatchingExpected.push(compl);

                if (prop.containingType && prop.containingType.isEnum)
                {
                    // Append the index of the enum value so they get sorted correctly
                    let sortNumber = propertyIndex.toString().padStart(3, '0');
                    if (prop.name.includes("MAX"))
                        compl.sortText = Sort.EnumValue_Max_Expected+sortNumber;
                    else
                        compl.sortText = Sort.EnumValue_Expected+sortNumber;
                }
                else if (prop.containingType && prop.containingType == scopeType)
                    compl.sortText = Sort.MemberProp_Direct_Expected;
                else if (prop.containingType)
                    compl.sortText = Sort.MemberProp_Parent_Expected;
                else
                    compl.sortText = Sort.GlobalProp_Expected;
            }

            if (context.isIncompleteNamespace)
                compl.insertText = ":"+compl.label;
            completions.push(compl);
        }
        else if (symbol instanceof typedb.DBMethod)
        {
            let func : typedb.DBMethod = symbol;
            if (func.isMixin)
                return;
            if (!CanCompleteSymbol(context, func))
                return;
            if (!isFunctionAccessibleFromScope(curtype, func, context.scope))
                return;
            if (func.isOverride || func.isBlueprintOverride)
                return;
            if (!func.isCallable)
                return;
            if (func.isTemplateInstantiation && func.containingType != curtype)
                return;

            // Don't show constructors if we're probably completing the name of a type
            if (func.isConstructor && (context.maybeTypename || (expectedSubclassOf && !func.returnType.startsWith("TSubclassOf"))))
                return;

            if (func.isProperty)
            {
                if (func.name.startsWith("Get"))
                {
                    let propname = func.name.substring(3);
                    if(!props.has(propname) && func.args.length == 0)
                    {
                        let compl = <CompletionItem>{
                                label: propname,
                                kind: CompletionItemKind.Field,
                                labelDetails: <CompletionItemLabelDetails>
                                {
                                    description: func.returnType,
                                },
                                commitCharacters: [".", ";", ","],
                                filterText: GetSymbolFilterText(context, func),
                        };

                        if (func.containingType)
                        {
                            if (func.containingType == scopeType)
                                compl.sortText = Sort.MemberProp_Direct;
                            else
                                compl.sortText = Sort.MemberProp_Parent;
                            compl.data = ["accessor", func.containingType.name, propname];
                        }
                        else
                        {
                            compl.sortText = Sort.GlobalProp;
                            compl.data = ["global_accessor", func.namespace.getQualifiedNamespace(), propname];
                        }

                        if (context.isTypeExpected(func.returnType))
                        {
                            if (func.containingType || !func.namespace.isRootNamespace())
                                context.completionsMatchingExpected.push(compl);

                            if (func.containingType && func.containingType == scopeType)
                                compl.sortText = Sort.MemberProp_Direct_Expected;
                            else if (func.containingType)
                                compl.sortText = Sort.MemberProp_Parent_Expected;
                            else
                                compl.sortText = Sort.GlobalProp_Expected;
                        }

                        if (context.isIncompleteNamespace)
                            compl.insertText = ":"+compl.label;
                        completions.push(compl);
                        props.add(propname);
                    }
                }

                if (func.name.startsWith("Set"))
                {
                    let propname = func.name.substring(3);
                    if(!props.has(propname) && func.args.length == 1 && func.returnType == "void")
                    {
                        let compl = <CompletionItem> {
                                label: propname,
                                kind: CompletionItemKind.Field,
                                labelDetails: <CompletionItemLabelDetails>
                                {
                                    description: func.args[0].typename,
                                },
                                commitCharacters: [".", ";", ","],
                                filterText: GetSymbolFilterText(context, func),
                                sortText: (func.containingType == scopeType) ? "a" : "b",
                        };

                        if (func.containingType)
                        {
                            if (func.containingType == scopeType)
                                compl.sortText = Sort.MemberProp_Direct;
                            else
                                compl.sortText = Sort.MemberProp_Parent;
                            compl.data = ["accessor", func.containingType.name, propname];
                        }
                        else
                        {
                            compl.sortText = Sort.GlobalProp;
                            compl.data = ["global_accessor", func.namespace.getQualifiedNamespace(), propname];
                        }

                        if (context.isTypeExpected(func.args[0].typename))
                        {
                            if (func.containingType || !func.namespace.isRootNamespace())
                                context.completionsMatchingExpected.push(compl);

                            if (func.containingType && func.containingType == scopeType)
                                compl.sortText = Sort.MemberProp_Direct_Expected;
                            else if (func.containingType)
                                compl.sortText = Sort.MemberProp_Parent_Expected;
                            else
                                compl.sortText = Sort.GlobalProp_Expected;
                        }

                        if (context.isIncompleteNamespace)
                            compl.insertText = ":"+compl.label;
                        completions.push(compl);
                        props.add(propname);
                    }
                }
            }

            if(!func.name.startsWith("op") && (!func.isBlueprintEvent || showEvents))
            {
                let commitChars = ["("];
                if (func.isConstructor)
                    GetTypenameCommitChars(context, func.name, commitChars);

                let compl = <CompletionItem>{
                        label: func.name,
                        kind: func.isBlueprintEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                        commitCharacters: commitChars,
                        filterText: GetSymbolFilterText(context, func),
                        sortText: (func.containingType == scopeType) ? "a" : "b",
                };

                if (func.containingType)
                {
                    if (func.containingType == scopeType)
                        compl.sortText = Sort.Method_Direct;
                    else
                        compl.sortText = Sort.Method_Parent;
                    compl.data = ["func", func.containingType.name, func.name, func.id];
                }
                else
                {
                    compl.sortText = Sort.Global;
                    compl.data = ["global_func", func.namespace.getQualifiedNamespace(), func.name, func.id];
                }

                if (context.isTypeExpected(func.returnType))
                {
                    if (func.containingType || !func.namespace.isRootNamespace() || func.isConstructor)
                        context.completionsMatchingExpected.push(compl);

                    if (func.containingType && func.containingType == scopeType)
                        compl.sortText = Sort.Method_Direct_Expected;
                    else if (func.containingType)
                        compl.sortText = Sort.Method_Parent_Expected;
                    else
                        compl.sortText = Sort.Global_Expected;
                }

                if (context.isIncompleteNamespace)
                    compl.insertText = ":"+compl.label;

                compl.labelDetails = <CompletionItemLabelDetails>
                {
                    detail: (func.args && func.args.length > 0) ? FunctionLabelWithParamsSuffix : FunctionLabelSuffix,
                };

                compl.command = <Command> {
                    title: "",
                    command: "angelscript.paren",
                };

                if (func.returnType && func.returnType != "void")
                {
                    if (func.determinesOutputTypeArgumentIndex != -1)
                        compl.labelDetails.description = "auto";
                    else
                        compl.labelDetails.description = func.returnType;

                    if (!typedb.IsPrimitive(func.returnType))
                        compl.commitCharacters.push(".");
                }

                completions.push(compl);
            }
        }
        else if (symbol instanceof typedb.DBType)
        {
            let dbtype : typedb.DBType = symbol;

            // Ignore template instantations for completion
            if (dbtype.isTemplateInstantiation)
                return;

            let kind : CompletionItemKind = CompletionItemKind.Class;
            if (dbtype.isEnum)
            {
                if (context.isInsideType && !context.priorTypeWasNamespace)
                    return;
                if (expectedSubclassOf)
                    return;
            }
            else
            {
                if (context.isInsideType && !context.priorTypeWasNamespace)
                    return;
                if (!context.maybeTypename && !expectedSubclassOf && (context.isSubExpression || context.isRightExpression) && !dbtype.isPrimitive)
                    return;
            }

            if (dbtype.isEnum)
            {
                if (!isTypeAccessibleFromScope(dbtype, context.scope))
                    return;
                let canCompleteEnum = CanCompleteSymbol(context, dbtype);

                // Allow completing to qualified enum values when appropriate
                if ((context.isSubExpression && !context.isFunctionDeclaration) || context.isRightExpression)
                {
                    if (context.expectedType == dbtype)
                    {
                        let enumIndex = 0;
                        dbtype.forEachSymbol(function (sym : typedb.DBSymbol)
                        {
                            if (!(sym instanceof typedb.DBProperty))
                                return;

                            enumIndex += 1;

                            let enumvalue = sym;
                            let canCompleteValue = CanCompleteTo(context, enumvalue.name);
                            if (!canCompleteEnum && !canCompleteValue)
                                return;

                            let enumstr = dbtype.name+"::"+enumvalue.name;
                            let complItem = <CompletionItem> {
                                    label: enumstr,
                                    kind: CompletionItemKind.EnumMember,
                                    data: ["enum", dbtype.name, enumvalue.name],
                            };

                            let isMaxValue = enumvalue.name.includes("MAX");

                            // Append the index of the enum value so they get sorted correctly
                            let sortNumber = enumIndex.toString().padStart(3, '0');
                            if (context.expectedType == dbtype)
                            {
                                if (isMaxValue)
                                {
                                    complItem.sortText =  Sort.EnumValue_Max_Expected+sortNumber;
                                }
                                else
                                {
                                    complItem.preselect = true;
                                    complItem.sortText = Sort.EnumValue_Expected+sortNumber;
                                    context.havePreselection = true;
                                }
                            }
                            else
                            {
                                if (isMaxValue)
                                    complItem.sortText = Sort.EnumValue_Max+sortNumber;
                                else
                                    complItem.sortText = Sort.EnumValue+sortNumber;
                            }

                            if (context.isIncompleteNamespace)
                                complItem.insertText = ":"+complItem.label;

                            if (canCompleteEnum)
                                completions.push(complItem);

                            // Add secondary item for if we're just typing the enum value's name
                            if (canCompleteValue && context.expectedType == dbtype && !isMaxValue)
                            {
                                completions.push({
                                    ...complItem,
                                    filterText: enumvalue.name,
                                });
                            }
                        });
                    }
                }

                if (canCompleteEnum)
                {
                    if (!context.expectedType || !context.expectedType.isEnum || context.expectedType == dbtype)
                    {
                        let commitChars : Array<string> = [];
                        if (!context.isIncompleteNamespace)
                            commitChars.push(":");

                        let complItem = <CompletionItem> {
                                label: dbtype.name,
                                kind: CompletionItemKind.Enum,
                                data: ["type", dbtype.name],
                                commitCharacters: commitChars,
                                filterText: GetSymbolFilterText(context, dbtype),
                                sortText: GetTypenamePriority(context, dbtype),
                        };

                        if (context.expectedType == dbtype)
                        {
                            complItem.sortText =  Sort.EnumName_Expected;
                            complItem.preselect = true;
                            context.havePreselection = true;
                        }

                        if (context.isIncompleteNamespace)
                            complItem.insertText = ":"+complItem.label;

                        completions.push(complItem);
                    }
                }
            }
            else
            {
                if (expectedSubclassOf)
                {
                    // If we're expecting a particular type of class, don't list other classes
                    if (!dbtype.inheritsFrom(expectedSubclassOf))
                        return;
                }

                if (CanCompleteSymbol(context, dbtype))
                {
                    if (!isTypeAccessibleFromScope(dbtype, context.scope))
                        return;

                    let commitChars : Array<string> = [];
                    GetTypenameCommitChars(context, dbtype.name, commitChars);

                    if (dbtype.isShadowingNamespace() && !context.isIncompleteNamespace)
                        commitChars.push(":");

                    let complItem = <CompletionItem> {
                            label: dbtype.name,
                            kind: kind,
                            data: ["type", dbtype.name],
                            commitCharacters: commitChars,
                            filterText: GetSymbolFilterText(context, dbtype),
                            sortText: GetTypenamePriority(context, dbtype),
                    };

                    if ((context.maybeTypename && context.typenameExpected && context.typenameExpected == dbtype.name) || expectedSubclassOf)
                    {
                        // We might be expecting a specific typename, in which case we should preselect it
                        complItem.sortText = Sort.Typename_Expected;
                        complItem.preselect = true;
                        context.havePreselection = true;
                    }

                    if (context.isIncompleteNamespace)
                        complItem.insertText = ":"+complItem.label;

                    completions.push(complItem);
                }
            }
        }
    });

    // Complete child namespaces
    if (curtype instanceof typedb.DBNamespace)
    {
        for (let [_, namespace] of curtype.childNamespaces)
        {
            if (!namespace.name || namespace.name.length == 0)
                continue;

            let kind : CompletionItemKind = CompletionItemKind.Module;
            if ((!context.isSubExpression && !context.isRightExpression) || context.maybeTypename || expectedSubclassOf)
            {
                if (namespace.isShadowingType())
                    continue;
            }

            if (CanCompleteSymbol(context, namespace))
            {
                if (!isNamespaceAccessibleFromScope(namespace, context.scope))
                    continue;

                let commitChars = [];
                if (!context.isIncompleteNamespace)
                    commitChars.push(":");

                let complItem = <CompletionItem> {
                        label: namespace.name,
                        kind: kind,
                        data: ["namespace", namespace.getQualifiedNamespace()],
                        commitCharacters: commitChars,
                        sortText: GetNamespacePriority(context, namespace),
                };

                if (namespace.isShadowingType() && context.expectedType && context.expectedType.name == namespace.name)
                {
                    if (context.expectedType.inheritsFrom("UActorComponent"))
                    {
                        // If we're expecting a component the namespace is high sort
                        complItem.sortText = Sort.Typename_Expected;
                        complItem.preselect = true;
                        context.havePreselection = true;
                    }
                }
                else if (context.maybeTypename && context.typenameExpected && context.typenameExpected == namespace.name)
                {
                    // We might be expecting a specific typename, in which case we should preselect it
                    complItem.sortText = Sort.Typename_Expected;
                    complItem.preselect = true;
                    context.havePreselection = true;
                }

                if (context.isIncompleteNamespace)
                    complItem.insertText = ":"+complItem.label;

                completions.push(complItem);
            }
        }
    }
}

export function AddMixinCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (!context.scope)
        return;
    if (context.priorType instanceof typedb.DBNamespace)
        return;

    // Not yet imported mixin functions
    let mixinsForType : typedb.DBType = context.priorType;
    if (!mixinsForType)
        mixinsForType = context.scope.getParentType();

    // Complete from available namespaces
    let checkNamespace = context.scope.getNamespace();
    while (checkNamespace)
    {
        checkNamespace.forEachSymbol(function (sym : typedb.DBSymbol)
        {
            if (sym instanceof typedb.DBMethod)
            {
                if (!sym.isMixin)
                    return;
                if (!CanCompleteSymbol(context, sym))
                    return;
                if (!isFunctionAccessibleFromScope(null, sym, context.scope))
                    return;
                if (sym.args && sym.args.length != 0 && mixinsForType.inheritsFrom(sym.args[0].typename))
                {
                    let compl = <CompletionItem>{
                        label: sym.name,
                        kind: sym.isBlueprintEvent ? CompletionItemKind.Event : CompletionItemKind.Method,
                        data: ["func_mixin", sym.namespace.getQualifiedNamespace(), sym.name, sym.id],
                        commitCharacters: ["("],
                        filterText: GetSymbolFilterText(context, sym),
                        sortText: Sort.Method_Parent,
                    };

                    compl.labelDetails = <CompletionItemLabelDetails>
                    {
                        detail: (sym.args && sym.args.length > 0) ? FunctionLabelWithParamsSuffix : FunctionLabelSuffix,
                    };

                    compl.command = <Command> {
                        title: "",
                        command: "angelscript.paren",
                    };

                    if (context.isTypeExpected(sym.returnType))
                    {
                        if (!checkNamespace.isRootNamespace() || sym.isConstructor)
                            context.completionsMatchingExpected.push(compl);
                    }

                    if (sym.returnType && sym.returnType != "void")
                    {
                        compl.labelDetails.description = sym.returnType;
                        if (!typedb.IsPrimitive(sym.returnType))
                            compl.commitCharacters.push(".");
                    }

                    completions.push(compl);
                }
            }
        });

        checkNamespace = checkNamespace.parentNamespace;
    }
}

function CanCompleteStringTo(completing : string, suggestion : string) : boolean
{
    if (completing.length == 0)
        return true;
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

function CanCompleteTo(context : CompletionContext, suggestion : string) : boolean
{
    if (context.completingSymbolLowerCase.length == 0)
        return true;

    if (context.completingSymbolGetter)
    {
        if (suggestion.startsWith("Get"))
            return suggestion.substr(3).toLowerCase().indexOf(context.completingSymbolGetter) != -1;
    }
    else if (context.completingSymbolSetter)
    {
        if (suggestion.startsWith("Set"))
            return suggestion.substr(3).toLowerCase().indexOf(context.completingSymbolSetter) != -1;
    }

    return suggestion.toLowerCase().indexOf(context.completingSymbolLowerCase) != -1;
}

function CanCompleteToOnlyStart(context : CompletionContext, suggestion : string) : boolean
{
    if (context.completingSymbolLowerCase.length == 0)
        return true;

    if (context.completingSymbolGetter)
    {
        if (suggestion.startsWith("Get"))
            return suggestion.substr(3).toLowerCase().startsWith(context.completingSymbolGetter);
    }
    else if (context.completingSymbolSetter)
    {
        if (suggestion.startsWith("Set"))
            return suggestion.substr(3).toLowerCase().startsWith(context.completingSymbolSetter);
    }

    return suggestion.toLowerCase().startsWith(context.completingSymbolLowerCase);
}

function CanCompleteSymbol(context : CompletionContext, symbol : typedb.DBSymbol | typedb.DBType | typedb.DBNamespace) : boolean
{
    if (symbol instanceof typedb.DBType)
    {
        if (symbol.keywords)
            return CanCompleteToOnlyStart(context, GetSymbolFilterText(context, symbol));
        return CanCompleteToOnlyStart(context, symbol.name);
    }
    else if (symbol instanceof typedb.DBNamespace)
    {
        return CanCompleteToOnlyStart(context, symbol.name);
    }
    else if (!symbol.containingType && symbol.namespace.isRootNamespace())
    {
        if (symbol.keywords)
            return CanCompleteToOnlyStart(context, GetSymbolFilterText(context, symbol));
        return CanCompleteToOnlyStart(context, symbol.name);
    }
    else
    {
        if (symbol.keywords)
            return CanCompleteTo(context, GetSymbolFilterText(context, symbol));
        return CanCompleteTo(context, symbol.name);
    }
}

function GetSymbolFilterText(context : CompletionContext, symbol : typedb.DBSymbol | typedb.DBType) : string | undefined
{
    if (!symbol.keywords)
        return undefined;
    return [symbol.name, ...symbol.keywords].join(" ");
}

function GetTypenamePriority(context : CompletionContext, type : typedb.DBType) : string
{
    if (CommonTypenames.has(type.name))
        return Sort.Typename_Common;
    if (type.declaredModule == context.scope.module.modulename)
        return Sort.Typename_SameFile;
    if (context.nearbyTypenames.has(type.name))
        return Sort.Typename_NearbyUsage;
    if (CommonObjectTypes.has(type.name))
        return Sort.Typename_CommonObject;
    return Sort.Typename;
}

function GetNamespacePriority(context : CompletionContext, namespace : typedb.DBNamespace) : string
{
    if (context.scope && context.scope.scopetype == scriptfiles.ASScopeType.Class)
        return Sort.Namespace_Unexpected;
    if (CommonNamespaces.has(namespace.name))
        return Sort.Typename_Common;

    let shadowType = namespace.getShadowedType();
    if (shadowType)
    {
        if (shadowType.declaredModule == context.scope.module.modulename)
            return Sort.Typename_SameFile;
        if (context.nearbyTypenames.has(shadowType.name))
            return Sort.Typename_NearbyUsage;
    }

    return Sort.Typename;
}

function GenerateCompletionContext(asmodule : scriptfiles.ASModule, offset : number) : CompletionContext
{
    let context = new CompletionContext();

    let contentOffset = 0;
    context.baseStatement = asmodule.getStatementAt(offset);
    context.completeOffset = offset;
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

    // Record what was on the line before this line, it can help determine appropriate completions
    let currentLine = asmodule.getPosition(offset).line;
    if (currentLine > 0)
    {
        context.previousLineContent = asmodule.textDocument.getText(
            Range.create(Position.create(currentLine-1, 0), Position.create(currentLine-1, 99999))
        );
    }

    if (!context.previousLineContent)
        context.previousLineContent = "";

    // Try to parse each candidate in the scope
    //  In reverse order, we prefer the longest candidate
    context.statement = new scriptfiles.ASStatement();
    for (let i = candidates.length-1; i >= 0; --i)
    {
        let candidate = candidates[i];
        context.statement.content = candidate.code;
        context.statement.end_offset = offset + 1;
        context.statement.start_offset = offset + 1 - candidate.code.length;
        context.isRightExpression = candidate.isRightExpression;
        context.rightOperator = candidate.rightOperator;
        context.priorType = null;
        context.priorTypeWasNamespace = false;
        context.expectedType = null;
        context.statement.ast = null;
        context.requiresPriorType = false;

        // Try to parse as a proper statement in the scope
        let baseType = context.scope.scopetype;

        // Inside a default statement, we always parse as if it's a code block
        if (context.baseStatement && context.baseStatement.ast && context.baseStatement.ast.type == scriptfiles.node_types.DefaultStatement)
            baseType = scriptfiles.ASScopeType.Code;
        // Candidates that are right expressions are always code snippets
        if (context.isRightExpression)
            baseType = scriptfiles.ASScopeType.Code;

        scriptfiles.ParseStatement(baseType, context.statement);

        // We might want to try to parse this as a global statement if we're in a declaration
        if (!context.statement.ast)
        {
            if (context.baseStatement && context.scope.declaration == context.baseStatement)
                scriptfiles.ParseStatement(context.scope.parentscope.scopetype, context.statement);
        }

        // Try to parse as an expression snippet instead
        if (!context.statement.ast && baseType != scriptfiles.ASScopeType.Code)
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
            context.rightOperator = candidate.rightOperator;
            context.priorType = null;
            context.priorTypeWasNamespace = false;
            context.expectedType = null;
            context.statement.ast = null;
            context.requiresPriorType = false;

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
            let baseType = context.scope.scopetype;

            // Inside a default statement, we always parse as if it's a code block
            if (context.baseStatement && context.baseStatement.ast && context.baseStatement.ast.type == scriptfiles.node_types.DefaultStatement)
                baseType = scriptfiles.ASScopeType.Code;

            // Try to parse as a proper statement in the scope
            scriptfiles.ParseStatement(baseType, context.subOuterStatement);

            // Try to parse as an expression snippet instead
            if (!context.subOuterStatement.ast)
                scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.subOuterStatement);

            if (!context.subOuterStatement.ast)
                continue;

            // If we managed to parse a statement, extract the prior expression from it
            context.subOuterFunctions = new Array<typedb.DBMethod>();
            scriptfiles.ResolveFunctionOverloadsFromExpression(context.scope, context.subOuterStatement.ast, context.subOuterFunctions);
            if (context.subOuterFunctions.length != 0)
                break;

            // Parse as a variable declaration if we can
            if (context.subOuterStatement.ast.type == scriptfiles.node_types.VariableDecl)
            {
                let dbVarType = typedb.LookupType(context.scope.getNamespace(), context.subOuterStatement.ast.typename.value);
                if (dbVarType
                    && (i == subCandidates.length-1)
                    && (!context.baseStatement
                        || !context.baseStatement.ast
                        || context.baseStatement.ast.type != scriptfiles.node_types.FunctionDecl
                        || !(context.baseStatement.next instanceof scriptfiles.ASScope)))
                {
                    if (context.subOuterStatement.ast.name || !context.scope.isInFunctionBody())
                    {
                        scriptfiles.ResolveFunctionOverloadsFromIdentifier(context.scope, dbVarType.name, context.subOuterFunctions);
                        if (context.subOuterFunctions.length != 0)
                            break;
                    }
                }
            }
        }

        // We couldn't find this as a function, try finding it as a specifier (eg `Meta = (|)`)
        if (!context.subOuterStatement.ast)
            context.outerAssignIdentifier = ExtractAssignmentIdentifierPreceding(content, subExprOffset);

        // Disambiguate if we have overloads available for the base method and the child override both
        scriptfiles.DisambiguateFunctionOverloadsFromOverriddenFunctions(context.subOuterFunctions);
    }

    // Try to parse the entire function statement we've found
    if (context.subOuterStatement)
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

    // If we have multiple functions that we could be completing inside, sort them based on overloads
    if (context.subOuterFunctions && context.subOuterFunctions.length > 1 && context.fullOuterStatement)
    {
        let argContext = GenerateCompletionArguments(context);
        let scoredFunctions = new Array<[typedb.DBMethod, number]>();

        for (let func of context.subOuterFunctions)
            scoredFunctions.push([func, ScoreMethodOverload(context, func, argContext)[0]]);

        scoredFunctions.sort(
            (first, second) => {
                if (first[1] > second[1])
                    return -1;
                else if (first[1] < second[1])
                    return 1;
                else
                    return 0;
            }
        );

        context.subOuterFunctions = [];
        for (let [func, score] of scoredFunctions)
            context.subOuterFunctions.push(func);
    }

    // If we're typing an argument to a function, record the most likely expected type
    if (context.subOuterFunctions && context.subOuterFunctions.length != 0 && context.subOuterArgumentIndex != -1
        && !context.expectedType && (!context.isRightExpression || (context.rightOperator == "=" && context.isSubExpression)))
    {
        let argContext = GenerateCompletionArguments(context);

        for (let candidateFunction of context.subOuterFunctions)
        {
            if (!candidateFunction.args)
                continue;

            if (argContext.currentArgumentName)
            {
                for (let arg of candidateFunction.args)
                {
                    if (arg.name == argContext.currentArgumentName)
                    {
                        let argType = typedb.LookupType(candidateFunction.namespace, arg.typename);
                        if (argType && !context.expectedType)
                        {
                            context.expectedType = argType;

                            // We no longer treat this is a right expression, because it's
                            // just the parameter name in front of us
                            if (context.isRightExpression && context.rightOperator == "=")
                            {
                                context.isRightExpression = false;
                            }
                        }
                    }
                }
            }

            let candidateArgumentIndex = context.subOuterArgumentIndex;
            if (candidateFunction.isMixin)
                candidateArgumentIndex += 1;

            if (candidateFunction.args.length <= candidateArgumentIndex)
                continue;
            let argType = typedb.LookupType(candidateFunction.namespace, candidateFunction.args[candidateArgumentIndex].typename);
            if (argType && !context.expectedType)
                context.expectedType = argType;
        }
    }

    // Resolve the assignment we're doing
    context.isAssignment = context.isRightExpression && !context.isSubExpression && context.rightOperator == "=";
    if (context.isRightExpression && context.statement && context.rightOperator
        && (context.rightOperator != "=" || !context.isSubExpression))
    {
        // Parse the statement in front of the operator sign to get its type
        context.leftStatement = new scriptfiles.ASStatement();
        let assignLeftOffset = context.statement.start_offset - 1 - contentOffset - context.rightOperator.length;

        // If we parsed the statement as a binary operator we should read the left side of the binary operation
        if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.BinaryOperation)
            assignLeftOffset = context.statement.start_offset + context.statement.ast.children[0].end - contentOffset - 1;

        let lvalueCandidates = ExtractExpressionPreceding(content, assignLeftOffset, ignoreTable, true);
        for (let i = lvalueCandidates.length-1; i >= 0; --i)
        {
            let candidate = lvalueCandidates[i];
            context.leftStatement.content = candidate.code;
            context.leftStatement.ast = null;
            context.leftStatement.end_offset = assignLeftOffset + 1 + contentOffset;
            context.leftStatement.start_offset = context.leftStatement.end_offset - candidate.code.length;

            scriptfiles.ParseStatement(scriptfiles.ASScopeType.Code, context.leftStatement);

            if (!context.leftStatement.ast && context.scope)
                scriptfiles.ParseStatement(context.scope.scopetype, context.leftStatement);

            if (!context.leftStatement.ast)
                continue;

            // If this is a variable declaration we expect the type of the variable
            if (context.leftStatement.ast.type == scriptfiles.node_types.VariableDecl)
            {
                context.leftType = typedb.LookupType(context.scope.getNamespace(), context.leftStatement.ast.typename.value);
                if (context.leftType)
                    break;
            }

            // If this is a default statement we expect the type of the variable
            switch (context.leftStatement.ast.type)
            {
                case scriptfiles.node_types.ReturnStatement:
                case scriptfiles.node_types.DefaultStatement:
                case scriptfiles.node_types.ElseStatement:
                {
                    let subNode = context.leftStatement.ast.children[0];
                    if (subNode)
                        context.leftType = scriptfiles.ResolveTypeFromExpression(context.scope, subNode);
                }
                break;
            }
            if (context.leftType)
                break;

            // If we managed to parse something, see if this results in a valid left type
            context.leftType = scriptfiles.ResolveTypeFromExpression(context.scope, context.leftStatement.ast);
            if (context.leftType)
                break;
        }

        if (!context.expectedType)
        {
            if (context.rightOperator == "&&" || context.rightOperator == "||" || context.rightOperator == "!")
            {
                // On the right of a boolean operator should always be a bool
                context.expectedType = typedb.GetTypeByName("bool");
            }
        }

        if (context.leftType && !context.expectedType)
        {
            if (context.rightOperator == "==" || context.rightOperator == "=" || context.rightOperator == "!=")
            {
                // Comparison operators that expect the same type
                context.expectedType = context.leftType;
            }
            else if (context.leftType.isPrimitive)
            {
                // Any non boolean operator on a primitive expects that same type
                context.expectedType = context.leftType;
            }
            else
            {
                // See if we have an operator overload for this
                let overloadMethod = scriptfiles.GetOverloadMethodForOperator(context.rightOperator);
                if (overloadMethod)
                {
                    let overloadFunc = context.leftType.findFirstSymbol(overloadMethod, typedb.DBAllowSymbol.Functions);
                    if (overloadFunc instanceof typedb.DBMethod)
                    {
                        if (overloadFunc.args && overloadFunc.args.length >= 1)
                        {
                            context.expectedType = typedb.LookupType(overloadFunc.namespace, overloadFunc.args[0].typename);
                        }
                    }
                }
            }
        }
    }
    else if (context.isRightExpression && context.rightOperator == "=")
    {
        let assignLeftOffset = context.statement.start_offset - contentOffset;
        context.outerAssignIdentifier = ExtractAssignmentIdentifierPreceding(content, assignLeftOffset);
    }

    // If we're editing inside an if statement, we might expect to be typing a bool
    if (context.fullOuterStatement && context.fullOuterStatement.ast)
    {
        if (context.fullOuterStatement.ast.type == scriptfiles.node_types.IfStatement
            || context.fullOuterStatement.ast.type == scriptfiles.node_types.WhileStatement)
        {
            if (!context.isRightExpression && !context.expectedType)
            {
                context.expectedType = typedb.GetTypeByName("bool");
            }
        }
    }

    // If we're typing all the way at the beginning of a for loop we probably want to write a typename
    if (context.fullOuterStatement && context.fullOuterStatement.ast
        && context.fullOuterStatement.ast.type == scriptfiles.node_types.ForLoop)
    {
        let outerNode = context.fullOuterStatement.ast;
        if (outerNode.children[0] && !outerNode.children[1] && !outerNode.children[2] && !outerNode.children[3])
        {
            if (outerNode.children[0].type == scriptfiles.node_types.Identifier)
                context.maybeTypename = true;
        }
    }

    // Record some data about the statement we parsed
    if (context.completingNode)
    {
        if (context.completingNode.type == scriptfiles.node_types.Typename)
            context.maybeTypename = true;
        if (context.isFunctionDeclaration && context.isSubExpression && context.completingNode == context.statement.ast)
            context.maybeTypename = true;
        if (context.completingNode == context.statement.ast && !context.isRightExpression && !context.isSubExpression && !context.isNamingSomethingNew)
            context.maybeTypename = true;
    }

    // If we're completing a typename inside a Cast<> we should expect the right one
    if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.CastOperation)
    {
        context.isRightExpression = false;
        context.maybeTypename = true;

        if (context.expectedType)
            context.typenameExpected = context.expectedType.name;
    }

    // Check if we're completing in a type, maybe invalid
    if (context.priorType)
        context.isInsideType = true;
    else if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.MemberAccess)
        context.isInsideType = true;
    else if (context.statement.ast && context.statement.ast.type == scriptfiles.node_types.NamespaceAccess)
        context.isInsideType = true;

    // If we're completing a statement like: 'TArray<...' we should consider it a typename
    if (context.isRightExpression && context.rightOperator == '<' && context.leftStatement)
    {
        let leftNode = context.leftStatement.ast;
        let leftAsType : typedb.DBType = null;
        let isCast = false;

        if (leftNode)
        {
            if (leftNode.type == scriptfiles.node_types.Typename)
            {
                leftAsType = typedb.LookupType(context.scope.getNamespace(), leftNode.value);
            }
            else if (leftNode.type == scriptfiles.node_types.VariableDecl)
            {
                if (!leftNode.name)
                    leftAsType = typedb.LookupType(context.scope.getNamespace(), leftNode.typename.value);
            }
            else if (leftNode.type == scriptfiles.node_types.CastOperation)
            {
                // Casts also always contain typenames
                isCast = true;
            }

            if ((leftAsType && leftAsType.isTemplateType()) || isCast)
            {
                context.isRightExpression = false;
                context.maybeTypename = true;
            }
        }
    }

    // If we're completing a 'case' statement, set the type we're switching on as the expected type
    if (context.statement && context.statement.ast && context.statement.ast.type == scriptfiles.node_types.CaseStatement)
    {
        // Find the switch statement preceding this scope
        if (context.scope)
        {
            let prevStatement = context.scope.previous;
            if (prevStatement instanceof scriptfiles.ASStatement)
            {
                if (prevStatement.ast && prevStatement.ast.type == scriptfiles.node_types.SwitchStatement)
                {
                    if (!context.expectedType && prevStatement.ast.children[0])
                    {
                        context.expectedType = scriptfiles.ResolveTypeFromExpression(context.scope.parentscope, prevStatement.ast.children[0]);
                    }
                }
            }
        }
    }

    // If the completion was triggered by a trigger character, we can only do prior-type completions
    let completionCharacter = content[offset-contentOffset];
    if (completionCharacter == ".")
    {
        context.completingDot = true;
        context.requiresPriorType = true;
    }
    else if (completionCharacter == ":")
    {
        context.completingNamespace = true;
        context.requiresPriorType = true;
    }

    // Pre-massage completing symbol
    if (context.completingSymbol)
    {
        context.completingSymbolLowerCase = context.completingSymbol.toLowerCase();
        if (context.completingSymbolLowerCase.startsWith("get"))
            context.completingSymbolGetter = context.completingSymbolLowerCase.substr(3);
        else if (context.completingSymbolLowerCase.startsWith("set"))
            context.completingSymbolSetter = context.completingSymbolLowerCase.substr(3);
    }
    else
    {
        context.completingSymbolLowerCase = "";
    }

    // Mark which types have been used as local variables in the current function,
    // or as class members in the current class. This way we can prioritize them during completion
    if (context.scope)
    {
        let inClass = context.scope.getParentType();
        if (inClass)
        {
            inClass.forEachSymbol(function (symbol : typedb.DBSymbol)
            {
                if (symbol instanceof typedb.DBProperty)
                    context.nearbyTypenames.add(symbol.typename);
            }, false);
        }

        let functionScope = context.scope.getParentFunctionScope();
        if (functionScope)
        {
            for (let localVariable of functionScope.variables)
                context.nearbyTypenames.add(localVariable.typename);
        }
    }

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
            context.priorTypeWasNamespace = false;
            context.requiresPriorType = true;
            if (context.priorType)
            {
                if (context.priorType.isEnum)
                    context.priorType = null;
                return true;
            }
            else
            {
                return false;
            }
        }
        break;
        case scriptfiles.node_types.NamespaceAccess:
        {
            if (!node.children[0])
                return false;

            context.priorExpression = node.children[0];
            if (node.children[1])
                context.completingSymbol = node.children[1].value;
            else
                context.completingSymbol = "";

            context.completingNode = node.children[1];

            let fullNamespace = scriptfiles.CollapseNamespaceFromNode(node.children[0]);

            // We could be calling a function in the Super class
            if (fullNamespace == "Super" && context.scope.getParentType())
                context.priorType = context.scope.getParentType().getSuperType();

            // We could be typing an enum value
            if (!context.priorType)
            {
                let enumType = typedb.LookupType(context.scope.getNamespace(), fullNamespace);
                if (enumType && enumType.isEnum)
                    context.priorType = enumType;
            }

            // We could be typing something in a namespace
            if (!context.priorType)
                context.priorType = typedb.LookupNamespace(context.scope.getNamespace(), fullNamespace);

            context.priorTypeWasNamespace = true;
            context.requiresPriorType = true;
            if (context.priorType)
            {
                if (node.incomplete_colon)
                    context.isIncompleteNamespace = true;
                context.completingNamespace = true;
                return true;
            }
            else
            {
                return false;
            }
        }
        break;
        case scriptfiles.node_types.BinaryOperation:
            context.isRightExpression = true;
            context.rightOperator = node.operator;
            return ExtractPriorExpressionAndSymbol(context, node.children[1]);
        break;
        case scriptfiles.node_types.UnaryOperation:
            if (scriptfiles.IsPrimitiveLiteralNode(node.children[0]))
            {
                // Unary operations on literals are not considered right-expressions
                context.isRightExpression = false;
                context.rightOperator = null;
            }
            else
            {
                context.isRightExpression = true;
                context.rightOperator = node.operator;
            }
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.PostfixOperation:
            context.isRightExpression = true;
            context.rightOperator = node.operator;
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.ElseStatement:
        case scriptfiles.node_types.DefaultCaseStatement:
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.ReturnStatement:
            context.isRightExpression = true;
            if (context.scope)
            {
                let dbFunc = context.scope.getParentFunction();
                if (dbFunc && dbFunc.returnType)
                    context.expectedType = typedb.LookupType(dbFunc.namespace, dbFunc.returnType);
            }
            return ExtractPriorExpressionAndSymbol(context, node.children[0]);
        case scriptfiles.node_types.CaseStatement:
            if (node.children[1])
            {
                return ExtractPriorExpressionAndSymbol(context, node.children[1]);
            }
            else
            {
                // We have to pull apart the namespace access a bit
                if (node.has_statement && node.children[0] && node.children[0].type == scriptfiles.node_types.NamespaceAccess)
                {
                    let nsNode = node.children[0];
                    if (nsNode.children[1])
                    {
                        // We are completing off of the colon that might either start a new statement, or is part of the namespace access
                        context.priorExpression = nsNode.children[0];
                        context.completingSymbol = "";
                        context.completingNode = null;

                        let typeName = nsNode.children[0].value;
                        if (nsNode.children[1].value)
                            typeName += "::"+nsNode.children[1].value;

                        context.priorType = typedb.LookupType(context.scope.getNamespace(), typeName);
                        context.priorTypeWasNamespace = true;
                        context.requiresPriorType = true;
                        context.isIncompleteNamespace = true;
                        context.isRightExpression = !!context.priorType;
                        return true;
                    }
                }

                context.isRightExpression = true;
                return ExtractPriorExpressionAndSymbol(context, node.children[0]);
            }
        break;
        case scriptfiles.node_types.VariableDecl:
        {
            if (node.typename)
            {
                let declType = typedb.LookupType(context.scope.getNamespace(), node.typename.value);
                context.priorExpression = null;
                if (node.name)
                {
                    context.isNamingSomethingNew = !!declType;
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
            context.isNamingSomethingNew = true;
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
                context.isNamingSomethingNew = true;
                context.isNamingNewClass = true;
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
            context.isNamingSomethingNew = true;
            if (node.type == scriptfiles.node_types.StructDefinition)
                context.isNamingNewStruct = true;
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
            context.isNamingSomethingNew = false;
            if (node.children && node.children[0])
            {
                context.completingNode = node.children[0];
                context.completingSymbol = node.children[0].value;
            }
            return true;
        }
        break;
        case scriptfiles.node_types.IncompleteAccessSpecifier:
        {
            context.priorExpression = null;
            context.priorType = null;
            context.isNamingSomethingNew = false;
            context.isTypingAccessSpecifier = true;
            return true;
        }
        break;
        case scriptfiles.node_types.AccessDeclaration:
        {
            if (!node.children || node.children.length == 0)
            {
                context.priorExpression = null;
                context.priorType = null;
                context.isNamingSomethingNew = true;
                context.completingNode = node.name;
                context.completingSymbol = node.name.value;
                return true;
            }
        }
        break;
        case scriptfiles.node_types.CastOperation:
        {
            if (node.children && node.children[0] && !node.children[1])
            {
                context.priorExpression = null;
                context.completingSymbol = node.children[0].value;
                context.completingNode = node.children[0];
                context.priorType = null;
                context.maybeTypename = true;
                return true;
            }
        }
        break;
    }

    return false;
}

function ExtractExpressionPreceding(content : string, offset : number, ignoreTable : Array<number>, initialExpectingTerm = false) : Array<CompletionExpressionCandidate>
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
    let expectingTerm = initialExpectingTerm;
    let haveFirstIdentifier = false;

    let ignoreTableIndex = ignoreTable ? ignoreTable.length-2 : -1;

    for (; exprStartOffset >= 0; --exprStartOffset)
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
                        if (c)
                        {
                            c.isRightExpression = true;
                            c.rightOperator = "<";
                        }

                        if (exprStartOffset >= 4
                            && content[exprStartOffset-4] == "C"
                            && content[exprStartOffset-3] == "a"
                            && content[exprStartOffset-2] == "s"
                            && content[exprStartOffset-1] == "t")
                        {
                            // This is a partial Cast<, keep parsing
                        }
                        else
                        {
                            // This must be an operator, stop parse
                            endParse = true;
                        }
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
                    {
                        c.isRightExpression = true;
                        c.rightOperator = ">";
                    }
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
                    {
                        c.isRightExpression = true;
                        c.rightOperator = ":";
                    }
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
                    {
                        c.isRightExpression = true;
                        c.rightOperator = char;

                        // Could be a compound operator
                        if (exprStartOffset > 0)
                        {
                            let prevChar = content[exprStartOffset-1];
                            switch (prevChar)
                            {
                                case '+':
                                case '-':
                                case '*':
                                case '/':
                                case '=':
                                case '>':
                                case '<':
                                case '!':
                                case '%':
                                case '^':
                                case '&':
                                case '|':
                                    c.rightOperator = prevChar + c.rightOperator;
                                break;
                            }
                        }

                        // Could be a unary operator as well
                        switch (c.rightOperator)
                        {
                            case '+':
                            case '-':
                            {
                                lastExprStartOffset += 1;
                                let unary = addCandidate(0);
                                unary.isRightExpression = true;
                                unary.rightOperator = c.rightOperator;
                            }
                            break;
                        }
                    }
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

function ExtractIdentifierPreceding(content : string, offset : number) : string | null
{
    let identifierEndOffset = -1;
    let identifierStartOffset = offset-1;
    for (; identifierStartOffset >= 0; --identifierStartOffset)
    {
        let char = content[identifierStartOffset];
        let charCode = content.charCodeAt(identifierStartOffset);

        let isIdentifierChar = false;
        if (charCode > 47 && charCode < 58)
            isIdentifierChar = true;
        else if (charCode > 64 && charCode < 91)
            isIdentifierChar = true;
        else if (charCode > 96 && charCode < 123)
            isIdentifierChar = true;
        else if (charCode == 95)
            isIdentifierChar = true;

        if (identifierEndOffset == -1)
        {
            if (char == ' ' || char == '\t')
                continue;

            if (isIdentifierChar)
                identifierEndOffset = identifierStartOffset+1;
            else
                return null;
        }
        else
        {
            if (!isIdentifierChar)
                return content.substring(identifierStartOffset+1, identifierEndOffset);
        }
    }

    return null;
}

function ExtractAssignmentIdentifierPreceding(content : string, offset : number) : string | null
{
    let scanOffset = offset-1;
    for (; scanOffset >= 0; --scanOffset)
    {
        let char = content[scanOffset];

        if (char == ' ' || char == '\t')
            continue;

        if (char == '=')
        {
            return ExtractIdentifierPreceding(content, scanOffset);
        }
        else
        {
            return null;
        }
    }

    return null;
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
    else if (inScope.scopetype == scriptfiles.ASScopeType.LiteralAsset)
    {
        return true;
    }
    else if (inScope.scopetype != scriptfiles.ASScopeType.Class)
    {
        return false;
    }
    return true;
}

export function resolveModuleIsolation(module : string) : string
{
    let existing = ResolvedModuleDependencyIsolations.get(module);
    if (existing === undefined)
    {
        let isolate = "";

        for (let restriction of IsolateRegexes)
        {
            let match = restriction.exec(module);
            if (match)
            {
                isolate = match[0];
                break;
            }
        }

        for (let restriction of UnisolateRegexes)
        {
            let match = restriction.exec(module);
            if (match)
            {
                isolate += "__unisolate";
                break;
            }
        }

        ResolvedModuleDependencyIsolations.set(module, isolate);
        return isolate;
    }
    else
    {
        return existing;
    }
}

export function isValidModuleDependency(module : string, dependencyModule : string)
{
    if (!dependencyModule)
        return true;

    let dependencyIsolation = resolveModuleIsolation(dependencyModule);
    if (dependencyIsolation)
    {
        let moduleIsolation = resolveModuleIsolation(module);
        if (dependencyIsolation != moduleIsolation)
        {
            if (moduleIsolation.endsWith("__unisolate"))
                return true;
            if (!moduleIsolation.startsWith(dependencyIsolation))
                return false;
        }
    }

    return true;
}

function isPropertyAccessibleFromScope(curtype : typedb.DBType | typedb.DBNamespace, prop : typedb.DBProperty, inScope : scriptfiles.ASScope) : boolean
{
    if (curtype instanceof typedb.DBNamespace)
    {
        // Global variables without a namespace are only accessible from the same module
        if (curtype === typedb.GetRootNamespace()
            && prop.declaredModule
            && prop.declaredModule != inScope.module.modulename)
        {
            return false;
        }

        if (prop.declaredModule && !isValidModuleDependency(inScope.module.modulename, prop.declaredModule))
            return false;

        return true;
    }

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
            if (!curtype || dbtype.name != prop.containingType.name)
                return false;
        }
        else if (prop.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(prop.containingType.name))
                return false;
        }
    }
    else if (prop.accessSpecifier)
    {
        let [readable, writable, editable] = prop.accessSpecifier.getAccess(inScope.getParentType(), inScope.getParentFunction());
        if (!readable && !editable)
            return false;
        else if (!readable && !isEditScope(inScope))
            return false;
        else if (!editable && isEditScope(inScope))
            return false;
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

function isFunctionAccessibleFromScope(curtype : typedb.DBType | typedb.DBNamespace, func : typedb.DBMethod, inScope : scriptfiles.ASScope) : boolean
{
    if (!func.containingType)
    {
        if (func.declaredModule)
        {
            if (func.isLocal || (func.namespace.isRootNamespace() && !scriptfiles.GetScriptSettings().exposeGlobalFunctions && !func.isMixin))
            {
                if (func.declaredModule != inScope.module.modulename)
                    return false;
            }

            if (!isValidModuleDependency(inScope.module.modulename, func.declaredModule))
                return false;
        }
        return true;
    }

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
            if (!curtype || dbtype.name != func.containingType.name)
                return false;
        }
        else if (func.isProtected)
        {
            // Needs to be in a subclass to have access
            if (!curtype || !dbtype.inheritsFrom(func.containingType.name))
                return false;
        }
    }
    else if (func.accessSpecifier)
    {
        let [readable, writable, editable] = func.accessSpecifier.getAccess(inScope.getParentType(), inScope.getParentFunction());
        if (!readable && !editable && !writable)
            return false;
        else if (!editable && isEditScope(inScope))
            return false;
        else if (!readable && !writable && !isEditScope(inScope))
            return false;
        else if (!writable && !func.isConst)
            return false;
    }

    if (func.isDefaultsOnly)
    {
        if (!isEditScope(inScope))
            return false;
    }

    return true;
}

function isTypeAccessibleFromScope(type : typedb.DBType, inScope : scriptfiles.ASScope) : boolean
{
    if (!type.declaredModule)
        return true;
    if (!isValidModuleDependency(inScope.module.modulename, type.declaredModule))
        return false;
    return true;
}

function isNamespaceAccessibleFromScope(namespace : typedb.DBNamespace, inScope : scriptfiles.ASScope) : boolean
{
    let allowedNamespace = false;
    if (!namespace.declarations)
        return true;
    for (let decl of namespace.declarations)
    {
        if (!decl.declaredModule || isValidModuleDependency(inScope.module.modulename, decl.declaredModule))
            allowedNamespace = true;
    }
    if (!allowedNamespace)
        return false;
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
    let escape_sequence = false;

    let inFormatString = false;
    let inFormatExpression = false;

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

        // Format string sections
        if (inFormatString)
        {
            if (inFormatExpression)
            {
                if (char == '}')
                {
                    inFormatExpression = false;
                    ignoreTable.push(index);
                }
            }
            else
            {
                if (char == '{')
                {
                    if (index+1 < count && code[index+1] == '{')
                    {
                        ++index;
                        continue;
                    }

                    inFormatExpression = true;
                    ignoreTable.push(index);
                }
            }
        }

        // Strings
        if (char == '"' && !sq_string)
        {
            if (dq_string)
            {
                if (!escape_sequence)
                {
                    if (!inFormatExpression)
                        ignoreTable.push(index+1);
                    dq_string = false;
                    inFormatString = false;
                    inFormatExpression = false;
                }
                else
                {
                    escape_sequence = false;
                }
            }
            else
            {
                ignoreTable.push(index);
                dq_string = true;

                if (index > 0 && code[index-1] == 'f')
                    inFormatString = true;
            }
        }
        else if (dq_string)
        {
            if (char == '\\')
                escape_sequence = !escape_sequence;
            else
                escape_sequence = false;
            continue;
        }

        if (char == "'" && !dq_string)
        {
            if (sq_string)
            {
                if (!escape_sequence)
                {
                    ignoreTable.push(index+1);
                    sq_string = false;
                }
                else
                {
                    escape_sequence = false;
                }
            }
            else
            {
                ignoreTable.push(index);
                sq_string = true;
            }
        }
        else if (sq_string)
        {
            if (char == '\\')
                escape_sequence = !escape_sequence;
            else
                escape_sequence = false;
            continue;
        }

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
    let textEditsForEvent = new Array<TextEdit>();
    if (!hasUFunctionMacro)
    {
        textEditsForEvent.push(TextEdit.insert(
            Position.create(position.line, 0),
            currentIndent+"UFUNCTION(BlueprintOverride)\n"
        ))
    }

    let foundOverrides = new Set<string>();
    typeOfScope.forEachSymbol(function (sym : typedb.DBSymbol)
    {
        if (!(sym instanceof typedb.DBMethod))
            return;

        let method = sym;
        let parentMethod = null;
        if (method.containingType == typeOfScope)
        {
            let parentType = typeOfScope.getSuperType();
            if (parentType)
            {
                let parentSymbol = parentType.findFirstSymbol(method.name, typedb.DBAllowSymbol.Functions);
                if (parentSymbol instanceof typedb.DBMethod)
                    parentMethod = parentSymbol;
            }
        }
        else
        {
            parentMethod = method;
        }

        let includeReturnType = false;
        let includeParamsOnly = false;

        if (method.containingType == typeOfScope && !parentMethod)
            return;
        if (method.name && CanCompleteTo(context, method.name))
            includeParamsOnly = true;
        if (method.returnType && CanCompleteTo(context, method.returnType))
            includeReturnType = true;
        if (method.isPrivate)
            return;

        if (!includeParamsOnly && !includeReturnType)
            return;

        if (sym.containingType.isUnrealType() && !method.isBlueprintEvent)
            return;
        if (foundOverrides.has(method.name))
            return;

        foundOverrides.add(method.name);
        if (method.isFinal)
            return;

        let complStr = GetDeclarationSnippet(method, currentIndent, false);
        let complEdits = textEdits;

        if (method.isBlueprintEvent)
            complEdits = complEdits.concat(textEditsForEvent);

        let superStr = "";
        if (parentMethod && parentMethod.declaredModule && (!parentMethod.returnType || parentMethod.returnType == "void" || parentMethod.hasMetaData("RequireSuperCall")))
        {
            superStr += "Super::"+method.name+"(";
            for (let i = 0; i < method.args.length; ++i)
            {
                if (i != 0)
                    superStr += ", ";
                superStr += method.args[i].name;
            }
            superStr += ");";

            if (parentMethod.returnType && parentMethod.returnType != "void")
                superStr = "return " + superStr;
            else
                superStr += "\n"+currentIndent;
        }

        if (includeParamsOnly)
        {
            if (!hasReturnType)
            {
                complEdits = complEdits.concat(
                    TextEdit.replace(
                        Range.create(
                            Position.create(position.line, 0),
                            Position.create(position.line, position.character-context.completingSymbol.length),
                        ),
                        currentIndent + method.returnType+" "
                    )
                );
            }

            completions.push({
                label: method.returnType+" "+method.name+"(...)",
                filterText: method.name,
                insertText: complStr+"{\n"+currentIndent+superStr,
                kind: CompletionItemKind.Snippet,
                data: ["decl_snippet", method.containingType.name, method.name, method.id],
                additionalTextEdits: complEdits,
                sortText: Sort.Method_Override_Snippet,
            });
        }
        else if (includeReturnType)
        {
            completions.push({
                label: method.returnType+" "+method.name+"(...)",
                insertText: method.returnType+" "+complStr+"{\n"+currentIndent+superStr,
                kind: CompletionItemKind.Snippet,
                data: ["decl_snippet", method.containingType.name, method.name, method.id],
                additionalTextEdits: complEdits,
                sortText: Sort.Method_Override_Snippet,
            });
        }
    });
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
    if (!method.isBlueprintEvent)
        complStr += " override";
    if (!method.isBlueprintEvent && method.isProperty && method.declaredModule)
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
        return null;

    let dataArray = item.data as Array<any>;
    let kind = dataArray[0];

    if (kind == "type")
    {
        let type = typedb.GetTypeByName(dataArray[1]);
        if (type == null)
            return null;
        if (type.documentation)
            item.documentation = type.documentation.replace(/\n/g,"\n\n");
        return item;
    }
    else if (kind == "namespace")
    {
        let type = typedb.LookupNamespace(null, dataArray[1]);
        if (type == null)
            return null;
        if (type.documentation)
            item.documentation = type.documentation.replace(/\n/g,"\n\n");
        return item;
    }
    else if (kind == "enum" || kind == "prop" || kind == "global_prop")
    {
        let type : typedb.DBType | typedb.DBNamespace;
        if (kind == "global_prop")
            type = typedb.LookupNamespace(null, dataArray[1]);
        else
            type = typedb.GetTypeByName(dataArray[1]);
        if (type == null)
            return null;

        if (type == null)
            return null;
        let prop = type.findFirstSymbol(dataArray[2], typedb.DBAllowSymbol.Properties);
        if (prop instanceof typedb.DBProperty)
        {
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript_snippet\n"+NoBreakingSpaces(prop.format())+"\n```\n\n",
            };
            if (prop.documentation)
                item.documentation.value += "\n\n"+FormatPropertyDocumentation(prop.documentation)+"\n\n";

            if (kind == "prop")
            {
                item.labelDetails = <CompletionItemLabelDetails>
                {
                    description: prop.typename,
                };
            }
        }
    }
    else if (kind == "accessor" || kind == "global_accessor")
    {
        let type : typedb.DBType | typedb.DBNamespace;
        if (kind == "global_accessor")
            type = typedb.LookupNamespace(null, dataArray[1]);
        else
            type = typedb.GetTypeByName(dataArray[1]);
        if (type == null)
            return null;

        let getFunc = type.findFirstSymbol("Get"+dataArray[2], typedb.DBAllowSymbol.Functions) as typedb.DBMethod;
        let setFunc = type.findFirstSymbol("Set"+dataArray[2], typedb.DBAllowSymbol.Functions) as typedb.DBMethod;

        let docStr = "";
        if (getFunc)
        {
            docStr += "```angelscript_snippet\n"+getFunc.returnType+"\xa0"+dataArray[2]+"\n```\n\n";
            item.labelDetails = <CompletionItemLabelDetails>
            {
                description: getFunc.returnType,
            };
        }
        else if (setFunc && setFunc.args && setFunc.args.length >= 1)
        {
            docStr += "```angelscript_snippet\n"+setFunc.args[0].typename+"\xa0"+dataArray[2]+"\n```\n\n";
            item.labelDetails = <CompletionItemLabelDetails>
            {
                description: setFunc.args[0].typename,
            };
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
    else if (kind == "func" || kind == "func_mixin" || kind == "global_func")
    {
        let type : typedb.DBType | typedb.DBNamespace;
        if (kind == "global_func" || kind == "func_mixin")
            type = typedb.LookupNamespace(null, dataArray[1]);
        else
            type = typedb.GetTypeByName(dataArray[1]);
        if (type == null)
            return null;

        let func : typedb.DBMethod = null;
        for (let checkMethod of type.findSymbols(dataArray[2]))
        {
            if (checkMethod instanceof typedb.DBMethod)
            {
                if (checkMethod.id == dataArray[3])
                {
                    func = checkMethod;
                    break;
                }
                else if (!func)
                {
                    func = checkMethod;
                }
            }
        }

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
                item.documentation.value += "\n\n"+FormatFunctionDocumentation(doc, func, null, false);

            item.labelDetails = <CompletionItemLabelDetails>
            {
                detail: (func.args && func.args.length > 0) ? FunctionLabelWithParamsSuffix : FunctionLabelSuffix,
            };

            item.command = <Command> {
                title: "",
                command: "angelscript.paren",
            };

            if (func.returnType && func.returnType != "void")
                item.labelDetails.description = func.returnType;
        }
    }
    else if (kind == "decl_snippet")
    {
        let type = typedb.GetTypeByName(dataArray[1]);
        if (type == null)
            return null;
        let func = type.getMethodWithIdHint(dataArray[2], dataArray[3]);
        if (func)
        {
            let complStr = NoBreakingSpaces(GetDeclarationSnippet(func, null, true));
            item.documentation = <MarkupContent> {
                kind: MarkupKind.Markdown,
                value: "```angelscript_snippet\n"+complStr+"\n```\n\n",
            };

            let doc = func.findAvailableDocumentation();
            if (doc)
                item.documentation.value += "\n\n"+FormatFunctionDocumentation(doc, func, null, false);
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
    if (context.statement.ast.type == scriptfiles.node_types.ReturnStatement)
        nsNode = context.statement.ast.children[0];
    if (nsNode.type != scriptfiles.node_types.NamespaceAccess)
        return;
    if (!nsNode.children[0] || nsNode.children[0].value != 'Super')
        return;

    let scopeFunction = context.scope.getParentFunction();
    let scopeType = context.scope.getParentType();
    if (!scopeType || !scopeFunction)
        return;

    let superType = scopeType.getSuperType();
    if (!superType)
        return;

    let superFunction = superType.findFirstSymbol(scopeFunction.name, typedb.DBAllowSymbol.Functions);
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

    context.havePreselection = true;
    completions.push({
        label: "Super::"+scopeFunction.name+"(...)",
        filterText: scopeFunction.name+"(...)",
        insertText: insertText,
        kind: CompletionItemKind.Snippet,
        preselect: true,
        sortText: Sort.Snippet,
    });
}

export function AddMathShortcutCompletions(context : CompletionContext, completions : Array<CompletionItem>)
{
    if (!CompletionSettings.mathCompletionShortcuts)
        return;

    let mathNamespace = typedb.LookupNamespace(null, "Math");
    if (!mathNamespace)
        mathNamespace = typedb.LookupNamespace(null, "FMath");
    if (!mathNamespace)
        return;

    if (context.isIncompleteNamespace)
        return;

    let unexpectedCompletions = new Array<CompletionItem>();
    let completionNames = new Set<string>();

    mathNamespace.forEachSymbol(function (symbol : typedb.DBSymbol)
    {
        if (!(symbol instanceof typedb.DBMethod))
            return;
        let func = symbol;
        if (!CanCompleteToOnlyStart(context, func.name))
            return;

        let commitChars = ["("];

        let compl = <CompletionItem>{
            label: mathNamespace.name+"::"+func.name,
            kind: CompletionItemKind.Method,
            data: ["global_func", mathNamespace.name, func.name, func.id],
            commitCharacters: commitChars,
            filterText: func.name,
            sortText: Sort.Math_Shortcut,
        };

        compl.labelDetails = <CompletionItemLabelDetails>
        {
            detail: (func.args && func.args.length > 0) ? FunctionLabelWithParamsSuffix : FunctionLabelSuffix,
        };

        compl.command = <Command> {
            title: "",
            command: "angelscript.paren",
        };

        if (func.returnType && func.returnType != "void")
        {
            compl.labelDetails.description = func.returnType;

            if (!typedb.IsPrimitive(func.returnType))
                compl.commitCharacters.push(".");
        }

        if (context.expectedType && !context.isTypeExpected(func.returnType))
        {
            unexpectedCompletions.push(compl);
            return;
        }

        completions.push(compl);
        completionNames.add(compl.label);
    });

    // Any functions where we _don't_ have an expected overload for, add them still
    for (let compl of unexpectedCompletions)
    {
        if (completionNames.has(compl.label))
            continue;
        completions.push(compl);
    }
}

function AddCompletionsFromAccessSpecifiers(context : CompletionContext, completions : Array<CompletionItem>) : boolean
{
    if (context.isTypingAccessSpecifier)
    {
        let scopeType = context.scope.getParentType();
        if (scopeType && scopeType.acccessSpecifiers)
        {
            for (let spec of scopeType.acccessSpecifiers)
            {
                let compl = <CompletionItem>{
                    label: spec.name,
                    kind: CompletionItemKind.Keyword,
                };
                completions.push(compl);
            }
        }

        return true;
    }
    else if (context.baseStatement && context.baseStatement.ast
        && context.baseStatement.ast.type == scriptfiles.node_types.AccessDeclaration)
    {
        // Add completions for relevant keywords
        AddCompletionsFromKeywordList(context, [
            "private", "protected", "readonly", "editdefaults", "inherited"
        ], completions);

        // Add completions for all types
        for (let [_, dbtype] of typedb.GetAllTypesById())
        {
            // Ignore template instantations for completion
            if (dbtype.isTemplateInstantiation)
                continue;
            if (dbtype.isEnum)
                continue;

            if (CanCompleteSymbol(context, dbtype))
            {
                let complItem = <CompletionItem> {
                        label: dbtype.name,
                        kind: CompletionItemKind.Class,
                        data: ["type", dbtype.name],
                        commitCharacters: [",", ";"],
                        sortText: Sort.Typename,
                };

                completions.push(complItem);
            }
        }

        // Add completions for global namespaces
        for (let [_, ns] of typedb.GetRootNamespace().childNamespaces)
        {
            if (CanCompleteSymbol(context, ns))
            {
                let complItem = <CompletionItem> {
                        label: ns.name,
                        kind: CompletionItemKind.Module,
                        data: ["namespace", ns.getQualifiedNamespace()],
                        commitCharacters: [",", ";"],
                        sortText: Sort.Typename,
                };

                completions.push(complItem);
            }
        }

        // Add completions for all global functions
        let checkNamespace = context.scope.getNamespace();
        while (checkNamespace)
        {
            checkNamespace.forEachSymbol(function (sym : typedb.DBSymbol)
            {
                if (sym instanceof typedb.DBMethod)
                {
                    let compl = <CompletionItem>{
                        label: sym.name,
                        kind: CompletionItemKind.Method,
                        data: ["global_func", sym.namespace.getQualifiedNamespace(), sym.name, sym.id],
                        commitCharacters: [",", ";"],
                        sortText: Sort.Unimported,
                    };

                    compl.labelDetails = <CompletionItemLabelDetails>
                    {
                        detail: (sym.args && sym.args.length > 0) ? FunctionLabelWithParamsSuffix : FunctionLabelSuffix,
                    };

                    if (sym.returnType && sym.returnType != "void")
                        compl.labelDetails.description = sym.returnType;

                    completions.push(compl);
                }
            });

            checkNamespace = checkNamespace.parentNamespace;
        }

        return true;
    }
    else
    {
        return false;
    }
}

export function HandleFloatLiteralHelper(asmodule : scriptfiles.ASModule) : Promise<WorkspaceEdit>
{
    if (asmodule.lastEditStart == -1)
        return;
    if (!CompletionSettings.correctFloatLiteralsWhenExpectingDoublePrecision)
        return;

    // If we've just edited in a float literal we might want to auto-replace it with a
    // double literal so help people's muscle memory catch up.
    let areaStart = Math.max(asmodule.lastEditStart - 10, 0);
    let editedString = asmodule.content.substring(
        areaStart,
        Math.min(asmodule.lastEditEnd, asmodule.content.length),
    );

    let matches = Array.from(editedString.matchAll(/([0-9]+)\.([0-9])*f/g));
    if (!matches || matches.length == 0)
        return;

    let match = matches[matches.length - 1];
    let matchStart = areaStart + match.index;
    let matchEnd = matchStart + match[0].length;

    // Don't do anything if we're not actually editing the float literal
    if (matchEnd < asmodule.lastEditStart)
        return;

    return new Promise<WorkspaceEdit>(
        function (resolve, reject)
        {
            asmodule.onResolved(() => {
                // If the float literal has changed, don't do this
                if (asmodule.content.substring(matchStart, matchEnd) != match[0])
                {
                    reject();
                    return;
                }

                // Check if the expected value at this position is a double
                let context = GenerateCompletionContext(asmodule, matchStart);

                let expectingDoubleFloat = false;
                if (context.expectedType)
                {
                    if (typedb.ArePrimitiveTypesEquivalent(context.expectedType.name, "float64"))
                        expectingDoubleFloat = true;
                    else if (context.expectedType.name == "FVector")
                        expectingDoubleFloat = true;
                }

                if (expectingDoubleFloat)
                {
                    let edit = <WorkspaceEdit> {};
                    edit.changes = {};

                    if (match[2] && match[2].length != 0)
                    {
                        // Remove the f entirely
                        edit.changes[asmodule.displayUri] = [
                            TextEdit.del(asmodule.getRange(matchEnd-1, matchEnd))
                        ];
                    }
                    else
                    {
                        // Replace the f with a 0
                        edit.changes[asmodule.displayUri] = [
                            TextEdit.replace(asmodule.getRange(matchEnd-1, matchEnd), "0")
                        ];
                    }

                    resolve(edit);
                }
                else
                {
                    resolve(null);
                }
            });
        }
    );
}

export function GetExpectedTypeAtOffset(asmodule : scriptfiles.ASModule, offset : number) : typedb.DBType
{
    if (!asmodule)
        return null;

    let context = GenerateCompletionContext(asmodule, offset);
    return context.expectedType;
}