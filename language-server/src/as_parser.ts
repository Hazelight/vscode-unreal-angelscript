import { TextDocument, TextDocumentContentChangeEvent } from "vscode-languageserver-textdocument";
import { Range, Position, Location, MarkupContent, } from "vscode-languageserver";

import * as fs from 'fs';
import * as nearley from 'nearley';

import * as typedb from './database';
import { ProcessScriptTypeGeneratedCode } from "./generated_code";
//import { performance } from "perf_hooks";

let grammar_statement = nearley.Grammar.fromCompiled(require("../grammar/grammar_statement.js"));
let grammar_class_statement = nearley.Grammar.fromCompiled(require("../grammar/grammar_class_statement.js"));
let grammar_global_statement = nearley.Grammar.fromCompiled(require("../grammar/grammar_global_statement.js"));
let grammar_enum_statement = nearley.Grammar.fromCompiled(require("../grammar/grammar_enum_statement.js"));

let parser_statement = new nearley.Parser(grammar_statement);
let parser_class_statement = new nearley.Parser(grammar_class_statement);
let parser_global_statement = new nearley.Parser(grammar_global_statement);
let parser_enum_statement = new nearley.Parser(grammar_enum_statement);

let parser_statement_initial = parser_statement.save();
let parser_class_statement_initial = parser_class_statement.save();
let parser_global_statement_initial = parser_global_statement.save();
let parser_enum_statement_initial = parser_enum_statement.save();

let USE_PEGGY = true;
let PEGGY_GRAMMAR = require("../pegjs/angelscript.js")

export interface ASSettings
{
    automaticImports : boolean,
    floatIsFloat64 : boolean,
    useAngelscriptHaze: boolean,
};

let ScriptSettings : ASSettings = {
    automaticImports: false,
    floatIsFloat64: false,
    useAngelscriptHaze: false,
};

let PreParsedIdentifiersInModules = new Map<string, Set<ASModule>>();
let InitialParseDone = false;

export function GetScriptSettings() : ASSettings
{
    return ScriptSettings;
}

export function SetInitialParseDone()
{
    InitialParseDone = true;
}

export let node_types = require("../grammar/node_types.js");

export let ASKeywords = [
    "for", "if", "enum", "return", "continue", "break", "import", "class", "struct", "default",
    "void", "const", "delegate", "event", "else", "while", "case", "Cast", "namespace",
    "UFUNCTION", "UPROPERTY", "UCLASS", "USTRUCT", "nullptr", "true", "false", "this", "auto",
    "final", "property", "override", "mixin", "switch", "fallthrough",
];

export enum ASScopeType
{
    Global,
    Class,
    Function,
    Enum,
    Code,
    Namespace,
    LiteralAsset,
}

export class ASModule
{
    created : boolean = false;
    modulename : string;
    filename : string;
    uri : string;
    displayUri : string;

    content : string = null;
    lastEditStart : number = -1;
    lastEditEnd : number = -1;
    isOpened : boolean = false;
    exists : boolean = true;

    loaded: boolean = false;
    textDocument : TextDocument = null;

    parsed : boolean = false;
    resolved : boolean = false;
    typesPostProcessed : boolean = false;
    resolveCallbacks : Array<any> = null

    rootscope : ASScope = null;

    namespaces : Array<typedb.DBNamespace> = [];
    types : Array<typedb.DBType> = [];
    globalSymbols : Array<typedb.DBSymbol> = [];
    semanticSymbols : Array<ASSemanticSymbol> = [];

    importedModules : Array<ASModule> = [];
    delegateBinds : Array<ASDelegateBind> = [];
    annotatedFunctionCalls : Array<ASAnnotatedCall> = [];
    moduleDependencies = new Set<ASModule>();

    flatImportList = new Set<string>();
    preParsedImports = new Array<string>();
    preParsedIdentifiers = new Array<string>();

    queuedParse : any = null;

    rawStatements : Array<ASStatement> = [];
    cachedStatements : Array<ASStatement> = null;
    loadedFromCacheCount : number = 0;
    parsedStatementCount : number = 0;

    getOffset(position : Position) : number
    {
        if (!this.textDocument)
            return -1;
        return this.textDocument.offsetAt(position);
    }

    getPosition(offset : number) : Position
    {
        if (!this.textDocument)
            return Position.create(-1, -1);
        return this.textDocument.positionAt(offset);
    }

    getRange(start_offset : number, end_offset : number) : Range
    {
        return Range.create(
            this.getPosition(start_offset),
            this.getPosition(end_offset)
        );
    }

    getScopeAt(offset : number) : ASScope
    {
        if (!this.parsed)
            return null;
        return this.rootscope.getScopeAt(offset);
    }

    getStatementAt(offset : number) : ASStatement
    {
        if (!this.parsed)
            return null;
        return this.rootscope.getStatementAt(offset);
    }

    getLocation(offset : number) : Location
    {
        return Location.create(
            this.displayUri,
            Range.create(
                this.getPosition(offset),
                this.getPosition(offset),
            ),
        )
    }

    getLineText(line : number) : string
    {
        return this.content.substring(
            this.getOffset(Position.create(line, 0)),
            this.getOffset(Position.create(line, 10000)),
        );
    }

    isLineEmpty(line : number) : boolean
    {
        return /^\s*$/.test(this.content.substring(
            this.getOffset(Position.create(line, 0)),
            this.getOffset(Position.create(line, 10000)),
        ));
    }

    getLocationRange(start_offset : number, end_offset : number) : Location
    {
        return Location.create(
            this.displayUri,
            this.getRange(start_offset, end_offset),
        )
    }

    getSymbolAt(offset : number) : ASSemanticSymbol
    {
        for (let symbol of this.semanticSymbols)
        {
            if (offset >= symbol.start && offset < symbol.end)
                return symbol;
        }
        return null;
    }

    getSymbolAtOrBefore(offset : number) : ASSemanticSymbol
    {
        // Find the symbol of the character we're standing on
        let symbolBefore : ASSemanticSymbol = null;
        for (let symbol of this.semanticSymbols)
        {
            if (offset >= symbol.start && offset < symbol.end)
                return symbol;
            if (offset == symbol.end)
                symbolBefore = symbol;
        }
        // If no symbol was found, potentially return the symbol in front of the cursor
        return symbolBefore;
    }

    isEditingInside(start : number, end : number) : boolean
    {
        if (this.lastEditStart == -1)
            return false;
        return start < this.lastEditEnd && end > this.lastEditStart;
    }

    isEditingNode(statement : ASStatement, node : any) : boolean
    {
        if (!node || !statement)
            return false;
        return this.isEditingInside(
            statement.start_offset + node.start,
            statement.start_offset + node.end,
        )
    }

    getScopeDeclaringLocalSymbol(symbol : ASSemanticSymbol) : ASScope
    {
        if (symbol.type != ASSymbolType.Parameter && symbol.type != ASSymbolType.LocalVariable)
            return null;

        let checkscope = this.getScopeAt(symbol.start);
        while (checkscope)
        {
            for (let scopevar of checkscope.variables)
            {
                if (scopevar.name == symbol.symbol_name)
                    return checkscope;
            }

            if (!checkscope.isInFunctionBody())
                break;
            checkscope = checkscope.parentscope;
        }

        return null;
    }

    isModuleImported(modulename : string) : boolean
    {
        return this.flatImportList.has(modulename);
    }

    markDependencyModule(dependency : ASModule)
    {
        if (dependency)
            this.moduleDependencies.add(dependency);
    }

    markDependencySymbol(dependency : typedb.DBSymbol)
    {
        if (dependency instanceof typedb.DBMethod)
            this.markDependencyFunction(dependency);
        else if (dependency instanceof typedb.DBProperty)
            this.markDependencyProperty(dependency);
    }

    markDependencyType(dependency : typedb.DBType)
    {
        if (dependency && dependency.declaredModule)
            this.moduleDependencies.add(GetModule(dependency.declaredModule));
    }

    markDependencyNamespace(namespace : typedb.DBNamespace)
    {
        for (let decl of namespace.declarations)
        {
            if (decl.declaredModule)
                this.moduleDependencies.add(GetModule(decl.declaredModule));
        }
    }

    markDependencyFunction(dependency : typedb.DBMethod)
    {
        if (!dependency.declaredModule)
            return;

        this.moduleDependencies.add(GetModule(dependency.declaredModule));
        if (dependency.args)
        {
            for (let arg of dependency.args)
                this.markDependencyTypename(dependency.namespace, arg.typename);
        }

        if (dependency.returnType && dependency.returnType != "void")
            this.markDependencyTypename(dependency.namespace, dependency.returnType);
    }

    markDependencyProperty(dependency : typedb.DBProperty)
    {
        if (!dependency.declaredModule)
            return;

        this.moduleDependencies.add(GetModule(dependency.declaredModule));
        this.markDependencyTypename(dependency.namespace, dependency.typename);
    }

    markDependencyTypename(namespace : typedb.DBNamespace, typename : string)
    {
        let dependencyType = typedb.LookupType(namespace, typename);
        if (dependencyType)
            this.markDependencyType(dependencyType);
        else
            this.markDependencyIdentifier(typename);
    }

    markDependencyIdentifier(identifier : string)
    {
        let moduleList = PreParsedIdentifiersInModules.get(identifier);
        if (!moduleList)
            return;

        for (let dependency of moduleList)
            this.moduleDependencies.add(dependency);
    }

    onResolved(callback : any)
    {
        if (this.resolved)
        {
            callback();
            return;
        }

        if (!this.resolveCallbacks)
            this.resolveCallbacks = [];
        this.resolveCallbacks.push(callback);
    }
};

export class ASElement
{
    previous : ASElement = null;
    next : ASElement = null;
};

export class ASVariable
{
    name : string;
    typename : string;
    documentation : string;

    isArgument : boolean = false;
    isMember : boolean = false;
    isGlobal : boolean = false;

    isPrivate : boolean = false;
    isProtected : boolean = false;
    isAuto : boolean = false;
    isLoopVariable : boolean = false;
    isIterator : boolean = false;

    in_statement : boolean = false;
    node_typename : any = null;
    node_expression : any = null;

    potentiallyWrong : boolean = false;
    accessSpecifier : typedb.DBAccessSpecifier = null;
    isUnused : boolean = true;
    hasAnyUsages : boolean = false;
    usages : Array<ASSemanticSymbol> = null;

    start_offset_type : number = -1;
    end_offset_type : number = -1;
    start_offset_name : number = -1;
    end_offset_name : number = -1;
    start_offset_expression : number = -1;
    end_offset_expression : number = -1;

    isReference() : boolean
    {
        return this.typename.indexOf("&") != -1;
    }

    isValueType(scope : ASScope) : boolean
    {
        let dbType = typedb.LookupType(scope.getNamespace(), this.typename);
        if (dbType)
            return dbType.isValueType();
        return false;
    }
};

export enum ASSymbolType
{
    Typename,
    Namespace,
    TemplateBaseType,

    Parameter,
    LocalVariable,
    MemberVariable,
    MemberAccessor,
    GlobalVariable,
    GlobalAccessor,

    MemberFunction,
    GlobalFunction,

    AccessSpecifier,

    UnknownError,
    NoSymbol,
};

export class ASSemanticSymbol
{
    type : ASSymbolType;
    start: number = -1;
    end: number = -1;

    container_type : string = null;
    symbol_name : string = null;

    isWriteAccess : boolean = false;
    isUnimported : boolean = false;
    isAuto : boolean = false;
    noColor : boolean = false;

    overlapsRange(range_start : number, range_end : number) : boolean
    {
        return range_start < this.end && range_end > this.start;
    }
};

export class ASScope extends ASElement
{
    module : ASModule;

    start_offset : number = -1;
    end_offset : number = -1;

    parsed : boolean = false;
    statements : Array<ASStatement> = [];
    scopes : Array<ASScope> = [];

    declaration : ASStatement = null;
    element_head : ASElement = null;

    scopetype : ASScopeType = null;
    parentscope : ASScope = null;

    variables : Array<ASVariable> = [];
    variablesByName : Map<string, ASVariable> = new Map<string, ASVariable>();

    dbnamespace : typedb.DBNamespace = null;
    dbtype : typedb.DBType = null;
    dbfunc : typedb.DBMethod = null;
    assettype : string | null = null;

    resolvedNamespace : typedb.DBNamespace = null;
    available_global_types : Array<typedb.DBType> = null;

    isInFunctionBody() : boolean
    {
        switch (this.scopetype)
        {
            case ASScopeType.Function:
            case ASScopeType.Code:
            case ASScopeType.LiteralAsset:
                return true;
        }
        return false;
    }

    getScopeAt(offset : number) : ASScope
    {
        if (!this.parsed)
            return null;
        for (let subscope of this.scopes)
        {
            if (offset >= subscope.start_offset && offset < subscope.end_offset)
                return subscope.getScopeAt(offset);
        }
        return this;
    }

    getStatementAt(offset : number) : ASStatement
    {
        if (!this.parsed)
            return null;
        let element = this.element_head;
        while (element)
        {
            if (element instanceof ASScope)
            {
                if (offset >= element.start_offset && offset < element.end_offset)
                {
                    let substatement = element.getStatementAt(offset);
                    if (substatement)
                        return substatement;
                }
            }
            else if (element instanceof ASStatement)
            {
                if (offset >= element.start_offset && offset < element.end_offset)
                {
                    return element;
                }
            }

            element = element.next;
        }

        return null;
    }

    getParentFunctionScope() : ASScope
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            let dbFunc = checkscope.getDatabaseFunction();
            if (dbFunc)
                return checkscope;
            checkscope = checkscope.parentscope;
        }
        return null;
    }

    getParentFunction() : typedb.DBMethod
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            if (checkscope.scopetype != ASScopeType.Function && checkscope.scopetype != ASScopeType.Code)
                break;
            if (checkscope.dbfunc)
                return checkscope.dbfunc;
            checkscope = checkscope.parentscope;
        }
        return null;
    }

    getParentTypeScope() : ASScope
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            if (checkscope.scopetype == ASScopeType.Global)
                break;
            if (checkscope.scopetype == ASScopeType.LiteralAsset)
                return checkscope;

            let dbType = checkscope.getDatabaseType();
            if (dbType)
                return checkscope;
            checkscope = checkscope.parentscope;
        }
        return null;
    }

    getParentType() : typedb.DBType
    {
        if (this.dbtype)
            return this.dbtype;
        if (this.scopetype == ASScopeType.LiteralAsset)
            return typedb.GetTypeByName(this.assettype);

        if (this.parentscope)
        {
            if (this.parentscope.dbtype)
                return this.parentscope.dbtype;

            let checkscope : ASScope = this.parentscope.parentscope;
            while (checkscope != null)
            {
                if (checkscope.scopetype == ASScopeType.Namespace)
                    break;
                if (checkscope.scopetype == ASScopeType.Global)
                    break;
                if (checkscope.scopetype == ASScopeType.LiteralAsset)
                    return typedb.GetTypeByName(checkscope.assettype);
                if (checkscope.dbtype)
                    return checkscope.dbtype;
                checkscope = checkscope.parentscope;
            }

            return null;
        }
        else
        {
            return null;
        }

    }

    getNamespace() : typedb.DBNamespace
    {
        return this.resolvedNamespace;
    }

    getDatabaseType() : typedb.DBType
    {
        return this.dbtype;
    }

    getDatabaseFunction() : typedb.DBMethod
    {
        return this.dbfunc;
    }

    findScopeForType(typename : string) : ASScope
    {
        let dbtype = this.getDatabaseType();
        if(dbtype && dbtype.name == typename)
            return this;
        for(let subscope of this.scopes)
        {
            let found = subscope.findScopeForType(typename);
            if(found)
                return found;
        }
        return null;
    }

    isNamespaceOrGlobalScope() : boolean
    {
        if (this.scopetype == ASScopeType.Global)
            return true;
        if (this.scopetype == ASScopeType.Namespace)
            return true;
        return false;
    }
};

export class ASStatement extends ASElement
{
    content : string;
    rawIndex : number = -1;

    start_offset : number = -1;
    end_offset : number = -1;

    ast : any = null;
    parsed : boolean = false;
    endsWithSemicolon : boolean = false;
    parseError : boolean = false;
    parsedType : ASScopeType = ASScopeType.Code;

    generatedTypes : boolean = false;
};

export class ASDelegateBind
{
    statement : ASStatement = null;
    scope : ASScope = null;
    delegateType : string = null;
    node_expression : any = null;
    node_object : any = null;
    node_name : any = null;
};

export class ASAnnotatedCall
{
    statement : ASStatement = null;
    scope : ASScope = null;
    method : typedb.DBMethod = null;
    node_call : any = null;
};

export let ModuleDatabase = new Map<string, ASModule>();
let ModulesByUri = new Map<string, ASModule>();

// Get all modules currently loaded
export function GetAllLoadedModules() : Array<ASModule>
{
    let files : Array<ASModule> = [];
    for (let module of ModuleDatabase)
    {
        if (module[1].loaded && module[1].exists)
            files.push(module[1]);
    }
    return files;
}

// Get all modules currently parsed
export function GetAllParsedModules() : Array<ASModule>
{
    let files : Array<ASModule> = [];
    for (let module of ModuleDatabase)
    {
        if (module[1].parsed)
            files.push(module[1]);
    }
    return files;
}

// Get a module reference with the specified module name
export function GetModule(modulename : string) : ASModule
{
    let module = ModuleDatabase.get(modulename);
    if (!module)
    {
        module = new ASModule;
        module.modulename = modulename;
        ModuleDatabase.set(modulename, module);
    }
    return module;
}

// Get a module reference by its file uri
export function GetModuleByUri(uri : string) : ASModule
{
    return ModulesByUri.get(NormalizeUri(uri));
}

// Create an unloaded module and put it into the module database
export function GetOrCreateModule(modulename : string, filename : string, uri : string) : ASModule
{
    let module = GetModule(modulename);
    if (!module.created)
    {
        module.modulename = modulename;
        module.uri = NormalizeUri(uri);
        module.displayUri = decodeURIComponent(uri);
        module.filename = filename;
        module.created = true;
        ModulesByUri.set(module.uri, module);
    }

    return module;
}

export function NormalizeUri(uri : string) : string
{
    let result = decodeURIComponent(uri).toLowerCase();
    return result;
}

// Ensure the module is parsed into an abstract syntax tree if it is not already parsed
export function ParseModule(module : ASModule, debug : boolean = false)
{
    if (module.parsed)
        return;

    //let startTime = performance.now()

    typedb.OnDirtyTypeCaches();
    module.parsed = true;

    module.rootscope = new ASScope;
    module.rootscope.module = module;
    module.rootscope.start_offset = 0;
    module.rootscope.end_offset = module.textDocument.getText().length;

    // Parse content of file into distinct statements
    ParseScopeIntoStatements(module.rootscope);

    // Parse each statement into an abstract syntax tree
    // USE_PEGGY = false;
    // module.cachedStatements = [];

    // let startTime_nearley = performance.now()
    // ParseAllStatements(module.rootscope, debug);
    // let endTime_nearley = performance.now()

    // USE_PEGGY = true;
    // module.cachedStatements = [];

    // let startTime_peggy = performance.now()
    ParseAllStatements(module.rootscope, debug);
    // let endTime_peggy = performance.now()

    // Traverse syntax trees to lift out functions, variables and imports during this first parse step
    GenerateTypeInformation(module.rootscope);

    //let parseTime = performance.now() - startTime;
    //if (parseTime > 50)
        //console.log("Parse "+module.modulename+" " + (parseTime) + " ms - "+module.loadedFromCacheCount+" cached, "+module.parsedStatementCount+" parsed")

    // if (endTime_peggy - startTime_peggy > 10 || endTime_nearley - startTime_nearley > 40)
    //     console.log("Parse "+module.modulename+" took "+(endTime_peggy-startTime_peggy)+" ms with peggy, "+(endTime_nearley-startTime_nearley)+" ms with nearley");
}

// Parse the specified module and all its unparsed dependencies
export function ParseModuleAndDependencies(module : ASModule, visited : Set<ASModule> = null)
{
    let visitList = visited;
    if (visitList == null)
        visitList = new Set<ASModule>();
    else if (visitList.has(module))
        return;

    if (!module.loaded)
        UpdateModuleFromDisk(module);
    if (!module.loaded)
        return;
    if (!module.parsed)
        ParseModule(module);

    visitList.add(module);
    for (let importedModule of module.importedModules)
        ParseModuleAndDependencies(importedModule, visitList);
}

// Post process types generated by this module after parsing
export function PostProcessModuleTypes(module : ASModule)
{
    if (module.typesPostProcessed)
        return;
    if (!module.parsed)
        return;
    module.typesPostProcessed = true;

    for (let dbtype of module.types)
        ProcessScriptTypeGeneratedCode(dbtype, module);
}

// Post process types generated by this module and all its dependencies
export function PostProcessModuleTypesAndDependencies(module : ASModule, visited : Set<ASModule> = null)
{
    let visitList = visited;
    if (visitList == null)
        visitList = new Set<ASModule>();
    else if (visitList.has(module))
        return;

    if (!module.parsed)
        return;

    if (!module.typesPostProcessed)
        PostProcessModuleTypes(module);

    visitList.add(module);
    for (let importedModule of module.importedModules)
        PostProcessModuleTypesAndDependencies(importedModule, visitList);
}

// Resolve symbols in the module from the syntax tree if not already resolved
export function ResolveModule(module : ASModule)
{
    if (!module.parsed)
        return;
    if (module.resolved)
        return;

    while (!module.resolved)
    {
        module.resolved = true;

        // Flatten full tree of imported modules
        module.flatImportList.clear();
        let importList = new Array<ASModule>();
        importList.push(module);
        for (let i = 0; i < importList.length; ++i)
        {
            if (!importList[i].parsed)
                continue;
            if (module.flatImportList.has(importList[i].modulename))
                continue;
            module.flatImportList.add(importList[i].modulename);
            for (let importMod of importList[i].importedModules)
                importList.push(importMod);
        }

        // Resolve autos to the correct types
        ResolveAutos(module.rootscope);

        // Detect all symbols used in the scope
        DetectScopeSymbols(module.rootscope);

        // If we've detected new dependencies while we were adding symbols,
        // make sure those dependencies are parsed first, and then re-resolve
        if (ScriptSettings.automaticImports)
        {
            for (let dependencyModule of module.moduleDependencies)
            {
                // If the dependency isn't parsed at all, parse it now
                if (!dependencyModule.parsed)
                {
                    ParseModuleAndDependencies(dependencyModule);
                    module.resolved = false;
                }

                // Classes declared in the dependency module must also have their superclasses
                // (and their superclasses) parsed, so the members show up correctly.
                // We can skip this check if the module is already resolved, since that guarantees it.
                if (!dependencyModule.resolved)
                {
                    for (let dependencyClass of dependencyModule.types)
                    {
                        let newTypesLoaded = EnsureTypeHierarchyFullyParsed(dependencyClass);
                        if (newTypesLoaded)
                            module.resolved = false;
                    }
                }

                // Postprocessing needs to occur on the module as well
                if (!dependencyModule.typesPostProcessed)
                {
                    PostProcessModuleTypesAndDependencies(dependencyModule);
                    module.resolved = false;
                }
            }

            if (!module.resolved)
            {
                module.semanticSymbols = [];
                module.moduleDependencies.clear();
            }
        }
    }

    // Trigger anything that wanted to wait for resolve to finish
    if (module.resolveCallbacks)
    {
        let callbacks = module.resolveCallbacks;
        module.resolveCallbacks = null;

        for (let callback of callbacks)
            callback();
    }

    // Clear previously cached statements from last parse
    module.cachedStatements = null;
}

function EnsureTypeHierarchyFullyParsed(dbtype : typedb.DBType) : boolean
{
    let newTypesLoaded = false;

    let superTypeName = dbtype.supertype;
    let superNamespace = dbtype.namespace;
    while (superTypeName)
    {
        let superType = typedb.LookupType(superNamespace, superTypeName);
        if (superType)
        {
            if (superType.declaredModule)
            {
                let superModule = GetModule(superType.declaredModule);
                if (superModule.resolved)
                {
                    // Super module is already resolved, no need to check further
                    break;
                }
                else
                {
                    // Super module must already be parsed if the type in it exists,
                    // but keep checking supers to make sure they're all parsed.
                    superTypeName = superType.supertype;
                    superNamespace = superType.namespace;
                    continue;
                }
            }
            else
            {
                // C++ type, no need to check further
                break;
            }
        }
        else
        {
            // Super module not parsed yet? Check the preparse lookup
            let potentialModules = PreParsedIdentifiersInModules.get(superTypeName);
            if (potentialModules)
            {
                // Parse all modules that might contain the superclass
                for (let moduleWithSuper of potentialModules)
                    ParseModuleAndDependencies(moduleWithSuper);

                let superType = typedb.LookupType(superNamespace, superTypeName);
                if (superType)
                {
                    // We found a new supertype, so we need to re-resolve
                    newTypesLoaded = true;
                    continue;
                }
                else
                {
                    // If we still can't find the supertype now, give up
                    break;
                }
            }
            else
            {
                // We couldn't find the super type in our preparsed identifiers,
                // just give up now.
                break;
            }
        }
    }

    return newTypesLoaded;
}

// Update a module with new transient content
export function UpdateModuleFromContent(module : ASModule, content : string)
{
    // Find the position in the content where we have made an edit,
    // this will help us determine whether to show errors or not in the future.
    if (module.content)
    {
        let previousEditStart = module.lastEditStart;
        let previousEditEnd = module.lastEditEnd;

        module.lastEditStart = -1;
        module.lastEditEnd = -1;
        let shortestLength = Math.min(module.content.length, content.length);

        // Find the start of the changed bit
        for (let i = 0; i < shortestLength; ++i)
        {
            if (module.content[i] != content[i])
            {
                module.lastEditStart = i;
                break;
            }
        }

        if (module.lastEditStart == -1)
        {
            // If we have added or removed stuff, our last edit was at the end of the file
            if (content.length != module.content.length)
            {
                module.lastEditStart = content.length-1;
                module.lastEditEnd = content.length;
            }
            else
            {
                module.lastEditStart = previousEditStart;
                module.lastEditEnd = previousEditEnd;
            }
        }
        else
        {
            let isDelete = module.content.length > content.length;
            if (isDelete)
            {
                // Try to establish the deleted bit
                let deleteLength = module.content.length - content.length;

                let oldIndex = module.lastEditStart+deleteLength;
                let newIndex = module.lastEditStart;

                let remainderMatches = true;
                while (oldIndex < module.content.length)
                {
                    if (module.content[oldIndex] != content[newIndex])
                    {
                        remainderMatches = false;
                        break;
                    }
                    ++oldIndex;
                    ++newIndex;
                }

                // If the remainder matches, find if the deleted bit had a line break in it
                // If it did, we don't consider this an edit at all, since no remaining symbols could have changed
                if (remainderMatches)
                {
                    let containsNewline = false;
                    for (let i = 0; i < deleteLength; ++i)
                    {
                        if (module.content[module.lastEditStart+i] == '\n')
                        {
                            containsNewline = true;
                            break;
                        }
                    }

                    if (containsNewline)
                        module.lastEditStart = -1;
                    else
                        module.lastEditStart -= 1;
                }

                if (module.lastEditStart != -1)
                    module.lastEditEnd = module.lastEditStart+1;
                else
                    module.lastEditEnd = -1;
            }
            else
            {
                // Try to establish the added bit
                let addLength = content.length - module.content.length;

                let oldIndex = module.lastEditStart;
                let newIndex = module.lastEditStart+addLength;

                let remainderMatches = true;
                while (oldIndex < module.content.length)
                {
                    if (module.content[oldIndex] != content[newIndex])
                    {
                        remainderMatches = false;
                        break;
                    }
                    ++oldIndex;
                    ++newIndex;
                }

                if (remainderMatches)
                {
                    // We inserted a single string of characters, mark a range edit
                    module.lastEditEnd = module.lastEditStart + addLength;
                }
                else
                {
                    // No match, just treat it as a single character edit
                    module.lastEditEnd = module.lastEditStart + 1;
                }
            }
        }
    }
    else
    {
        module.lastEditStart = -1;
        module.lastEditEnd = -1;
    }

    // Update the content in the module
    ClearModule(module);
    module.content = content;
    module.exists = true;
    LoadModule(module);
}

export function UpdateModuleFromContentChanges(module : ASModule, contentChanges : TextDocumentContentChangeEvent[])
{
    let textDocument = module.textDocument;
    ClearModule(module);

    TextDocument.update(textDocument, contentChanges, textDocument.version+1);
    module.textDocument = textDocument;
    module.content = textDocument.getText();
    module.exists = true;
    module.loaded = true;

    // Update where the last edit took place
    for (let change of contentChanges)
    {
        if ('range' in change)
        {
            if (change.text.length == 0)
            {
                // Deletes also dirty the character before them
                module.lastEditStart = textDocument.offsetAt(change.range.start) - 1;
                module.lastEditEnd = textDocument.offsetAt(change.range.start) + change.text.length;
            }
            else
            {
                module.lastEditStart = textDocument.offsetAt(change.range.start);
                module.lastEditEnd = textDocument.offsetAt(change.range.start) + change.text.length;
            }
        }
    }
}

export function UpdateModuleFromDisk(module : ASModule)
{
    if (!module.filename)
        return;


    ClearModule(module);
    try
    {
        module.content = fs.readFileSync(module.filename, 'utf8');

        // If there is a Byte-Order-Mark, remove it. vscode pretends it doesn't exist
        // and we don't want to desync with what vscode thinks the document looks like.
        if (module.content.charCodeAt(0) === 0xfeff)
            module.content = module.content.substring(1);

        module.exists = true;
    }
    catch (readError)
    {
        module.content = "";
        module.exists = false;
    }
    module.lastEditStart = -1;
    module.lastEditEnd = -1;
    LoadModule(module);

    PreParseImports(module);
    PreParseTypes(module);
}

// Called when the debug database changes, and all modules need to stop being resolved
export function ClearAllResolvedModules()
{
    for (let [modulename, asmodule] of ModuleDatabase)
    {
        if (asmodule.resolved)
        {
            asmodule.resolved = false;
            asmodule.semanticSymbols = [];
            asmodule.delegateBinds = [];
            asmodule.annotatedFunctionCalls = [];
        }
    }
}

// Ensure the module is initialized from the loaded content
function LoadModule(module : ASModule)
{
    if (module.loaded)
        return;
    module.loaded = true;
    module.textDocument = TextDocument.create(module.uri, "angelscript", 1, module.content)
}

// Use a simple regex to lift out import statements for find references
let re_import_statement = /\s*import\s+([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*);/g;
function PreParseImports(module : ASModule)
{
    module.preParsedImports = [];
    re_import_statement.lastIndex = 0;
    while (true)
    {
        let match = re_import_statement.exec(module.content);
        if (!match)
            break;

        module.preParsedImports.push(match[1]);
    }
}

// Use regex to lift out types, namespaces and global functions so resolve can find them later
let re_preparse_type = /\s*(class|struct|namespace|enum)\s+([A-Za-z0-9_]+)(\s*:\s*([A-Za-z0-9_]+))?\s*\{/g;
let re_preparse_function = /(\n|^)[ \t]*((mixin|delegate|event)[ \t]+)?((const[ \t]+)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)([ \t]*&)?)[\t ]+([A-Za-z0-9_]+)\(((.|\n|\r)*?)\)/g;
function PreParseTypes(module : ASModule)
{
    module.preParsedIdentifiers = [];

    re_preparse_type.lastIndex = 0;
    while (true)
    {
        let match = re_preparse_type.exec(module.content);
        if (!match)
            break;

        let identifier = match[2];
        module.preParsedIdentifiers.push(identifier);

        let list = PreParsedIdentifiersInModules.get(identifier);
        if (!list)
        {
            list = new Set<ASModule>()
            PreParsedIdentifiersInModules.set(identifier, list);
        }

        list.add(module);
    }

    re_preparse_function.lastIndex = 0;
    while (true)
    {
        let match = re_preparse_function.exec(module.content);
        if (!match)
            break;

        let identifier = match[10];
        module.preParsedIdentifiers.push(identifier);

        let list = PreParsedIdentifiersInModules.get(identifier);
        if (!list)
        {
            list = new Set<ASModule>()
            PreParsedIdentifiersInModules.set(identifier, list);
        }

        list.add(module);
    }
}

// Get all modules that could potentially have imported this symbol
export function GetModulesPotentiallyImportingSymbol(asmodule : ASModule, findSymbol : ASSemanticSymbol) : Array<ASModule>
{
    switch (findSymbol.type)
    {
        case ASSymbolType.Typename:
        case ASSymbolType.TemplateBaseType:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.symbol_name);
            if (dbtype)
            {
                // Limit to things importing this type if it's a script type
                if (dbtype.declaredModule)
                    return GetModulesPotentiallyImporting(dbtype.declaredModule);
                else
                    return GetAllLoadedModules();
            }
        }
        break;
        case ASSymbolType.Namespace:
        {
            let dbnamespace = typedb.LookupNamespace(null, findSymbol.symbol_name);
            if (dbnamespace)
                return GetModulesPotentiallyImportingNamespace(dbnamespace);
        }
        break;
        case ASSymbolType.GlobalFunction:
        case ASSymbolType.GlobalAccessor:
        case ASSymbolType.GlobalVariable:
        {
            let dbnamespace = typedb.LookupNamespace(null, findSymbol.container_type);
            if (dbnamespace)
                return GetModulesPotentiallyImportingNamespace(dbnamespace);
        }
        break;
        case ASSymbolType.MemberFunction:
        case ASSymbolType.MemberAccessor:
        case ASSymbolType.MemberVariable:
        {
            let dbtype = typedb.GetTypeByName(findSymbol.container_type);
            if (dbtype)
            {
                // Limit to things importing this type if it's a script type
                if (dbtype.declaredModule)
                    return GetModulesPotentiallyImporting(dbtype.declaredModule);
                else
                    return GetAllLoadedModules();
            }
        }
        break;
        case ASSymbolType.Parameter:
        case ASSymbolType.LocalVariable:
            // These can only be used within the same module
            return [asmodule];
        break;
        case ASSymbolType.UnknownError:
        case ASSymbolType.NoSymbol:
            // Don't know anything about these
            return [];
        break;
    }

    // Don't know enough to limit
    return GetAllLoadedModules();
}

// Get all modules that could potentially have imported this module
export function GetModulesPotentiallyImporting(findModule : string) : Array<ASModule>
{
    let markedModules = new Set<string>();
    markedModules.add(findModule);

    RecursiveMarkDependentModules(markedModules);

    let modules = new Array<ASModule>();
    for (let markedName of markedModules)
        modules.push(GetModule(markedName));
    return modules;
}

export function GetModulesPotentiallyImportingMultiple(findModules : Array<string>) : Array<ASModule>
{
    let markedModules = new Set<string>();
    for (let module of findModules)
        markedModules.add(module);

    RecursiveMarkDependentModules(markedModules);

    let modules = new Array<ASModule>();
    for (let markedName of markedModules)
        modules.push(GetModule(markedName));
    return modules;
}

export function GetModulesPotentiallyImportingNamespace(namespace : typedb.DBNamespace) : Array<ASModule>
{
    // Limit to things importing this type if it's a script type
    let allDeclaredModules : Array<string> = [];
    for (let decl of namespace.declarations)
    {
        // If it's a C++ namespace everything can use it
        if (!decl.declaredModule)
            return GetAllLoadedModules();

        allDeclaredModules.push(decl.declaredModule);
    }

    return GetModulesPotentiallyImportingMultiple(allDeclaredModules);
}

export function RecursiveMarkDependentModules(markedModules : Set<string>)
{
    let anyMarked = true;
    while (anyMarked)
    {
        anyMarked = false;
        for (let module of ModuleDatabase.values())
        {
            // Already marked
            if (markedModules.has(module.modulename))
                continue;

            let isPotentialUser = false;
            if (ScriptSettings.automaticImports)
            {
                if (module.resolved)
                {
                    // Already resolved modules can be filtered by their recorded dependencies
                    for (let dependency of module.moduleDependencies)
                    {
                        if (markedModules.has(dependency.modulename))
                        {
                            isPotentialUser = true;
                            break;
                        }
                    }
                }
                else
                {
                    // Unfortunately all unresolved modules are potential users,
                    // because we don't have pre-parsed metadata from import statements.
                    isPotentialUser = true;
                }
            }
            else
            {
                // Check if any of our imports are marked
                if (module.parsed)
                {
                    for (let parsedImport of module.importedModules)
                    {
                        if (markedModules.has(parsedImport.modulename))
                        {
                            isPotentialUser = true;
                            break;
                        }
                    }
                }
                else if (module.preParsedImports)
                {
                    for (let foundImport of module.preParsedImports)
                    {
                        if (markedModules.has(foundImport))
                        {
                            isPotentialUser = true;
                            break;
                        }
                    }
                }
            }

            // Mark the module if it imports a marked module
            if (isPotentialUser)
            {
                markedModules.add(module.modulename);
                anyMarked = true;
            }
        }
    }
}

function ClearModule(module : ASModule)
{
    if (module.parsed)
    {
        // Remove symbols from old namespaces
        for (let ns of module.namespaces)
            typedb.RemoveNamespaceDeclaration(ns, module.modulename);

        // Remove symbols from old globals
        for (let sym of module.globalSymbols)
            sym.namespace.removeSymbol(sym);

        // Remove types declared in this file
        for (let type of module.types)
            typedb.RemoveTypeFromDatabase(type);
    }

    module.loaded = false;
    module.parsed = false;
    module.semanticSymbols = [];
    module.types = [];
    module.delegateBinds = [];
    module.annotatedFunctionCalls = [];
    module.namespaces = [];
    module.globalSymbols = [];
    module.resolved = false;
    module.typesPostProcessed = false;
    module.rootscope = null;
    module.textDocument = null;
    module.content = null;
    module.importedModules = [];
    module.flatImportList.clear();
    module.preParsedImports = [];

    module.cachedStatements = module.rawStatements;
    module.rawStatements = [];
    module.loadedFromCacheCount = 0;
    module.parsedStatementCount = 0;
    module.moduleDependencies.clear();

    for (let identifier of module.preParsedIdentifiers)
    {
        let list = PreParsedIdentifiersInModules.get(identifier);
        if (list)
            list.delete(module);
    }
    module.preParsedIdentifiers = [];
}

export function GetSymbolLocation(modulename : string, typename : string, symbolname : string) : Location | null
{
    let asmodule = GetModule(modulename);
    if (!asmodule)
        return null;

    if (!typename)
        return _GetScopeSymbol(asmodule, asmodule.rootscope, symbolname);
    if (typename.startsWith("__"))
        typename = typename.substring(2);
    return RecursiveFindScopeSymbol(asmodule, asmodule.rootscope, typename, symbolname);
}

export function GetSymbolLocationInScope(scope : ASScope, symbolname : string) : Location | null
{
    let checkScope = scope;
    while(checkScope)
    {
        let sym = _GetScopeSymbol(scope.module, checkScope, symbolname);
        if (sym)
            return sym;
        checkScope = checkScope.parentscope;
    }
    return null;
}

function RecursiveFindScopeSymbol(file : ASModule, scope : ASScope, typename : string, symbolname : string) : Location | null
{
    for (let subscope of scope.scopes)
    {
        let scopeType = subscope.getDatabaseType();
        if (!scopeType)
            continue;
        if (scopeType.name == typename)
        {
            let symbolLocation = _GetScopeSymbol(file, subscope, symbolname);
            if (symbolLocation)
                return symbolLocation;
        }

        let subLocation = RecursiveFindScopeSymbol(file, subscope, typename, symbolname);
        if (subLocation)
            return subLocation;
    }

    return null;
}

function _GetScopeSymbol(asmodule : ASModule, scope : ASScope, symbolname : string) : Location | null
{
    // Find variables
    for (let scopevar of scope.variables)
    {
        if (scopevar.name != symbolname)
            continue;
        return asmodule.getLocation(scopevar.start_offset_name);
    }

    // Find functions
    for (let innerscope of scope.scopes)
    {
        if(innerscope.scopetype != ASScopeType.Function)
            continue;
        let func = innerscope.getDatabaseFunction();
        if (!func)
            continue;
        if (func.name != symbolname)
            continue;
        return asmodule.getLocation(func.moduleOffset);
    }

    // Find property accessors
    for (let innerscope of scope.scopes)
    {
        if(innerscope.scopetype != ASScopeType.Function)
            continue;
        let func = innerscope.getDatabaseFunction();
        if (!func)
            continue;
        if (func.name != "Get"+symbolname && func.name != "Set"+symbolname)
            continue;
        return asmodule.getLocation(func.moduleOffset);
    }

    return null;
}

export function GetTypeSymbolLocation(modulename : string, typename : string) : Location | null
{
    let asmodule = GetModule(modulename);
    if (!asmodule)
        return null;

    let subscope = asmodule.rootscope.findScopeForType(typename);
    if(!subscope)
        return null;

    let dbtype = subscope.getDatabaseType();
    return asmodule.getLocation(dbtype.moduleOffset);
}

// Generate a database type for a scope
function AddDBType(scope : ASScope, typename : string, addToDatabase = true) : typedb.DBType
{
    let dbtype = new typedb.DBType();
    dbtype.name = typename;
    dbtype.supertype = null;
    dbtype.declaredModule = scope.module.modulename;
    dbtype.documentation = null;
    dbtype.isStruct = false;
    dbtype.isEnum = false;

    if (addToDatabase)
        typedb.AddTypeToDatabase(scope.getNamespace(), dbtype);
    return dbtype;
}

// Generate a database function for a scope
function AddDBMethod(scope : ASScope, funcname : string) : typedb.DBMethod
{
    let dbfunc = new typedb.DBMethod();
    dbfunc.name = funcname;
    dbfunc.returnType = null;
    dbfunc.argumentStr = null;
    dbfunc.args = new Array<typedb.DBArg>();
    dbfunc.declaredModule = scope.module.modulename;
    dbfunc.documentation = null;
    dbfunc.isPrivate = false;
    dbfunc.isProtected = false;
    dbfunc.isConstructor = false;
    dbfunc.isConst = false;
    dbfunc.isProperty = false;
    dbfunc.isBlueprintEvent = false;
    return dbfunc;
}

// Add list of parameters to a function scope
function AddParametersToFunction(scope : ASScope, statement : ASStatement, dbfunc : typedb.DBMethod, params : any)
{
    if (!params || params.length == 0)
    {
        dbfunc.argumentStr = "";
        return;
    }

    dbfunc.argumentStr = statement.content.substring(
        params[0].start, params[params.length-1].end
    );

    for (let param of params)
    {
        // Create a local variable in the scope for the parameter
        let asvar = new ASVariable();
        asvar.name = param.name ? param.name.value : null;
        asvar.typename = GetQualifiedTypename(param.typename);
        asvar.node_expression = param.expression;
        asvar.node_typename = param.typename;
        asvar.isArgument = true;
        asvar.in_statement = true;

        asvar.start_offset_type = statement.start_offset + param.typename.start;
        asvar.end_offset_type = statement.start_offset + param.typename.end;

        if (param.name)
        {
            asvar.start_offset_name = statement.start_offset + param.name.start;
            asvar.end_offset_name = statement.start_offset + param.name.end;
        }

        if (param.expression)
        {
            asvar.start_offset_expression = statement.start_offset + param.expression.start;
            asvar.end_offset_expression = statement.start_offset + param.expression.end;
        }

        if (asvar.name)
        {
            scope.variables.push(asvar);
            scope.variablesByName.set(asvar.name, asvar);
        }

        // Add argument to type database
        let dbarg = new typedb.DBArg();
        dbarg.typename = asvar.typename;
        dbarg.name = asvar.name ? asvar.name : "";
        dbfunc.args.push(dbarg);
    }
}

// Get the concatenated qualified typename
function GetQualifiedTypename(typename : any) : string
{
    let strtype : string;
    if (typename.const_qualifier)
        strtype = typename.const_qualifier.value+" "+typename.value;
    else
        strtype = typename.value;
    if (typename.ref_qualifier)
        strtype += typename.ref_qualifier;
    return strtype;
}

// Create a qualified typename with qualifiers from a node but a custom typename
function CopyQualifiersToTypename(qualifiers_from : any, typename : string) : string
{
    let strtype : string;
    if (qualifiers_from.const_qualifier)
        strtype = qualifiers_from.const_qualifier.value+" "+typename;
    else
        strtype = typename;
    if (qualifiers_from.ref_qualifier)
        strtype += qualifiers_from.ref_qualifier;
    return strtype;
}

// Check if the macro contains a particular specifier
function HasMacroSpecifier(macro : any, specifier : string) : boolean
{
    if (macro.name && macro.name.value == specifier)
        return true;
    if (macro.children)
    {
        for (let child of macro.children)
        {
            if (HasMacroSpecifier(child, specifier))
                return true;
        }
    }
    return false;
}

function MakeMacroSpecifiers(macro : any, macroSpecifiers : Map<string, string>, macroMeta : Map<string, string>)
{
    if (!macro.children)
        return;

    for (let macroEntry of macro.children)
    {
        if (macroEntry.name)
        {
            if (macroEntry.value)
            {
                // Specifier with value
                macroSpecifiers.set(macroEntry.name.value, macroEntry.value.value);
            }
            else if (macroEntry.children && macroEntry.name.value.toLowerCase() == "meta")
            {
                // Meta specifier list
                for (let metaEntry  of macroEntry.children)
                {
                    if (!metaEntry.name)
                        continue;
                    if (metaEntry.value)
                        macroMeta.set(metaEntry.name.value.toLowerCase(), metaEntry.value.value);
                    else
                        macroMeta.set(metaEntry.name.value.toLowerCase(), "");
                }
            }
            else
            {
                // Single specifier
                macroSpecifiers.set(macroEntry.name.value, "");
            }
        }
    }
}

// Add a variable declaration to the scope
function AddVarDeclToScope(scope : ASScope, statement : ASStatement, vardecl : any, in_statement : boolean = false) : ASVariable
{
    // Don't add the variable if we don't have a name
    if (!vardecl.name)
        return null;

    // If the type name or the identifier are currently being edited, we don't add the variable
    let maybeWrong = false;
    if (scope.module.isEditingNode(statement, vardecl.typename) || scope.module.isEditingNode(statement, vardecl.name))
    {
        if (!vardecl.name)
            return null;
        let afterName = statement.start_offset + vardecl.name.end;
        if (afterName >= scope.module.content.length || scope.module.content[afterName] != ';')
            maybeWrong = true;
    }

    // Add it as a local variable
    let asvar = new ASVariable();
    asvar.name = vardecl.name.value;
    asvar.typename = GetQualifiedTypename(vardecl.typename);
    asvar.node_expression = vardecl.expression;
    asvar.node_typename = vardecl.typename;
    asvar.isAuto = vardecl.typename.value == 'auto';
    asvar.in_statement = in_statement;
    asvar.potentiallyWrong = maybeWrong;

    if (vardecl.documentation)
        asvar.documentation = typedb.FormatDocumentationComment(vardecl.documentation);

    asvar.start_offset_type = statement.start_offset + vardecl.typename.start;
    asvar.end_offset_type = statement.start_offset + vardecl.typename.end;

    asvar.start_offset_name = statement.start_offset + vardecl.name.start;
    asvar.end_offset_name = statement.start_offset + vardecl.name.end;

    if (vardecl.expression)
    {
        asvar.start_offset_expression = statement.start_offset + vardecl.expression.start;
        asvar.end_offset_expression = statement.start_offset + vardecl.expression.end;
    }

    if (vardecl.access)
    {
        if (vardecl.access.value == "private")
            asvar.isPrivate = true;
        else if (vardecl.access.value == "protected")
            asvar.isProtected = true;
        else if (scope.dbtype)
            asvar.accessSpecifier = scope.dbtype.getAccessSpecifier(vardecl.access.value);
    }

    scope.variables.push(asvar);
    scope.variablesByName.set(asvar.name, asvar);

    // Add it to the type database
    if (scope.dbtype || scope.isNamespaceOrGlobalScope())
    {
        if (scope.isNamespaceOrGlobalScope())
            asvar.isGlobal = true;
        else
            asvar.isMember = true;

        let dbprop = new typedb.DBProperty();
        dbprop.name = asvar.name;
        dbprop.typename = asvar.typename;
        dbprop.documentation = asvar.documentation;
        dbprop.declaredModule = scope.module.modulename;
        dbprop.moduleOffset = asvar.start_offset_name;
        dbprop.moduleOffsetEnd = asvar.end_offset_name;
        dbprop.isPrivate = asvar.isPrivate;
        dbprop.isProtected = asvar.isProtected;
        dbprop.accessSpecifier = asvar.accessSpecifier;

        // Add macro specifiers if we had any
        if (vardecl.macro)
        {
            dbprop.isUProperty = true;
            dbprop.macroSpecifiers = new Map<string, string>();
            dbprop.macroMeta = new Map<string, string>();

            MakeMacroSpecifiers(vardecl.macro, dbprop.macroSpecifiers, dbprop.macroMeta);

            // Check if we have keywords
            let keywords = dbprop.macroMeta.get("scriptkeywords");
            if (keywords)
                dbprop.keywords = keywords.split(" ");
        }

        if (scope.dbtype)
        {
            scope.dbtype.addSymbol(dbprop);
        }
        else
        {
            let namespace = scope.getNamespace();
            namespace.addSymbol(dbprop);

            if (vardecl.type == node_types.AssetDefinition)
                dbprop.isLiteralAsset = true;

            scope.module.globalSymbols.push(dbprop);
        }
    }

    return asvar;
}

// Extend a scope to include a previous statement
function ExtendScopeToStatement(scope : ASScope, statement : ASStatement)
{
    scope.start_offset = statement.start_offset;
}

function GenerateTypeInformation(scope : ASScope)
{
    scope.resolvedNamespace = scope.parentscope ? scope.parentscope.resolvedNamespace : typedb.GetRootNamespace();
    if (scope.previous && scope.previous instanceof ASStatement && scope.previous.ast)
    {
        // Class definition in global scope
        if (scope.previous.ast.type == node_types.ClassDefinition)
        {
            scope.declaration = scope.previous;

            let classdef = scope.previous.ast;
            let dbtype = AddDBType(scope, classdef.name.value);
            dbtype.supertype = classdef.superclass ? classdef.superclass.value : "UObject";
            if (classdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(classdef.documentation);

            dbtype.moduleOffset = scope.previous.start_offset + classdef.name.start;
            dbtype.moduleOffsetEnd = scope.previous.start_offset + classdef.name.end;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;

            if (classdef.macro)
            {
                dbtype.macroSpecifiers = new Map<string, string>();
                dbtype.macroMeta = new Map<string, string>();

                MakeMacroSpecifiers(classdef.macro, dbtype.macroSpecifiers, dbtype.macroMeta);

                // Check if we have keywords
                let keywords = dbtype.macroMeta.get("scriptkeywords");
                if (keywords)
                    dbtype.keywords = keywords.split(" ");
            }

            ExtendScopeToStatement(scope, scope.previous);
            dbtype.moduleScopeStart = scope.start_offset;
            dbtype.moduleScopeEnd = scope.end_offset;
        }
        // Struct definition in global scope
        else if (scope.previous.ast.type == node_types.StructDefinition)
        {
            scope.declaration = scope.previous;

            let structdef = scope.previous.ast;
            let dbtype = AddDBType(scope, structdef.name.value);
            if (structdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(structdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + structdef.name.start;
            dbtype.moduleOffsetEnd = scope.previous.start_offset + structdef.name.end;
            dbtype.isStruct = true;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;

            if (structdef.macro)
            {
                dbtype.macroSpecifiers = new Map<string, string>();
                dbtype.macroMeta = new Map<string, string>();

                MakeMacroSpecifiers(structdef.macro, dbtype.macroSpecifiers, dbtype.macroMeta);

                // Check if we have keywords
                let keywords = dbtype.macroMeta.get("scriptkeywords");
                if (keywords)
                    dbtype.keywords = keywords.split(" ");
            }

            ExtendScopeToStatement(scope, scope.previous);
            dbtype.moduleScopeStart = scope.start_offset;
            dbtype.moduleScopeEnd = scope.end_offset;
        }
        // Namespace definition in global scope
        else if (scope.previous.ast.type == node_types.NamespaceDefinition)
        {
            scope.declaration = scope.previous;

            let parentNamespace = typedb.GetRootNamespace();
            if (scope.parentscope)
                parentNamespace = scope.parentscope.getNamespace();

            let nsdef = scope.previous.ast;

            let decl = new typedb.DBNamespaceDeclaration();
            decl.declaredModule = scope.module.modulename;
            decl.declaredOffset = scope.previous.start_offset + nsdef.name.start;
            decl.declaredOffsetEnd = scope.previous.start_offset + nsdef.name.end;
            decl.scopeOffsetStart = scope.start_offset;
            decl.scopeOffsetEnd = scope.end_offset;
            decl.isNestedParent = false;

            // Generate all parent namespaces first
            let identifier = nsdef.name.value;
            let namespaceIndex = identifier.indexOf("::");
            if (namespaceIndex != -1)
            {
                let parts = identifier.split("::");
                identifier = parts[parts.length-1];

                for (let i = 0, count = parts.length - 1; i < count; ++i)
                {
                    let parentDecl = new typedb.DBNamespaceDeclaration();
                    parentDecl.declaredModule = scope.module.modulename;
                    parentDecl.declaredOffset = scope.previous.start_offset + nsdef.name.start;
                    parentDecl.declaredOffsetEnd = scope.previous.start_offset + nsdef.name.end;
                    parentDecl.scopeOffsetStart = scope.start_offset;
                    parentDecl.scopeOffsetEnd = scope.end_offset;
                    parentDecl.isNestedParent = true;
                    parentNamespace = typedb.DeclareNamespace(parentNamespace, parts[i], parentDecl);
                    scope.module.namespaces.push(parentNamespace);
                }
            }

            scope.dbnamespace = typedb.DeclareNamespace(parentNamespace, identifier, decl)
            scope.resolvedNamespace = scope.dbnamespace;

            if (nsdef.documentation)
                scope.dbnamespace.documentation = typedb.FormatDocumentationComment(nsdef.documentation);

            scope.module.namespaces.push(scope.dbnamespace);
            ExtendScopeToStatement(scope, scope.previous);
        }
        // Enum definition in global scope
        else if (scope.previous.ast.type == node_types.EnumDefinition)
        {
            scope.declaration = scope.previous;

            let enumdef = scope.previous.ast;
            let dbtype = AddDBType(scope, enumdef.name.value);
            dbtype.isEnum = true;
            if (enumdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(enumdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + enumdef.name.start;
            dbtype.moduleOffsetEnd = scope.previous.start_offset + enumdef.name.end;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;

            ExtendScopeToStatement(scope, scope.previous);
            dbtype.moduleScopeStart = scope.start_offset;
            dbtype.moduleScopeEnd = scope.end_offset;
        }
        // Function declaration, either in a class or global
        else if (scope.previous.ast.type == node_types.FunctionDecl)
        {
            scope.declaration = scope.previous;

            let funcdef = scope.previous.ast;
            let dbfunc = AddDBMethod(scope, funcdef.name.value);
            if (funcdef.documentation)
                dbfunc.documentation = typedb.FormatDocumentationComment(funcdef.documentation);
            dbfunc.moduleOffset = scope.previous.start_offset + funcdef.name.start;
            dbfunc.moduleOffsetEnd = scope.previous.start_offset + funcdef.name.end;

            if (funcdef.returntype)
                dbfunc.returnType = GetQualifiedTypename(funcdef.returntype);
            else
                dbfunc.returnType = "void";

            AddParametersToFunction(scope, scope.previous, dbfunc, funcdef.parameters);

            if (funcdef.macro)
            {
                dbfunc.isUFunction = true;
                dbfunc.macroSpecifiers = new Map<string, string>();
                dbfunc.macroMeta = new Map<string, string>();

                MakeMacroSpecifiers(funcdef.macro, dbfunc.macroSpecifiers, dbfunc.macroMeta);

                // Mark as event
                if (dbfunc.macroSpecifiers.has("BlueprintOverride"))
                {
                    dbfunc.isBlueprintEvent = true;
                    dbfunc.isBlueprintOverride = true;
                }
                else if (dbfunc.macroSpecifiers.has("BlueprintEvent"))
                {
                    dbfunc.isBlueprintEvent = true;
                }

                // Check if we have keywords
                let keywords = dbfunc.macroMeta.get("scriptkeywords");
                if (keywords)
                    dbfunc.keywords = keywords.split(" ");

                dbfunc.cacheDelegateMeta();
            }

            if (funcdef.access)
            {
                if (funcdef.access.value == "protected")
                    dbfunc.isProtected = true;
                else if (funcdef.access.value == "private")
                    dbfunc.isPrivate = true;
                else if (scope.parentscope.dbtype)
                    dbfunc.accessSpecifier = scope.parentscope.dbtype.getAccessSpecifier(funcdef.access.value);
            }

            if (funcdef.qualifiers)
            {
                for (let qual of funcdef.qualifiers)
                {
                    if (qual == "property")
                        dbfunc.isProperty = true;
                    else if (qual == "const")
                        dbfunc.isConst = true;
                    else if (qual == "final")
                        dbfunc.isFinal = true;
                    else if (qual == "override")
                        dbfunc.isOverride = true;
                }
            }

            if (funcdef.scoping)
            {
                if (funcdef.scoping == "mixin")
                    dbfunc.isMixin = true;
                else if (funcdef.scoping == "local")
                    dbfunc.isLocal = true;
            }

            // Figure out whether there is any code in this function
            if (scope.scopes.length != 0)
            {
                dbfunc.isEmpty = false;
            }
            else
            {
                dbfunc.isEmpty = true;
                for (let statement of scope.statements)
                {
                    if (statement.ast)
                    {
                        dbfunc.isEmpty = false;
                        break;
                    }
                }
            }

            scope.dbfunc = dbfunc;

            if (scope.parentscope && scope.parentscope.dbtype)
            {
                scope.parentscope.dbtype.addSymbol(dbfunc);
            }
            else
            {
                let namespace = typedb.GetRootNamespace();
                if (scope.parentscope)
                    namespace = scope.parentscope.getNamespace();

                scope.module.globalSymbols.push(dbfunc);
                namespace.addSymbol(dbfunc);
            }

            ExtendScopeToStatement(scope, scope.previous);
            dbfunc.moduleScopeStart = scope.previous.start_offset + funcdef.name.start;
            dbfunc.moduleScopeEnd = scope.end_offset;
        }
        // Constructor declaration placed inside a class
        else if (scope.previous.ast.type == node_types.ConstructorDecl)
        {
            scope.declaration = scope.previous;

            let constrdef = scope.previous.ast;
            let dbfunc = AddDBMethod(scope, constrdef.name.value);
            AddParametersToFunction(scope, scope.previous, dbfunc, constrdef.parameters);
            dbfunc.moduleOffset = scope.previous.start_offset + constrdef.name.start;
            dbfunc.moduleOffsetEnd = scope.previous.start_offset + constrdef.name.end;
            dbfunc.isConstructor = true;
            scope.dbfunc = dbfunc;

            // Constructor gets added to the namespace as a global function instead
            if (scope.parentscope)
            {
                let namespace = scope.parentscope.getNamespace();
                dbfunc.documentation = scope.parentscope.dbtype.documentation;
                dbfunc.returnType = scope.parentscope.dbtype.name;

                scope.module.globalSymbols.push(dbfunc);
                namespace.addSymbol(dbfunc);
            }

            ExtendScopeToStatement(scope, scope.previous);
            dbfunc.moduleScopeStart = scope.previous.start_offset + constrdef.name.start;
            dbfunc.moduleScopeEnd = scope.end_offset;
        }
        // Destructor declaration placed inside a class
        else if (scope.previous.ast.type == node_types.DestructorDecl)
        {
            scope.declaration = scope.previous;

            let destrdef = scope.previous.ast;
            let dbfunc = AddDBMethod(scope, destrdef.name.value);
            dbfunc.moduleOffset = scope.previous.start_offset + destrdef.name.start;
            dbfunc.moduleOffsetEnd = scope.previous.start_offset + destrdef.name.end;
            dbfunc.moduleScopeStart = scope.previous.start_offset + destrdef.name.start;
            dbfunc.moduleScopeEnd = scope.end_offset;
            scope.dbfunc = dbfunc;

            if (scope.parentscope && scope.parentscope.dbtype)
            {
                scope.parentscope.dbtype.addSymbol(dbfunc);
            }
        }
        // Literal asset definitions
        else if (scope.previous.ast.type == node_types.AssetDefinition)
        {
            scope.assettype = scope.previous.ast.typename.value;
        }
    }

    // Add variables for each declaration inside the scope
    for (let i = 0; i < scope.statements.length; ++i)
    {
        let statement = scope.statements[i];
        if (!statement)
            continue;
        if (!statement.ast)
            continue;
        switch (statement.ast.type)
        {
            case node_types.ImportStatement:
            {
                // Mark the correct module as being imported
                if (statement.ast.children[0])
                {
                    let importedModule = GetModule(statement.ast.children[0].value);
                    scope.module.importedModules.push(importedModule);
                }
            }
            break;
            case node_types.VariableDecl:
            {
                // Add variables for declaration statements
                AddVarDeclToScope(scope, statement, statement.ast);
            }
            break;
            case node_types.VariableDeclMulti:
            {
                // Add variables for multiple declarations in one statement (eg `int X, Y;`)
                for (let child of statement.ast.children)
                    AddVarDeclToScope(scope, statement, child);
            }
            break;
            case node_types.ForLoop:
            {
                // Add variables declared inside a for loop to a new subscope scope covering the for loop's header statement
                if (!statement.generatedTypes)
                {
                    // Create a fake scope that spans this statement to contain the loop variables
                    let subscope = MoveStatementToSubScope(scope, statement, statement.ast.children[3], true);

                    // Add variables declared inside the for statement to subscope
                    if (statement.ast.children[0])
                    {
                        if (statement.ast.children[0].type == node_types.VariableDecl)
                        {
                            let loopVar = AddVarDeclToScope(subscope, statement, statement.ast.children[0], true);
                            if (loopVar)
                                loopVar.isLoopVariable = true;
                        }
                        else if (statement.ast.children[0].type == node_types.VariableDeclMulti)
                        {
                            for (let child of statement.ast.children[0].children)
                            {
                                let loopVar = AddVarDeclToScope(subscope, statement, child, true);
                                if (loopVar)
                                    loopVar.isLoopVariable = true;
                            }
                        }
                    }

                    // We moved the entire statement to a subscope, so remove it from this scope
                    scope.statements[i] = null;
                }
            }
            break;
            case node_types.ForEachLoop:
            {
                if (!statement.generatedTypes)
                {
                    // Create a fake scope that spans this statement to contain the loop variable
                    let subscope = MoveStatementToSubScope(scope, statement, statement.ast.children[3], true);
                    AddForEachVariableToScope(subscope, statement, statement.ast);

                    // We moved the entire statement to a subscope, so remove it from this scope
                    scope.statements[i] = null;
                }
            }
            break;
            case node_types.IfStatement:
            case node_types.ElseStatement:
            case node_types.ForLoop:
            case node_types.WhileLoop:
            case node_types.CaseStatement:
            case node_types.DefaultCaseStatement:
            {
                if (!statement.generatedTypes && statement.ast.children[statement.ast.children.length-1])
                {
                    // Make sure we create a subscope with the optional statement in it if we have one
                    MoveStatementToSubScope(scope, statement, statement.ast.children[statement.ast.children.length-1], false);
                }
            }
            break;
            case node_types.EventDecl:
            case node_types.DelegateDecl:
            {
                // Create the event or delegate type in the database from this statement
                let signature = statement.ast.children[0];
                if (signature)
                {
                    let dbtype = AddDBType(scope, signature.name.value);
                    dbtype.isStruct = true;
                    if (statement.ast.type == node_types.EventDecl)
                        dbtype.isEvent = true;
                    else
                        dbtype.isDelegate = true;

                    if (statement.ast.documentation)
                        dbtype.documentation = typedb.FormatDocumentationComment(statement.ast.documentation);
                    dbtype.moduleOffset = statement.start_offset + signature.name.start;
                    dbtype.moduleOffsetEnd = statement.start_offset + signature.name.end;

                    dbtype.delegateReturn = signature.returntype ? GetQualifiedTypename(signature.returntype) : "void";
                    dbtype.delegateArgs = [];
                    if (signature.parameters)
                    {
                        for (let param of signature.parameters)
                        {
                            // Add argument to type database
                            let dbarg = new typedb.DBArg();
                            dbarg.typename = GetQualifiedTypename(param.typename);
                            dbarg.name = param.name ? param.name.value : "";
                            dbtype.delegateArgs.push(dbarg);
                        }
                    }

                    scope.module.types.push(dbtype);
                }
            }
            break;
            case node_types.ImportFunctionStatement:
            {
                // Just create a function in this scope that shadows the imported function
                let funcdef = statement.ast.children[0];
                let dbfunc = AddDBMethod(scope, funcdef.name.value);
                if (funcdef.documentation)
                    dbfunc.documentation = typedb.FormatDocumentationComment(funcdef.documentation);
                dbfunc.moduleOffset = statement.start_offset + funcdef.name.start;
                dbfunc.moduleOffsetEnd = statement.start_offset + funcdef.name.end;

                if (funcdef.returntype)
                    dbfunc.returnType = GetQualifiedTypename(funcdef.returntype);
                else
                    dbfunc.returnType = "void";

                AddParametersToFunction(scope, statement, dbfunc, funcdef.parameters);

                let namespace = scope.getNamespace();

                scope.module.globalSymbols.push(dbfunc);
                namespace.addSymbol(dbfunc);
            }
            break;
            case node_types.AssetDefinition:
            {
                // Asset definitions are basically just global variables
                AddVarDeclToScope(scope, statement, statement.ast);
            }
            break;
            case node_types.EnumValueList:
            {
                if (scope.dbtype)
                {
                    for (let enumValue of statement.ast.children)
                    {
                        if (!enumValue)
                            continue;

                        // Add enum value to type database
                        let dbprop = new typedb.DBProperty();
                        dbprop.name = enumValue.name.value;
                        dbprop.typename = scope.dbtype.name;
                        if (enumValue.documentation)
                            dbprop.documentation = typedb.FormatDocumentationComment(enumValue.documentation);
                        dbprop.declaredModule = scope.module.modulename;
                        dbprop.moduleOffset = statement.start_offset + enumValue.name.start;
                        dbprop.moduleOffsetEnd = statement.start_offset + enumValue.name.end;

                        scope.dbtype.addSymbol(dbprop);
                    }
                }
            }
            break;
            case node_types.AccessDeclaration:
            {
                // Add the declared access specifier to the type
                AddAccessSpecifierToType(scope, statement, statement.ast);
            }
            break;
        }

        statement.generatedTypes = true;
    }

    // Recurse into subscopes
    for (let subscope of scope.scopes)
        GenerateTypeInformation(subscope);

    // If this was a struct and we haven't generated a default constructor, generate it now
    if (scope.scopetype == ASScopeType.Class && scope.dbtype && scope.dbtype.isStruct)
    {
        let namespace = scope.getNamespace();
        let hasDefaultConstructor = false;

        let constructors = namespace.findSymbols(scope.dbtype.name);
        for (let constr of constructors)
        {
            if (constr instanceof typedb.DBMethod)
            {
                if (constr.args.length == 0 && constr.returnType == scope.dbtype.name)
                {
                    hasDefaultConstructor = true;
                    break;
                }
            }
        }

        if (!hasDefaultConstructor)
        {
            let dbfunc = AddDBMethod(scope, scope.dbtype.name);
            dbfunc.moduleOffset = scope.start_offset;
            dbfunc.moduleOffsetEnd = scope.end_offset;
            dbfunc.isConstructor = true;

            dbfunc.documentation = scope.dbtype.documentation;
            dbfunc.returnType = scope.dbtype.name;

            namespace.addSymbol(dbfunc);
            scope.module.globalSymbols.push(dbfunc);
        }
    }
}

function AddAccessSpecifierToType(scope : ASScope, statement : ASStatement, node : any)
{
    if (!scope.dbtype)
        return;

    let spec = scope.dbtype.getAccessSpecifier(node.name.value);
    spec.isDeclared = true;
    spec.declaredModule = scope.module.modulename;
    spec.moduleOffset = statement.start_offset + node.name.start;
    spec.moduleOffsetEnd = statement.start_offset + node.name.end;

    if (node.classList)
    {
        for (let accessClass of node.classList)
        {
            if (accessClass.className.value == "*")
            {
                if (accessClass.mods)
                {
                    for (let mod of accessClass.mods)
                    {
                        if (mod.value == "editdefaults")
                            spec.bAnyEditDefaults = true;
                        else if (mod.value == "readonly")
                            spec.bAnyReadOnly = true;
                    }
                }
            }
            else if (accessClass.className.value == "private")
            {
                spec.isPrivate = true;
            }
            else if (accessClass.className.value == "protected")
            {
                spec.isProtected = true;
            }
            else
            {
                let cls = new typedb.DBAccessPermission();
                cls.accessName = accessClass.className.value;

                if (accessClass.mods)
                {
                    for (let mod of accessClass.mods)
                    {
                        if (mod.value == "editdefaults")
                            cls.bEditDefaults = true;
                        else if (mod.value == "readonly")
                            cls.bReadOnly = true;
                        else if (mod.value == "inherited")
                            cls.bInherited = true;
                    }
                }

                if (spec.permissions)
                    spec.permissions.push(cls);
                else
                    spec.permissions = [cls];
            }
        }
    }
}

// Either create a new scope for an optional statement after a control statement,
// or if there is no optional statement, pull the statement into the subsequent scope
function MoveStatementToSubScope(scope : ASScope, statement : ASStatement, optional_statement : any, move_main_statement : boolean) : ASScope
{
    let subscope : ASScope;

    // If we don't have an optional statement and we are placed before a scope, make that our scope
    if (!optional_statement && statement.next && statement.next instanceof ASScope)
    {
        subscope = statement.next;

        // Move the scope to start before the statement we're inserting
        if (move_main_statement)
            subscope.start_offset = statement.start_offset;
    }
    else
    {
        // Create a new subscope that encompasses just this statement
        subscope = new ASScope();
        subscope.parentscope = scope;
        subscope.module = scope.module;
        subscope.start_offset = statement.start_offset;
        if (!move_main_statement && optional_statement)
            subscope.start_offset += optional_statement.start;
        subscope.end_offset = statement.end_offset;
        subscope.scopetype = ASScopeType.Code;
        subscope.parsed = true;

        scope.scopes.push(subscope);

        subscope.previous = statement;
        subscope.next = statement.next
        if (statement.next)
            statement.next.previous = subscope;
        statement.next = subscope;
    }

    // Move the optional statement into the new scope
    if (optional_statement)
    {
        let newStatement = new ASStatement();
        newStatement.ast = optional_statement;
        newStatement.start_offset = statement.start_offset;
        newStatement.end_offset = statement.end_offset;
        newStatement.parsed = true;

        // If we're editing the first line, and it is a variable declaration,
        // don't move it into the new subscope, but leave it where it is.
        // This happens if we're in the middle of editing a new statement
        let moveToSubScope = true;
        if (optional_statement.type == node_types.VariableDecl
            && scope.module.isEditingInside(statement.start_offset, statement.end_offset))
        {
            if (scope.module.lastEditEnd <= statement.start_offset + optional_statement.typename.start)
                moveToSubScope = false;
        }

        if (moveToSubScope)
        {
            newStatement.next = subscope.element_head;
            if (subscope.element_head)
                subscope.element_head.previous = newStatement;
            subscope.element_head = newStatement;
            subscope.statements.push(newStatement);
        }
        else
        {
            newStatement.next = subscope.next;
            newStatement.previous = subscope;
            subscope.next = newStatement;

            scope.statements.push(newStatement);
        }
    }

    // Move the main statement to the new scope
    if (move_main_statement)
    {
        let prevStatement = statement.previous;
        let nextStatement = statement.next;
        if (prevStatement)
            prevStatement.next = nextStatement;
        if (nextStatement)
            nextStatement.previous = prevStatement;

        if (scope.element_head == statement)
            scope.element_head = nextStatement;

        statement.previous = null;
        statement.next = subscope.element_head;
        if (subscope.element_head)
            subscope.element_head.previous = statement;
        subscope.element_head = statement;

        subscope.statements.push(statement);
    }

    return subscope;
}

// Add a variable to the scope that matches the loop variable in a foreach statement
function AddForEachVariableToScope(scope : ASScope, statement : ASStatement, node : any)
{
    if (!node.children[0])
        return;
    if (!node.children[1])
        return;

    // Add a local variable for the loop iterator
    let asvar = new ASVariable();
    asvar.name = node.children[1].value;
    asvar.typename = GetQualifiedTypename(node.children[0]);
    asvar.node_typename = node.children[0];
    asvar.node_expression = node.children[2];
    asvar.isAuto = node.children[0].value == 'auto';
    asvar.isIterator = true;
    asvar.in_statement = true;

    asvar.start_offset_type = statement.start_offset + node.children[0].start;
    asvar.end_offset_type = statement.start_offset + node.children[0].end;

    asvar.start_offset_name = statement.start_offset + node.children[1].start;
    asvar.end_offset_name = statement.start_offset + node.children[1].end;

    if (node.children[2])
    {
        asvar.start_offset_expression = statement.start_offset + node.children[2].start;
        asvar.end_offset_expression = statement.start_offset + node.children[2].end;
    }

    scope.variables.push(asvar);
    scope.variablesByName.set(asvar.name, asvar);
}

function AddIdentifierSymbol(scope : ASScope, statement : ASStatement, node : any, type : ASSymbolType, container_type : typedb.DBType | string = null, symbol_name : string = null, isWriteAccess : boolean = false) : ASSemanticSymbol
{
    if (!node)
        return null;
    let symbol = new ASSemanticSymbol;
    symbol.type = type;
    symbol.start = node.start + statement.start_offset;
    symbol.end = node.end + statement.start_offset;
    if (container_type instanceof typedb.DBType)
        symbol.container_type = container_type.name;
    else
        symbol.container_type = container_type;
    symbol.symbol_name = symbol_name;
    symbol.isWriteAccess = isWriteAccess;

    scope.module.semanticSymbols.push(symbol);
    return symbol;
}

function AddUnknownSymbol(scope : ASScope, statement: ASStatement, node : any, hasPotentialCompletions : boolean)
{
    if (!node)
        return;

    if (hasPotentialCompletions)
    {
        // If we are currently editing the document at the position of this symbol,
        // then we don't actually want to show it as an error if it can still become a valid symbol later
        if (scope.module.isEditingNode(statement, node))
            return;
    }

    AddIdentifierSymbol(scope, statement, node, ASSymbolType.UnknownError);
}

function DoesTypenameExist(scope : ASScope, name : string) : boolean | typedb.DBType
{
    // Could be a type
    let dbtype = typedb.LookupType(scope.getNamespace(), name);
    if (dbtype)
        return dbtype;

    // Could be auto
    if (name == 'auto')
        return true;

    return false;
}

function AddTypenameSymbol(scope : ASScope, statement : ASStatement, node : any, errorOnUnknown = true) : ASSemanticSymbol
{
    if (!node)
        return null;
    if (node.basetype)
    {
        let baseSymbol : ASSemanticSymbol = null;
        if (errorOnUnknown && !DoesTypenameExist(scope, node.basetype.value))
        {
            let hasPotentialCompletions = false;
            AddUnknownSymbol(scope, statement, node.basetype, hasPotentialCompletions);
        }
        else
        {
            baseSymbol = AddIdentifierSymbol(scope, statement, node.basetype, ASSymbolType.TemplateBaseType, null, node.basetype.value);
        }

        for (let child of node.subtypes)
            AddTypenameSymbol(scope, statement, child, errorOnUnknown);
        return baseSymbol;
    }
    else
    {
        let exists = DoesTypenameExist(scope, node.name.value);
        if (errorOnUnknown && !exists)
        {
            let hasPotentialCompletions = false;
            if (scope.module.isEditingNode(statement, node))
                hasPotentialCompletions = typedb.HasTypeWithPrefix(scope.getNamespace(), node.name.value);
            AddUnknownSymbol(scope, statement, node.name, hasPotentialCompletions);
            scope.module.markDependencyIdentifier(node.name.value);
            return null;
        }
        else
        {
            // Typenames can contain namespaces, which should emit individual symbols
            let namespaceIndex = node.name.value.indexOf("::");
            if (namespaceIndex != -1)
            {
                let prevNamespaceIndex = 0;
                let lookupNamespace = scope.getNamespace();

                if (namespaceIndex == 0)
                {
                    prevNamespaceIndex = 2;
                    namespaceIndex = node.name.value.indexOf("::", prevNamespaceIndex);
                    lookupNamespace = null;
                }

                while (namespaceIndex != -1)
                {
                    // Add a symbol for this namespace
                    let symbol = new ASSemanticSymbol;
                    symbol.start = node.name.start + statement.start_offset + prevNamespaceIndex;
                    symbol.end = node.name.start + statement.start_offset + namespaceIndex;

                    let namespace = typedb.LookupNamespace(lookupNamespace, node.name.value.substring(0, namespaceIndex));
                    if (namespace)
                    {
                        symbol.type = ASSymbolType.Namespace;
                        symbol.container_type = null;
                        symbol.symbol_name = namespace.getQualifiedNamespace();
                    }
                    else
                    {
                        symbol.type = ASSymbolType.UnknownError;
                    }

                    scope.module.semanticSymbols.push(symbol);

                    // Find the next separator
                    prevNamespaceIndex = namespaceIndex + 2;
                    namespaceIndex = node.name.value.indexOf("::", prevNamespaceIndex);
                }

                // Add a symbol for the actual typename
                {
                    let symbol = new ASSemanticSymbol;
                    symbol.start = node.name.start + statement.start_offset + prevNamespaceIndex;
                    symbol.end = node.name.end + statement.start_offset;
                    symbol.type = ASSymbolType.Typename;
                    symbol.container_type = null;
                    symbol.symbol_name = node.name.value.substring(prevNamespaceIndex);
                    scope.module.semanticSymbols.push(symbol);
                }
            }
            else
            {
                let addSymbol = AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, node.name.value);
                if (exists instanceof typedb.DBType)
                {
                    if (exists.isEnum)
                        addSymbol.symbol_name = exists.name;
                    if (exists.declaredModule && !ScriptSettings.automaticImports && !scope.module.isModuleImported(exists.declaredModule))
                        addSymbol.isUnimported = true;
                    scope.module.markDependencyType(exists);
                }
                return addSymbol;
            }
        }
    }
}

function AddAccessSpecifierSymbol(scope : ASScope, statement : ASStatement, node : any, errorOnUnknown = true) : ASSemanticSymbol
{
    if (!node)
        return null;
    if (node.value == "private" || node.value == "protected")
        return null;

    let dbtype = scope.getParentType();
    if (!dbtype)
        return null;

    let spec = dbtype.getAccessSpecifier(node.value, false);
    if (!spec || !spec.isDeclared)
    {
        if (errorOnUnknown && !scope.module.isEditingNode(statement, node))
            AddUnknownSymbol(scope, statement, node, false);
        return null;
    }
    else
    {
        return AddIdentifierSymbol(scope, statement, node, ASSymbolType.AccessSpecifier, dbtype.name, node.value);
    }
}

function UpdateAutoTypenameSymbol(symbol : ASSemanticSymbol, expressionType : typedb.DBSymbol | typedb.DBType)
{
    if (!symbol)
        return;

    symbol.isAuto = true;
    if (!expressionType)
        return;

    if (expressionType instanceof typedb.DBType)
    {
        symbol.container_type = null;
        symbol.symbol_name = expressionType.name;
    }
    else if(expressionType instanceof typedb.DBProperty)
    {
        symbol.container_type = null;
        symbol.symbol_name = expressionType.typename;
    }
}

function ResolveAutos(scope : ASScope)
{
    for (let asvar of scope.variables)
    {
        if (!asvar.isAuto)
            continue;
        if (!asvar.node_expression)
            continue;

        let resolvedType = ResolveTypeFromExpression(scope, asvar.node_expression);
        if (resolvedType && asvar.isIterator)
            resolvedType = ResolveIteratorType(resolvedType);
        if (resolvedType)
        {
            let typename = resolvedType.getQualifiedTypenameInNamespace(scope.getNamespace());
            asvar.typename = CopyQualifiersToTypename(asvar.node_typename, typename);
        }
    }

    for (let subscope of scope.scopes)
        ResolveAutos(subscope);
}

export function IsPrimitiveLiteralNode(node : any) : boolean
{
    if (!node)
        return false;

    switch (node.type)
    {
        case node_types.ConstBool:
        case node_types.ConstDouble:
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        case node_types.ConstOctalInteger:
        case node_types.ConstBinaryInteger:
        case node_types.ConstFloat:
            return true;
    }

    return false;
}

export function ResolveTypeFromExpression(scope : ASScope, node : any) : typedb.DBType
{
    if (!node)
        return null;

    switch (node.type)
    {
        // X
        case node_types.Identifier:
        {
            return ResolveTypeFromIdentifier(scope, node.value);
        }
        break;
        // 0.f
        case node_types.ConstFloat:
        {
            if (ScriptSettings.floatIsFloat64)
                return typedb.GetTypeByName("float32");
            else
                return typedb.GetTypeByName("float");
        }
        break;
        // 0.0
        case node_types.ConstDouble:
        {
            if (ScriptSettings.floatIsFloat64)
                return typedb.GetTypeByName("float");
            else
                return typedb.GetTypeByName("double");
        }
        // 0
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        case node_types.ConstOctalInteger:
        case node_types.ConstBinaryInteger:
        {
            return typedb.GetTypeByName("int");
        }
        break;
        // "X"
        case node_types.ConstString:
        {
            return typedb.GetTypeByName("FString");
        }
        break;
        // n"X"
        case node_types.ConstName:
        {
            return typedb.GetTypeByName("FName");
        }
        break;
        // f"X"
        case node_types.ConstFormatString:
        {
            return typedb.GetTypeByName("FString");
        }
        break;
        // true/false
        case node_types.ConstBool:
        {
            return typedb.GetTypeByName("bool");
        }
        // this
        case node_types.This:
        {
            return scope.getParentType();
        }
        // nullptr
        case node_types.ConstNullptr:
        {
            return typedb.GetTypeByName("UObject");
        }
        // X.Y
        case node_types.MemberAccess:
        {
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            if (!left_type || !node.children[1])
                return null;
            return ResolvePropertyType(left_type, node.children[1].value);
        }
        break;
        // X::Y()
        case node_types.NamespaceAccess:
        {
            if (!node.children[1])
                return null;

            let fullNamespace = CollapseNamespaceFromNode(node.children[0]);
            if (fullNamespace == "Super" && scope.getParentType())
            {
                let superType = scope.getParentType().getSuperType();
                if (!superType)
                    return null;
                return ResolvePropertyType(superType, node.children[1].value);
            }
            else
            {
                let shadowedType = typedb.LookupType(scope.getNamespace(), fullNamespace);
                if (shadowedType && shadowedType.isEnum)
                    return ResolvePropertyType(shadowedType, node.children[1].value);

                let nsSymbol = ResolveNamespacePropertyType(scope.getNamespace(), fullNamespace, node.children[1].value);
                if (nsSymbol)
                    return nsSymbol;

                // We might be calling a function in a superclass scope
                if (shadowedType && scope.getParentType() && scope.getParentType().inheritsFrom(shadowedType.name))
                    return ResolvePropertyType(shadowedType, node.children[1].value);

                return null;
            }
        }
        break;
        // X()
        case node_types.FunctionCall:
        {
            let left_func = ResolveFunctionFromExpression(scope, node.children[0]);
            if (!left_func)
            {
                // Check if this is a constructor to some type
                if (node.children[0] && node.children[0].type == node_types.Identifier)
                {
                    let constrType = typedb.LookupType(scope.getNamespace(), node.children[0].value);
                    if (constrType)
                        return constrType;
                }
                return null;
            }
            return typedb.LookupType(left_func.namespace, left_func.returnType);
        }
        break;
        // TType<TSubType>()
        case node_types.ConstructorCall:
            if (!node.children[0] || !node.children[0].value)
                return null;
            return typedb.LookupType(scope.getNamespace(), node.children[0].value);
        break;
        // X[]
        case node_types.IndexOperator:
        {
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            if (!left_type)
                return null;
            return ResolveTypeFromOperator(scope, left_type, null, "opIndex");
        }
        break;
        // Cast<X>()
        case node_types.CastOperation:
        {
            if (!node.children[0] || !node.children[0].value)
                return null;
            return typedb.LookupType(scope.getNamespace(), node.children[0].value);
        }
        break;
        // X * Y
        case node_types.BinaryOperation:
        {
            if (!node.operator)
                return null;

            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            let right_type = ResolveTypeFromExpression(scope, node.children[1]);
            return ResolveTypeFromOperator(scope, left_type, right_type, getBinaryOperatorOverloadMethod(node.operator));
        }
        break;
        // -X
        case node_types.UnaryOperation:
        {
            if (!node.operator)
                return null;
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            return ResolveTypeFromOperator(scope, left_type, null, getUnaryOperatorOverloadMethod(node.operator));
        }
        break;
        // X++
        case node_types.PostfixOperation:
        {
            if (!node.operator)
                return null;
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            return ResolveTypeFromOperator(scope, left_type, null, getPostfixOperatorOverloadMethod(node.operator));
        }
        break;
        // X ? Y : Z
        case node_types.TernaryOperation:
        {
            let left_type = ResolveTypeFromExpression(scope, node.children[1]);
            let right_type = ResolveTypeFromExpression(scope, node.children[2]);

            if (left_type)
            {
                if (right_type)
                {
                    if (left_type != right_type && !left_type.isValueType() && !right_type.isValueType())
                    {
                        // Find the common baseclass
                        let target_type = left_type;
                        while (target_type && !right_type.inheritsFrom(target_type.name))
                            target_type = target_type.getSuperType();

                        if (target_type)
                            return target_type;
                        else
                            return left_type;
                    }
                }
                else
                {
                    return left_type;
                }
            }
            else
            {
                return right_type;
            }
            return null;
        }
        break;
    }
    return null;
}

export function GetOverloadMethodForOperator(operator : string) : string
{
    switch (operator)
    {
        case "+": return "opAdd";
        case "-": return "opSub";
        case "*": return "opMul";
        case "/": return "opDiv";
        case "%": return "opMod";
        case "**": return "opPow";
        case "&": return "opAnd";
        case "|": return "opOr";
        case "^": return "opXor";
        case "<<": return "opShl";
        case ">>": return "opShr";
        case ">>>": return "opUShr";
        case "==": return "opEquals";
        case "!=": return "opEquals";
        case "<": return "opCmp";
        case ">": return "opCmp";
        case ">=": return "opCmp";
        case "<=": return "opCmp";
        case "-": return "opNeg";
        case "~": return "opCom";
        case "++": return "opPreInc";
        case "--": return "opPreDec";
        case "++": return "opPostInc";
        case "--": return "opPostDec";
        case "+=": return "opAddAssign";
        case "-=": return "opSubAssign";
        case "*=": return "opMulAssign";
        case "/=": return "opDivAssign";
        case "%=": return "opModAssign";
        case "**=": return "opPowAssign";
        case "|=": return "opOrAssign";
        case "&=": return "opAndAssign";
        case "^=": return "opXorAssign";
        case "<<=": return "opShlAssign";
        case ">>=": return "opShrAssign";
        case ">>>=": return "opUShrAssign";
    }

    return null;
}

function getBinaryOperatorOverloadMethod(operator : any) : string
{
    switch (operator)
    {
        case "+": return "opAdd";
        case "-": return "opSub";
        case "*": return "opMul";
        case "/": return "opDiv";
        case "%": return "opMod";
        case "**": return "opPow";
        case "&": return "opAnd";
        case "|": return "opOr";
        case "^": return "opXor";
        case "<<": return "opShl";
        case ">>": return "opShr";
        case ">>>": return "opUShr";
        case "==": return "BOOLEAN";
        case "!=": return "BOOLEAN";
        case "<": return "BOOLEAN";
        case ">": return "BOOLEAN";
        case ">=": return "BOOLEAN";
        case "<=": return "BOOLEAN";
        case "&&": return "BOOLEAN";
        case "||": return "BOOLEAN";
    }

    return operator;
}

function getUnaryOperatorOverloadMethod(operator : any) : string
{
    switch (operator)
    {
        case "-": return "opNeg";
        case "~": return "opCom";
        case "++": return "opPreInc";
        case "--": return "opPreDec";
        case "!": return "BOOLEAN";
    }

    return operator;
}

function getPostfixOperatorOverloadMethod(operator : any) : string
{
    switch (operator)
    {
        case "++": return "opPostInc";
        case "--": return "opPostDec";
    }

    return operator;
}

function ResolveIteratorType(dbtype : typedb.DBType) : typedb.DBType
{
    if (!dbtype)
        return null;

    // Check if we have an iterator method
    let iterator_sym = dbtype.findFirstSymbol("Iterator", typedb.DBAllowSymbol.Functions);
    if (iterator_sym && iterator_sym instanceof typedb.DBMethod)
    {
        // Check the return type of the method
        let return_type = typedb.LookupType(iterator_sym.namespace, iterator_sym.returnType);
        if (!return_type)
            return dbtype;

        // Check the Proceed method of the iterator and take its return value as the type
        let proceed_sym = return_type.findFirstSymbol("Proceed", typedb.DBAllowSymbol.Functions);
        if (proceed_sym && proceed_sym instanceof typedb.DBMethod)
        {
            let proceed_return = typedb.LookupType(proceed_sym.namespace, proceed_sym.returnType);
            if (proceed_return)
                return proceed_return;
        }
    }

    return dbtype;
}

function ResolvePropertyType(dbtype : typedb.DBType, name : string) : typedb.DBType
{
    if (!dbtype || !name)
        return null;

    // Find property with this name
    let usedSymbol = dbtype.findFirstSymbol(name, typedb.DBAllowSymbol.Properties);
    if (usedSymbol && usedSymbol instanceof typedb.DBProperty)
        return typedb.LookupType(dbtype.namespace, usedSymbol.typename);

    // Find get accessor
    let getAccessor = dbtype.findFirstSymbol("Get"+name, typedb.DBAllowSymbol.Functions);
    if (getAccessor && getAccessor instanceof typedb.DBMethod)
    {
        if (getAccessor.isProperty)
            return typedb.LookupType(dbtype.namespace, getAccessor.returnType);
    }

    // Find set accessor
    let setAccessor = dbtype.findFirstSymbol("Set"+name, typedb.DBAllowSymbol.Functions);
    if (setAccessor && setAccessor instanceof typedb.DBMethod)
    {
        if (setAccessor.isProperty && setAccessor.args.length != 0)
            return typedb.LookupType(dbtype.namespace, setAccessor.args[0].typename);
    }

    return null;
}

export function CollapseNamespaceFromNode(node : any) : string
{
    if (!node)
        return "::";
    if (node.type == node_types.Identifier)
        return node.value;

    let namespace = "";
    let checkNode = node;
    while (checkNode)
    {
        if (checkNode.children[1])
        {
            if (namespace.length == 0)
                namespace = checkNode.children[1].value;
            else
                namespace = checkNode.children[1].value + "::" + namespace;
        }

        if (checkNode.children[0] && checkNode.children[0].type == node_types.Identifier)
        {
            if (namespace.length == 0)
                namespace = checkNode.children[0].value;
            else
                namespace = checkNode.children[0].value + "::" + namespace;
            break;
        }
        else
        {
            checkNode = checkNode.children[0];
            if (!checkNode)
                namespace = "::" + namespace;
        }
    }

    return namespace;
}

function ResolveNamespacePropertyType(dbnamespace : typedb.DBNamespace, nsPrefix : string, name : string) : typedb.DBType
{
    if (!dbnamespace || !name)
        return null;

    // Find property with this name
    let propName = name;
    if (nsPrefix && nsPrefix.length != 0)
        propName = nsPrefix + "::" + propName;

    let globalSymbols = typedb.LookupGlobalSymbol(dbnamespace, propName, typedb.DBAllowSymbol.Properties);
    if (globalSymbols && globalSymbols.length != 0 && globalSymbols[0] instanceof typedb.DBProperty)
        return typedb.LookupType(globalSymbols[0].namespace, globalSymbols[0].typename);

    // Find get accessor
    let getterName = "Get"+name;
    if (nsPrefix && nsPrefix.length != 0)
        getterName = nsPrefix + "::" + getterName;

    let getAccessors = typedb.LookupGlobalSymbol(dbnamespace, getterName, typedb.DBAllowSymbol.Functions);
    if (getAccessors && getAccessors.length != 0 && getAccessors[0] instanceof typedb.DBMethod)
    {
        if (getAccessors[0].isProperty)
            return typedb.LookupType(getAccessors[0].namespace, getAccessors[0].returnType);
    }

    // Find set accessor
    let setterName = "Set"+name;
    if (nsPrefix && nsPrefix.length != 0)
        setterName = nsPrefix + "::" + getterName;

    let setAccessors = typedb.LookupGlobalSymbol(dbnamespace, setterName, typedb.DBAllowSymbol.Functions);
    if (setAccessors && setAccessors.length != 0 && setAccessors[0] instanceof typedb.DBMethod)
    {
        if (setAccessors[0].isProperty && setAccessors[0].args.length != 0)
            return typedb.LookupType(dbnamespace, setAccessors[0].args[0].typename);
    }

    return null;
}

function ResolveTypeFromIdentifier(scope : ASScope, identifier : string) : typedb.DBType
{
    // Find a local variable by this name
    let checkscope = scope;
    while (checkscope && checkscope.isInFunctionBody())
    {
        let usedVariable = checkscope.variablesByName.get(identifier);
        if (usedVariable)
            return typedb.LookupType(checkscope.getNamespace(), usedVariable.typename);
        checkscope = checkscope.parentscope;
    }

    // Find a symbol in the class we're in
    let insideType = scope.getParentType();
    if (insideType)
    {
        let usedType = ResolvePropertyType(insideType, identifier);
        if (usedType)
            return usedType;
    }

    // Find a symbol in global or namespace scope
    let globalSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), identifier, typedb.DBAllowSymbol.Properties);
    if (globalSymbols)
    {
        for (let sym of globalSymbols)
        {
            if (sym instanceof typedb.DBProperty)
            {
                if (!sym.isLiteralAsset && sym.declaredModule != scope.module.modulename)
                    continue;
                return typedb.LookupType(sym.namespace, sym.typename);
            }
        }

        if (!ScriptSettings.automaticImports)
        {
            for (let sym of globalSymbols)
            {
                if (sym instanceof typedb.DBProperty)
                    return typedb.LookupType(sym.namespace, sym.typename);
            }
        }
    }

    // Find an unimported global get accessor
    let getSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), "Get"+identifier, typedb.DBAllowSymbol.Functions);
    if (getSymbols)
    {
        for (let sym of getSymbols)
        {
            if (sym instanceof typedb.DBMethod && sym.isProperty && sym.returnType && !sym.isMixin)
            {
                if (sym.isLocal && !sym.IsAccessibleFromModule(scope.module.modulename))
                    continue;
                return typedb.LookupType(sym.namespace, sym.returnType);
            }
        }
    }

    // Find an unimported global set accessor
    let setSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), "Set"+identifier, typedb.DBAllowSymbol.Functions);
    if (setSymbols)
    {
        for (let sym of setSymbols)
        {
            if (sym instanceof typedb.DBMethod && sym.isProperty && sym.args.length > 0 && !sym.isMixin)
            {
                if (sym.isLocal && !sym.IsAccessibleFromModule(scope.module.modulename))
                    continue;
                return typedb.LookupType(sym.namespace, sym.args[0].typename);
            }
        }
    }

    return null;
}

function ResolveTypeFromOperator(scope : ASScope, leftType : typedb.DBType, rightType : typedb.DBType, operator : string) : typedb.DBType
{
    if (!operator)
        return null;

    // Some operators always return bools
    if (operator == "BOOLEAN")
        return typedb.GetTypeByName("bool");

    // If both types are primitives we upgrade to the highest
    if (leftType && leftType.isPrimitive && rightType && rightType.isPrimitive)
    {
        if (leftType.name == "double")
            return leftType;
        if (leftType.name == "float64")
            return leftType;
        if (rightType.name == "double")
            return rightType;
        if (rightType.name == "float64")
            return rightType;
        if (leftType.name == "float")
            return leftType;
        if (rightType.name == "float")
            return rightType;
        if (leftType.name == "float32")
            return leftType;
        if (rightType.name == "float32")
            return rightType;
        return leftType;
    }
    else if (!rightType && leftType && leftType.isPrimitive)
    {
        return leftType;
    }

    // Try the operator overload for the left side
    if (leftType)
    {
        let sym = leftType.findFirstSymbol(operator);
        if (sym && sym instanceof typedb.DBMethod)
            return typedb.LookupType(sym.namespace, sym.returnType);
    }

    // Try the operator overload for the right side
    if (rightType)
    {
        let sym_r = rightType.findFirstSymbol(operator+"_r");
        if (sym_r && sym_r instanceof typedb.DBMethod)
            return typedb.LookupType(sym_r.namespace, sym_r.returnType);
    }

    return null;
}

export function ResolveFunctionFromExpression(scope : ASScope, node : any) : typedb.DBMethod
{
    if (!node)
        return null;

    switch (node.type)
    {
        // X()
        case node_types.Identifier:
        {
            return ResolveFunctionFromIdentifier(scope, node.value);
        }
        break;
        // X.Y()
        case node_types.MemberAccess:
        {
            if (!node.children[0] || !node.children[1])
                return null;
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            if (!left_type)
                return null;
            return ResolveFunctionFromType(scope, left_type, node.children[1].value, true);
        }
        break;
        // X::Y()
        case node_types.NamespaceAccess:
        {
            if (!node.children[1])
                return null;

            let fullNamespace = CollapseNamespaceFromNode(node.children[0]);
            let insideType = scope.getParentType();
            if (insideType)
            {
                // Access the super type
                if (fullNamespace == "Super")
                {
                    let superType = scope.getParentType().getSuperType();
                    if (superType)
                        return ResolveFunctionFromType(scope, superType, node.children[1].value);
                    else
                        return null;
                }

                // If we inherit from this class, we could be accessing a function in a super scope
                let superClass = typedb.LookupType(scope.getNamespace(), fullNamespace);
                if (superClass && insideType.inheritsFrom(superClass.name))
                {
                    let superSymbol = ResolveFunctionFromType(scope, superClass, node.children[1].value);
                    if(superSymbol)
                        return superSymbol;
                }
            }

            // Access a function in the namespace
            let namespaceSymbol = ResolveFunctionFromNamespace(scope, scope.getNamespace(), fullNamespace, node.children[1].value);
            if (namespaceSymbol)
                return namespaceSymbol;

            return null;
        }
        break;
    }
    return null;
}

function ResolveFunctionFromType(scope : ASScope, dbtype : typedb.DBType, name : string, allowMixin = false) : typedb.DBMethod
{
    if (!dbtype || !name)
        return null;

    // Find function with this name
    let usedSymbol = dbtype.findFirstSymbol(name, typedb.DBAllowSymbol.Functions);
    if (usedSymbol && usedSymbol instanceof typedb.DBMethod)
        return usedSymbol;

    if (allowMixin)
    {
        // Find a symbol in global scope
        let globalSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), name, typedb.DBAllowSymbol.Mixins);
        if (globalSymbols)
        {
            for (let usedSymbol of globalSymbols)
            {
                if(usedSymbol instanceof typedb.DBMethod)
                {
                    if (!usedSymbol.isMixin)
                        continue;
                    if (usedSymbol.isLocal && !usedSymbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    if (usedSymbol.args.length != 0 && dbtype.inheritsFrom(usedSymbol.args[0].typename))
                        return usedSymbol;
                }
            }
        }
    }

    return null;
}

function ResolveFunctionFromIdentifier(scope : ASScope, identifier : string) : typedb.DBMethod
{
    // Find a symbol in the class we're in
    let insideType = scope.getParentType();
    if (insideType)
    {
        let usedFunc = ResolveFunctionFromType(scope, insideType, identifier, true);
        if (usedFunc)
            return usedFunc;
    }

    // Find a symbol in global scope
    let globalSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), identifier,
        typedb.DBAllowSymbol.Functions | typedb.DBAllowSymbol.Mixins);
    if (globalSymbols)
    {
        for (let sym of globalSymbols)
        {
            if (sym instanceof typedb.DBMethod)
            {
                if (sym.isLocal && !sym.IsAccessibleFromModule(scope.module.modulename))
                    continue;
                if (sym.isMixin)
                {
                    if (insideType)
                    {
                        if (sym.args.length == 0 || !insideType.inheritsFrom(sym.args[0].typename))
                            continue;
                    }
                    else
                    {
                        continue;
                    }
                }
                return sym;
            }
        }
    }

    return null;
}

export function DisambiguateFunctionOverloadsFromOverriddenFunctions(functions : Array<typedb.DBMethod>)
{
    // Remove any function from the list that are from a base class that already has a child class' function in it
    if (!functions)
        return;
    for (let i = 0; i < functions.length; ++i)
    {
        let insideType = functions[i].containingType;
        if (!insideType)
            continue;

        let hasOverriddenFunction = false;
        for (let j = 0; j < functions.length; ++j)
        {
            let compareType = functions[j].containingType;
            if (i == j)
                continue;
            if (!compareType)
                continue;
            if (!functions[i].isSignatureEqual(functions[j]))
                continue;

            if (compareType.inheritsFrom(insideType.name))
            {
                hasOverriddenFunction = true;
                break;
            }
        }

        if (hasOverriddenFunction)
        {
            functions.splice(i, 1);
            i -= 1;
        }
    }
}

export function ResolveFunctionOverloadsFromExpression(scope : ASScope, node : any, functions : Array<typedb.DBMethod>)
{
    if (!node)
        return;

    switch (node.type)
    {
        // X()
        case node_types.Identifier:
        {
            ResolveFunctionOverloadsFromIdentifier(scope, node.value, functions);
        }
        break;
        // X.Y()
        case node_types.MemberAccess:
        {
            if (!node.children[0] || !node.children[1])
                return;
            let left_type = ResolveTypeFromExpression(scope, node.children[0]);
            if (!left_type)
                return;
            ResolveFunctionOverloadsFromType(scope, left_type, node.children[1].value, true, functions);
        }
        break;
        // X::Y()
        case node_types.NamespaceAccess:
        {
            if (!node.children[1])
                return;

            let fullNamespace = CollapseNamespaceFromNode(node.children[0]);
            let insideType = scope.getParentType();
            if (insideType)
            {
                // Access the super type
                if (fullNamespace == "Super")
                {
                    let superType = scope.getParentType().getSuperType();
                    if (superType)
                        ResolveFunctionOverloadsFromType(scope, superType, node.children[1].value, false, functions);
                    return;
                }

                // If we inherit from this class, we could be accessing a function in a super scope
                let nsClass = typedb.LookupType(scope.getNamespace(), fullNamespace);
                if (nsClass && insideType.inheritsFrom(nsClass.name))
                    ResolveFunctionOverloadsFromType(scope, nsClass, node.children[1].value, false, functions);
            }

            // Access a function in the namespace
            ResolveFunctionOverloadsFromNamespace(scope, scope.getNamespace(), fullNamespace, node.children[1].value, false, functions);
        }
        break;
    }
}

function ResolveFunctionOverloadsFromType(scope : ASScope, dbtype : typedb.DBType, name : string, allowMixin = false, functions : Array<typedb.DBMethod>)
{
    if (!dbtype || !name)
        return;

    // Find function with this name
    {
        let usedSymbols = dbtype.findSymbols(name);
        if (usedSymbols)
        {
            for (let symbol of usedSymbols)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    if (symbol.isMixin)
                        continue;
                    if (symbol.isLocal && !symbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    functions.push(symbol);
                }
            }
        }
    }

    if (allowMixin)
    {
        // Check if this is a mixin call in a global scope
        let globalSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), name, typedb.DBAllowSymbol.Mixins);
        if (globalSymbols)
        {
            for (let symbol of globalSymbols)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    if (!symbol.isMixin)
                        continue;
                    if (symbol.isLocal && !symbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    if (symbol.args.length != 0 && dbtype.inheritsFrom(symbol.args[0].typename))
                        functions.push(symbol);
                }
            }
        }
    }
}

function ResolveFunctionOverloadsFromNamespace(scope : ASScope, namespace : typedb.DBNamespace, nsPrefix : string, name : string, allowMixin = false, functions : Array<typedb.DBMethod>)
{
    if (!namespace || !name)
        return;

    // Find function with this name
    let identifier = name;
    if (nsPrefix && nsPrefix.length != 0)
        identifier = nsPrefix + "::" + name;

    {
        let globalSymbols = typedb.LookupGlobalSymbol(namespace, identifier, typedb.DBAllowSymbol.Functions);
        if (globalSymbols)
        {
            for (let symbol of globalSymbols)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    if (symbol.isMixin)
                        continue;
                    if (symbol.isLocal && !symbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    functions.push(symbol);
                }
            }
        }
    }
}

function ResolveFunctionFromNamespace(scope : ASScope, namespace : typedb.DBNamespace, nsPrefix : string, name : string) : typedb.DBMethod
{
    if (!namespace || !name)
        return null;

    // Find function with this name
    let identifier = name;
    if (nsPrefix && nsPrefix.length != 0)
        identifier = nsPrefix + "::" + name;

    let globalSymbols = typedb.LookupGlobalSymbol(namespace, identifier, typedb.DBAllowSymbol.Functions);
    if (globalSymbols && globalSymbols.length != 0 && globalSymbols[0] instanceof typedb.DBMethod)
        return globalSymbols[0];

    return null;
}

export function ResolveFunctionOverloadsFromIdentifier(scope : ASScope, identifier : string, functions : Array<typedb.DBMethod>, allowMixin = true)
{
    // Find a symbol in the class we're in
    let insideType = scope.getParentType();
    if (insideType)
        ResolveFunctionOverloadsFromType(scope, insideType, identifier, allowMixin, functions);

    // Find unimported global symbols
    let globalSyms = typedb.LookupGlobalSymbol(scope.getNamespace(), identifier);
    if (globalSyms)
    {
        for (let sym of globalSyms)
        {
            if (sym instanceof typedb.DBMethod)
            {
                if (sym.isMixin)
                    continue;
                if (functions.includes(sym))
                    continue;
                functions.push(sym);
            }
        }
    }
}

function DetectScopeSymbols(scope : ASScope) : ASParseContext
{
    // Look at each statement to see if it has symbols
    let element = scope.element_head;
    let parseContext = new ASParseContext();
    while (element)
    {
        if (element instanceof ASStatement)
        {
            if (element.ast)
            {
                parseContext.isRootIdentifier = true;
                DetectNodeSymbols(scope, element, element.ast, parseContext, typedb.DBAllowSymbol.Properties | typedb.DBAllowSymbol.Functions);
            }
        }
        else if (element instanceof ASScope)
        {
            DetectScopeSymbols(element);
        }
        element = element.next;
    }
    return parseContext;
}

function GetTypeFromSymbol(symbol : typedb.DBSymbol | typedb.DBType)
{
    if (symbol instanceof typedb.DBProperty)
        return typedb.LookupType(symbol.namespace, symbol.typename);
    else if (symbol instanceof typedb.DBType)
        return symbol;
    else
        return null;
}

class ASParseContext
{
    allow_errors : boolean = true;
    isWriteAccess : boolean = false;
    isRootIdentifier : boolean = false;
    argumentFunction : typedb.DBMethod = null;
};

export function GetConstantNumberFromNode(node : any) : [boolean, number]
{
    if (!node)
        return [false, 0.0];

    switch (node.type)
    {
        case node_types.ConstDouble:
            return [true, parseFloat(node.value)];
        case node_types.ConstFloat:
            return [true, parseFloat(node.value.substring(0, node.value.length - 1))];
        case node_types.ConstInteger:
            return [true, parseInt(node.value)];
        case node_types.ConstHexInteger:
            return [true, parseInt(node.value.substring(2), 16)];
        case node_types.ConstOctalInteger:
            return [true, parseInt(node.value.substring(2), 8)];
        case node_types.ConstBinaryInteger:
            return [true, parseInt(node.value.substring(2), 2)];
        break;
    }
    return [false, 0.0];
}

function DetectNodeSymbols(scope : ASScope, statement : ASStatement, node : any, parseContext : ASParseContext, symbol_type : typedb.DBAllowSymbol = typedb.DBAllowSymbol.Properties) : typedb.DBSymbol | typedb.DBType
{
    if (!node)
        return;

    let outerWriteAccess = parseContext.isWriteAccess;
    let outerArgumentFunction = parseContext.argumentFunction;
    let outerRootIdentifier = parseContext.isRootIdentifier;
    parseContext.isWriteAccess = false;
    parseContext.argumentFunction = null;
    parseContext.isRootIdentifier = false;

    // Add symbols for parameters in function declarations
    switch (node.type)
    {
        // this and other constants
        case node_types.This: return scope.getParentType(); break;
        case node_types.ConstBool: return typedb.GetTypeByName("bool"); break;
        case node_types.ConstDouble:
            if (ScriptSettings.floatIsFloat64)
                return typedb.GetTypeByName("float");
            else
                return typedb.GetTypeByName("double");
        break;
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        case node_types.ConstOctalInteger:
        case node_types.ConstBinaryInteger:
            return typedb.GetTypeByName("int");
        break;
        case node_types.ConstFloat:
            if (ScriptSettings.floatIsFloat64)
                return typedb.GetTypeByName("float32");
            else
                return typedb.GetTypeByName("float");
        break;
        case node_types.ConstName: return typedb.GetTypeByName("FName"); break;
        case node_types.ConstString: return typedb.GetTypeByName("FString"); break;
        case node_types.ConstNullptr: return typedb.GetTypeByName("UObject"); break;
        // Format string f"Blah {CODE}"
        case node_types.ConstFormatString:
            DetectFormatStringSymbols(scope, statement, node, parseContext);
            return typedb.GetTypeByName("FString");
        break;
        // X
        case node_types.Identifier:
        {
            parseContext.isWriteAccess = outerWriteAccess;
            parseContext.argumentFunction = outerArgumentFunction;
            parseContext.isRootIdentifier = outerRootIdentifier;
            return DetectIdentifierSymbols(scope, statement, node, parseContext, symbol_type);
        }
        break;
        // X.Y
        case node_types.MemberAccess:
        {
            parseContext.isRootIdentifier = outerRootIdentifier;

            if (outerWriteAccess && node.children[0] && node.children[0].type == node_types.Identifier)
            {
                // If the left side is a local variable and not a reference or UObject, pass through the writeAccess flag
                // This is a hack that only works on a single layer of member access, but it's useful :shrug:
                let checkscope = scope;
                while (checkscope && checkscope.isInFunctionBody())
                {
                    let usedVariable = checkscope.variablesByName.get(node.children[0].value);
                    if (usedVariable)
                    {
                        if (!usedVariable.isReference() && usedVariable.isValueType(scope))
                            parseContext.isWriteAccess = true;
                        break;
                    }
                    checkscope = checkscope.parentscope;
                }
            }

            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);
            if (!left_symbol)
            {
                if (parseContext.allow_errors)
                    AddUnknownSymbol(scope, statement, node.children[1], false);
                return null;
            }

            if (node.children[1])
            {
                parseContext.isWriteAccess = outerWriteAccess;
                parseContext.isRootIdentifier = outerRootIdentifier;
                return DetectSymbolsInType(scope, statement, left_symbol, node.children[1], parseContext, symbol_type);
            }

            return null;
        }
        break;
        // X::Y
        case node_types.NamespaceAccess:
        {
            if (!node.children[0] || node.children[0].type == node_types.Identifier)
            {
                let insideType = scope.getParentType();
                let parentType : typedb.DBType = null;
                let shadowedType : typedb.DBType = null;

                let namespace : typedb.DBNamespace = null;
                if (node.children[0])
                    namespace = typedb.LookupNamespace(scope.getNamespace(), node.children[0].value);
                else
                    namespace = typedb.GetRootNamespace();

                if (insideType && node.children[0])
                {
                    if (node.children[0].value == "Super")
                    {
                        parentType = scope.getParentType().getSuperType();
                    }
                    else
                    {
                        // We might be calling a function on one of our super classes
                        if (typedb.AllowsFunctions(symbol_type))
                        {
                            if (insideType.inheritsFrom(node.children[0].value))
                                parentType = typedb.LookupType(scope.getNamespace(), node.children[0].value);
                        }
                    }
                }

                // See if we're accessing an enum value
                if (!parentType && node.children[0])
                    shadowedType = typedb.LookupType(scope.getNamespace(), node.children[0].value);

                if (!namespace && !parentType && !shadowedType)
                {
                    if (node.children[0])
                        scope.module.markDependencyIdentifier(node.children[0].value);
                    if (parseContext.allow_errors)
                    {
                        if (node.children[0])
                            AddUnknownSymbol(scope, statement, node.children[0], false);
                        AddUnknownSymbol(scope, statement, node.children[1], false);
                    }
                    return null;
                }

                if (node.children[0])
                {
                    let addedSymbol = AddIdentifierSymbol(scope, statement, node.children[0], ASSymbolType.Namespace, null, null);
                    if (shadowedType && (namespace || shadowedType.isEnum))
                    {
                        scope.module.markDependencyType(shadowedType);
                        addedSymbol.symbol_name = shadowedType.name;
                        addedSymbol.type = ASSymbolType.Typename;
                    }
                    else if (namespace)
                    {
                        scope.module.markDependencyNamespace(namespace);
                        addedSymbol.symbol_name = namespace.getQualifiedNamespace();
                    }
                    else if (parentType)
                    {
                        scope.module.markDependencyType(parentType);
                        addedSymbol.symbol_name = parentType.name;
                        addedSymbol.type = ASSymbolType.Typename;
                    }
                }

                if (node.children[1])
                {
                    if (parentType)
                    {
                        // Check if we're calling a function in the super type
                        let prevErrors = parseContext.allow_errors;
                        parseContext.isWriteAccess = outerWriteAccess;
                        parseContext.allow_errors = false;
                        let parentSymbol = DetectSymbolsInType(scope, statement, parentType, node.children[1], parseContext, symbol_type);
                        parseContext.allow_errors = prevErrors;

                        if (parentSymbol)
                        {
                            let scopeFunc = scope.getParentFunction();
                            if (scopeFunc && parentSymbol instanceof typedb.DBMethod && parentSymbol.name == scopeFunc.name)
                                scopeFunc.hasSuperCall = true;
                            return parentSymbol;
                        }
                    }
                    else if (shadowedType && shadowedType.isEnum)
                    {
                        parseContext.isWriteAccess = outerWriteAccess;
                        return DetectSymbolsInType(scope, statement, shadowedType, node.children[1], parseContext, symbol_type);
                    }

                    if (namespace)
                    {
                        parseContext.isWriteAccess = outerWriteAccess;
                        return DetectSymbolsInNamespace(scope, statement, namespace, node.children[1], parseContext, symbol_type | typedb.DBAllowSymbol.Types);
                    }
                }
            }
            else
            {
                let identifierNodes : Array<any> = [];
                let checkNode = node;
                let lookupRootNamespace = scope.getNamespace();

                while (checkNode)
                {
                    if (checkNode.type == node_types.Identifier)
                    {
                        identifierNodes.splice(0, 0, checkNode);
                        break;
                    }
                    else if (checkNode.type == node_types.NamespaceAccess)
                    {
                        identifierNodes.splice(0, 0, checkNode.children[1]);
                        checkNode = checkNode.children[0];
                        if (!checkNode)
                            lookupRootNamespace = typedb.GetRootNamespace();
                    }
                    else
                    {
                        break;
                    }
                }

                // Find the actual namespace we're looking in
                let qualifiedNamespace = "";
                for (let i = 0, count = identifierNodes.length - 1; i < count; ++i)
                {
                    if (identifierNodes[i])
                    {
                        if (qualifiedNamespace.length != 0)
                            qualifiedNamespace += "::";
                        qualifiedNamespace += identifierNodes[i].value;
                    }
                }

                let resolveNamespace = "";

                let prevNamespace = null;
                for (let i = 0, count = identifierNodes.length - 1; i < count; ++i)
                {
                    if (identifierNodes[i])
                    {
                        if (resolveNamespace.length != 0)
                            resolveNamespace += "::";
                        resolveNamespace += identifierNodes[i].value;

                        let subNamespace = typedb.LookupNamespace(lookupRootNamespace, resolveNamespace);
                        if (subNamespace)
                        {
                            let addedSymbol = AddIdentifierSymbol(scope, statement, identifierNodes[i], ASSymbolType.Namespace, null, null);
                            let shadowedType = subNamespace.getShadowedType();
                            prevNamespace = subNamespace;

                            if (shadowedType)
                            {
                                scope.module.markDependencyType(shadowedType);
                                addedSymbol.symbol_name = shadowedType.name;
                                addedSymbol.type = ASSymbolType.Typename;
                            }
                            else
                            {
                                scope.module.markDependencyNamespace(subNamespace);
                                addedSymbol.symbol_name = subNamespace.getQualifiedNamespace();
                            }
                        }
                        else
                        {
                            let enumType = typedb.LookupType(prevNamespace, identifierNodes[i].value);
                            if (enumType && enumType.isEnum)
                            {
                                AddIdentifierSymbol(scope, statement, identifierNodes[i], ASSymbolType.Typename, null, enumType.name);

                                let enumValueNode = identifierNodes[i+1];
                                if (enumValueNode)
                                {
                                    let value = enumType.findFirstSymbol(enumValueNode.value, typedb.DBAllowSymbol.Properties);
                                    if (value)
                                        AddIdentifierSymbol(scope, statement, enumValueNode, ASSymbolType.MemberVariable, enumType.name, value.name);
                                    else
                                        AddUnknownSymbol(scope, statement, enumValueNode, false);

                                    // If we have any "extra" namespace accesses after the enum value, mark them as wrong
                                    for (let n = i+2; n < identifierNodes.length; ++n)
                                    {
                                        if (identifierNodes[n])
                                            AddUnknownSymbol(scope, statement, identifierNodes[n], false);
                                    }
                                }

                                return enumType;
                            }

                            AddUnknownSymbol(scope, statement, identifierNodes[i], false);
                        }
                    }
                }

                let namespace = typedb.LookupNamespace(lookupRootNamespace, qualifiedNamespace);
                if (!namespace)
                {
                    AddUnknownSymbol(scope, statement, node.children[1], false);
                    return null;
                }
                else if (node.children[1])
                {
                    parseContext.isWriteAccess = outerWriteAccess;
                    return DetectSymbolsInNamespace(scope, statement, namespace, node.children[1], parseContext, symbol_type | typedb.DBAllowSymbol.Types);
                }
            }

            return null;
        }
        break;
        // X()
        case node_types.FunctionCall:
        {
            // This could be a constructor call to a type
            let delegateBind : ASDelegateBind = null;
            let left_type : typedb.DBType = null;
            let left_symbol : typedb.DBSymbol | typedb.DBType = null;
            if (node.children[0] && node.children[0].type == node_types.Identifier)
            {
                let refType = typedb.LookupType(scope.getNamespace(), node.children[0].value);
                if (refType && refType.isEnum)
                {
                    left_type = refType;
                    let addedSymbol = AddIdentifierSymbol(scope, statement, node.children[0], ASSymbolType.Typename, null, refType.name);
                    if (refType.declaredModule && !ScriptSettings.automaticImports && !scope.module.isModuleImported(refType.declaredModule))
                        addedSymbol.isUnimported = true;
                    scope.module.markDependencyType(refType);
                }
                else if (refType)
                {
                    scope.module.markDependencyType(refType);

                    // Lookup a constructor
                    let constructors = typedb.LookupGlobalSymbol(refType.namespace, refType.name, typedb.DBAllowSymbol.Functions);
                    if (constructors && constructors.length >= 1)
                        left_symbol = constructors[0];
                    else
                        left_symbol = null;
                    left_type = refType;

                    let addedSymbol = AddIdentifierSymbol(scope, statement, node.children[0], ASSymbolType.Typename, null, refType.name);
                    if (refType.declaredModule && !ScriptSettings.automaticImports && !scope.module.isModuleImported(refType.declaredModule))
                        addedSymbol.isUnimported = true;

                    // If this is a delegate constructor call, mark it for later diagnostics
                    if (left_type.isDelegate && node.children[1])
                    {
                        delegateBind = new ASDelegateBind;
                        delegateBind.scope = scope;
                        delegateBind.statement = statement;
                        delegateBind.node_expression = node;
                        if (node.children[1].children[0])
                            delegateBind.node_object = node.children[1].children[0];
                        if (node.children[1].children[1])
                            delegateBind.node_name = node.children[1].children[1];
                        delegateBind.delegateType = left_type.name;
                        scope.module.delegateBinds.push(delegateBind);
                    }
                }
            }

            // Otherwise, resolve the left side as a function and get the return type
            if (left_type == null)
            {
                left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Functions);
                if (left_symbol && left_symbol instanceof typedb.DBMethod)
                    left_type = typedb.LookupType(left_symbol.namespace, left_symbol.returnType);
            }

            // Detect symbols in the argument expressions
            if (left_symbol && left_symbol instanceof typedb.DBMethod)
                parseContext.argumentFunction = left_symbol;
            else
                parseContext.argumentFunction = null;

            if (left_symbol instanceof typedb.DBMethod)
            {
                if (left_symbol.isDelegateBindFunction && node.children[1])
                {
                    // If this is a delegate bind call, mark it for later diagnostics
                    delegateBind = new ASDelegateBind;
                    delegateBind.scope = scope;
                    delegateBind.statement = statement;
                    delegateBind.node_expression = node;
                    if (node.children[1].children[left_symbol.delegateObjectParam])
                        delegateBind.node_object = node.children[1].children[left_symbol.delegateObjectParam];
                    if (node.children[1].children[left_symbol.delegateFunctionParam])
                        delegateBind.node_name = node.children[1].children[left_symbol.delegateFunctionParam];
                    delegateBind.delegateType = left_symbol.delegateBindType;
                    scope.module.delegateBinds.push(delegateBind);
                }
                else if (left_symbol.methodAnnotation != typedb.DBMethodAnnotation.None)
                {
                    // Any call no an annotated method is stored so we can look them up again later
                    let annotation = new ASAnnotatedCall;
                    annotation.scope = scope;
                    annotation.statement = statement;
                    annotation.node_call = node;
                    annotation.method = left_symbol;
                    scope.module.annotatedFunctionCalls.push(annotation);
                }
            }

            if (delegateBind && left_symbol
                && left_symbol instanceof typedb.DBMethod)
            {
                for (let i = 0; i < node.children[1].children.length; ++i)
                {
                    let childNode = node.children[1].children[i];
                    if (!childNode)
                        continue;

                    if (childNode == delegateBind.node_name)
                    {
                        // Add a symbol for the function we're binding if this is a delegate bind
                        // This allows "Go to Symbol" to work here, even though it's a name
                        parseContext.argumentFunction = left_symbol;
                        DetectSymbolFromDelegateBindFunctionName(scope, statement, parseContext, delegateBind);
                    }
                    else
                    {
                        // Detect symbols for other arguments
                        parseContext.argumentFunction = left_symbol;
                        DetectNodeSymbols(scope, statement, childNode, parseContext, typedb.DBAllowSymbol.Properties);
                    }
                }
            }
            else
            {
                // Detect symbols for all children
                DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);
            }

            // Pass through the return type to be used for the next level
            return left_type;
        }
        break;
        // TType<TSubType>()
        case node_types.ConstructorCall:
        {
            // Add the typename symbol that we're calling a constructor of
            AddTypenameSymbol(scope, statement, node.children[0]);

            // Detect symbols in the argument expressions
            DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);

            if (!node.children[0] || !node.children[0].value)
                return null;
            return typedb.LookupType(scope.getNamespace(), node.children[0].value);
        }
        break;
        // List of arguments within a function call
        case node_types.ArgumentList:
        {
            if (node.children)
            {
                for (let child of node.children)
                {
                    parseContext.argumentFunction = outerArgumentFunction;
                    DetectNodeSymbols(scope, statement, child, parseContext);
                }
            }
        }
        break;
        // X[]
        case node_types.IndexOperator:
        {
            // Detect symbols in the lvalue expression
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);

            // Detect symbols in the subscript expression
            DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);

            // Pass through the return type to be used for the next level
            return ResolveTypeFromOperator(scope, GetTypeFromSymbol(left_symbol), null, "opIndex");
        }
        break;
        // X * Y
        case node_types.BinaryOperation:
        {
            // Detect symbols in the left expression
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);
            // Detect symbols in the right expression
            let right_symbol = DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);

            return ResolveTypeFromOperator(scope, GetTypeFromSymbol(left_symbol), GetTypeFromSymbol(right_symbol), getBinaryOperatorOverloadMethod(node.operator));
        }
        break;
        // -X
        case node_types.UnaryOperation:
        {
            // Detect symbols in the left expression
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);
            return ResolveTypeFromOperator(scope, GetTypeFromSymbol(left_symbol), null, getUnaryOperatorOverloadMethod(node.operator));
        }
        break;
        // X++
        case node_types.PostfixOperation:
        {
            // Detect symbols in the left expression
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);
            return ResolveTypeFromOperator(scope, GetTypeFromSymbol(left_symbol), null, getPostfixOperatorOverloadMethod(node.operator));
        }
        break;
        // X ? Y : Z
        case node_types.TernaryOperation:
        {
            // Detect symbols in the condition expression
            DetectNodeSymbols(scope, statement, node.children[0], parseContext, typedb.DBAllowSymbol.Properties);
            // Detect symbols in the left expression
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);
            // Detect symbols in the right expression
            let right_symbol = DetectNodeSymbols(scope, statement, node.children[2], parseContext, typedb.DBAllowSymbol.Properties);

            if (left_symbol)
            {
                if (left_symbol != right_symbol)
                {
                    if (left_symbol instanceof typedb.DBType && right_symbol instanceof typedb.DBType)
                    {
                        if (!left_symbol.isValueType() && !right_symbol.isValueType())
                        {
                            let target_type = left_symbol;
                            while (target_type && !right_symbol.inheritsFrom(target_type.name))
                                target_type = target_type.getSuperType();

                            if (target_type)
                                return target_type;
                        }
                    }
                }

                return left_symbol;
            }
            else
            {
                return right_symbol;
            }
        }
        break;
        // Cast<X>()
        case node_types.CastOperation:
        {
            // Add the typename symbol in the template
            AddTypenameSymbol(scope, statement, node.children[0]);

            // Detect symbols in the casted expression
            DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);

            if (!node.children[0] || !node.children[0].value)
                return null;
            return typedb.LookupType(scope.getNamespace(), node.children[0].value);
        }
        break;
        // void X(...)
        case node_types.FunctionDecl:
        case node_types.ConstructorDecl:
        {
            // Add symbol for access specifier if we want
            if (node.access)
                AddAccessSpecifierSymbol(scope, statement, node.access);

            // Add the symbol for the return type
            if (node.returntype && node.returntype.value != 'void')
                AddTypenameSymbol(scope, statement, node.returntype);

            // Add the function name
            if (node.name)
            {
                let insideType = scope.dbtype ? scope.dbtype.name : null;
                let symType = scope.dbtype ? ASSymbolType.MemberFunction : ASSymbolType.GlobalFunction;
                if (!insideType)
                    insideType = scope.getNamespace().getQualifiedNamespace();

                if (node.type == node_types.ConstructorDecl)
                {
                    insideType = null;
                    symType = ASSymbolType.Typename;
                }

                AddIdentifierSymbol(scope, statement, node.name, symType, insideType, node.name.value);
            }

            // Add symbols for all parameters of the function
            if (node.parameters)
            {
                for (let param of node.parameters)
                {
                    // Add the typename of the parameter
                    if (param.typename)
                        AddTypenameSymbol(scope, statement, param.typename);
                    // Add the name of the parameter
                    if (param.name)
                        AddIdentifierSymbol(scope, statement, param.name, ASSymbolType.Parameter, null, param.name.value);
                    // Detect inside the default expression for the parameter
                    if (param.expression)
                        DetectNodeSymbols(scope, statement, param.expression, parseContext, typedb.DBAllowSymbol.Properties);
                }
            }
        }
        break;
        case node_types.DestructorDecl:
        {
            // Add the symbol for the type's name
            if (node.name)
            {
                AddIdentifierSymbol(scope, statement, {
                    value: node.name.value.substr(1),
                    start: node.name.start + 1,
                    end: node.name.end,
                }, ASSymbolType.Typename, null, node.name.value.substr(1));
            }
        }
        break;
        // event/delegate void X(...)
        case node_types.EventDecl:
        case node_types.DelegateDecl:
        {
            // Create the event or delegate type in the database from this statement
            let signature = statement.ast.children[0];
            if (signature)
            {
                // Add the symbol for the return type
                if (signature.returntype && signature.returntype.value != 'void')
                    AddTypenameSymbol(scope, statement, signature.returntype);

                // Add the delegate name
                if (signature.name)
                    AddIdentifierSymbol(scope, statement, signature.name, ASSymbolType.Typename, null, signature.name.value);

                // Add symbols for all parameters of the function
                if (signature.parameters)
                {
                    for (let param of signature.parameters)
                    {
                        // Add the typename of the parameter
                        if (param.typename)
                            AddTypenameSymbol(scope, statement, param.typename);
                        // Add the name of the parameter
                        if (param.name)
                            AddIdentifierSymbol(scope, statement, param.name, ASSymbolType.Parameter, null, param.name.value);
                        // Detect inside the default expression for the parameter
                        if (param.expression)
                            DetectNodeSymbols(scope, statement, param.expression, parseContext, typedb.DBAllowSymbol.Properties);
                    }
                }
            }
        }
        break;
        // import void X() from "Y"
        case node_types.ImportFunctionStatement:
        {
            let signature = statement.ast.children[0];
            if (signature)
            {
                // Add the symbol for the return type
                if (signature.returntype && signature.returntype.value != 'void')
                    AddTypenameSymbol(scope, statement, signature.returntype);

                // Add the function name
                if (signature.name)
                {
                    let namespace = scope.getNamespace().getQualifiedNamespace();
                    AddIdentifierSymbol(scope, statement, signature.name, ASSymbolType.GlobalFunction, namespace, signature.name.value);
                }

                // Add symbols for all parameters of the function
                if (signature.parameters)
                {
                   for (let param of signature.parameters)
                    {
                        // Add the typename of the parameter
                        if (param.typename)
                            AddTypenameSymbol(scope, statement, param.typename);
                        // Add the name of the parameter
                        if (param.name)
                            AddIdentifierSymbol(scope, statement, param.name, ASSymbolType.Parameter, null, param.name.value);
                        // Detect inside the default expression for the parameter
                        if (param.expression)
                            DetectNodeSymbols(scope, statement, param.expression, parseContext, typedb.DBAllowSymbol.Properties);
                    }
                }
            }
        }
        break;
        // Type X;
        case node_types.VariableDecl:
        {
            // Add symbol for access specifier if we want
            if (node.access)
                AddAccessSpecifierSymbol(scope, statement, node.access);

            // Add the typename of the variable
            let typenameSymbol : ASSemanticSymbol = null;
            let variableType : typedb.DBType = null;
            if (node.typename)
            {
                variableType = typedb.LookupType(scope.getNamespace(), node.typename.value);
                if (scope.module.isEditingNode(statement, node.typename))
                {
                    // This one gets a bit tricky if we are currently editing the typename.
                    // It's very likely that we detected a statement that is incomplete as a variable declaration
                    // For example: (| as cursor)
                    ////  PreviousCa|
                    ////  PreviousCameraWorldLocation = CamLoc
                    // The above gets detected as a variable declaration, but because the PreviousCa type
                    // doesn't exist, doing AddTypenameSymbol would error.
                    // So if we are editing the typename, we need to _also_ check for a valid identifier!
                    if (variableType || DoesTypenameExist(scope, node.typename.value))
                    {
                        // Easy case, type exists, mark it as a typename
                        if (!node.is_secondary)
                            typenameSymbol = AddTypenameSymbol(scope, statement, node.typename);
                    }
                    else
                    {
                        let namespacedSymbol = DetectSymbolFromNamespacedIdentifier(scope, statement, node.typename, true, typedb.DBAllowSymbol.PropertiesAndFunctions);
                        if (!namespacedSymbol)
                        {
                            let prevErrors = parseContext.allow_errors;
                            parseContext.allow_errors = false;
                            parseContext.isWriteAccess = outerWriteAccess;
                            let identifierSymbol = DetectIdentifierSymbols(scope, statement, node.typename, parseContext, typedb.DBAllowSymbol.PropertiesAndFunctions);
                            parseContext.allow_errors = prevErrors;

                            if (identifierSymbol)
                            {
                                // We were typing a valid identifier, symbol was already emitted, so we are done.
                            }
                            else
                            {
                                // There was no valid identifier, but it's possible we're typing an incomplete one
                                let hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbol(scope, statement, parseContext, node.typename.value, typedb.DBAllowSymbol.PropertiesAndFunctions);
                                if (!hasPotentialCompletions)
                                {
                                    // Now we can add it as a typename symbol, because we know it cannot possibly be an identifier symbol
                                    if (!node.is_secondary)
                                        typenameSymbol = AddTypenameSymbol(scope, statement, node.typename);
                                }
                            }
                        }
                    }
                }
                else
                {
                    if (!node.is_secondary)
                        typenameSymbol = AddTypenameSymbol(scope, statement, node.typename);
                }
            }

            // Add the name of the variable
            if (node.name)
            {
                let insideType = scope.dbtype ? scope.dbtype.name : null;
                let symType = ASSymbolType.LocalVariable;

                if (scope.dbtype && scope.scopetype == ASScopeType.Class)
                {
                    symType = ASSymbolType.MemberVariable;
                }
                else if (scope.scopetype == ASScopeType.Namespace || scope.scopetype == ASScopeType.Global)
                {
                    symType = ASSymbolType.GlobalVariable;
                    insideType = scope.getNamespace().getQualifiedNamespace();
                }

                AddIdentifierSymbol(scope, statement, node.name, symType, insideType, node.name.value, true);
            }

            // Detect inside the expression that initializes the variable
            if (node.expression)
            {
                if (variableType && variableType.isDelegate
                    && node.expression.type == node_types.ArgumentList)
                {
                    // This is an in-place constructor for a delegate, so we should mark it as a delegate bind
                    let delegateBind = new ASDelegateBind;
                    delegateBind.scope = scope;
                    delegateBind.statement = statement;
                    delegateBind.node_expression = node;
                    if (node.expression.children[0])
                        delegateBind.node_object = node.expression.children[0];
                    if (node.expression.children[1])
                        delegateBind.node_name = node.expression.children[1];
                    delegateBind.delegateType = variableType.name;
                    scope.module.delegateBinds.push(delegateBind);

                    for (let i = 0; i < node.expression.children.length; ++i)
                    {
                        let childNode = node.expression.children[i];
                        if (!childNode)
                            continue;

                        if (childNode == delegateBind.node_name)
                        {
                            // Add a symbol for the function we're binding if this is a delegate bind
                            // This allows "Go to Symbol" to work here, even though it's a name
                            DetectSymbolFromDelegateBindFunctionName(scope, statement, parseContext, delegateBind);
                        }
                        else
                        {
                            // Detect symbols for other arguments
                            DetectNodeSymbols(scope, statement, childNode, parseContext, typedb.DBAllowSymbol.Properties);
                        }
                    }
                }
                else
                {
                    let expressionType = DetectNodeSymbols(scope, statement, node.expression, parseContext, typedb.DBAllowSymbol.Properties);

                    // If this was an auto, we should update the typename symbol to match the expression
                    if (typenameSymbol && typenameSymbol.symbol_name == "auto")
                        UpdateAutoTypenameSymbol(typenameSymbol, expressionType);
                }
            }
        }
        break;
        // access X = private, Y, Z (mod);
        case node_types.AccessDeclaration:
        {
            // Add symbol for the name
            if (node.name)
            {
                let insideType = scope.dbtype ? scope.dbtype.name : null;
                let symType = ASSymbolType.AccessSpecifier;
                AddIdentifierSymbol(scope, statement, node.name, symType, insideType, node.name.value, true);
            }

            // Add type symbols for each class we've specified
            if (node.classList)
            {
                for (let cls of node.classList)
                {
                    if (cls.className.value == "*")
                        continue;
                    if (cls.className.value == "private")
                        continue;
                    if (cls.className.value == "protected")
                        continue;

                    // Check if this is a global function or a type
                    let specType = typedb.LookupType(scope.getNamespace(), cls.className.value);
                    if (specType)
                    {
                        AddIdentifierSymbol(scope, statement, cls.className, ASSymbolType.Typename, null, cls.className.value);
                    }
                    else
                    {
                        let globalFunctions = typedb.LookupGlobalSymbol(scope.getNamespace(), cls.className.value, typedb.DBAllowSymbol.Functions);
                        if (globalFunctions && globalFunctions.length != 0)
                        {
                            let func = globalFunctions[0];
                            let namespace = func.namespace.getQualifiedNamespace();
                            AddIdentifierSymbol(scope, statement, cls.className, ASSymbolType.GlobalFunction, namespace, func.name);
                        }
                        else
                        {
                            let namespace = typedb.LookupNamespace(null, cls.className.value);
                            if (namespace)
                            {
                                AddIdentifierSymbol(scope, statement, cls.className, ASSymbolType.Namespace, null, namespace.getQualifiedNamespace());
                            }
                            else
                            {
                                if (!scope.module.isEditingNode(statement, cls.className) && InitialParseDone)
                                    AddUnknownSymbol(scope, statement, cls.className, false);
                            }
                        }
                    }
                }
            }
        }
        break;
        // asset X of Y
        case node_types.AssetDefinition:
        {
            // Symbol for the global variable that holds the asset
            let namespace = scope.getNamespace().getQualifiedNamespace();
            AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.GlobalVariable, namespace, node.name.value);

            // Symbol for the typename of the asset
            if (node.typename)
                AddTypenameSymbol(scope, statement, node.typename);
        }
        break;
        // Type X, Y;
        case node_types.VariableDeclMulti:
        {
            // Detect in each declaration inside this statement
            for (let child of node.children)
            {
                DetectNodeSymbols(scope, statement, child, parseContext, typedb.DBAllowSymbol.Properties);
            }
        }
        break;
        // Assignment should recurse, and mark the left hand side as write access
        case node_types.Assignment:
        case node_types.CompoundAssignment:
        {
            // Detect in each subexpression
            for (let i = 0, count = node.children.length; i < count; ++i)
            {
                parseContext.isWriteAccess = (i == 0);
                DetectNodeSymbols(scope, statement, node.children[i], parseContext, typedb.DBAllowSymbol.Properties);
            }
        }
        break;
        // Statements that don't need any special handling, just make sure to recurse into all children
        case node_types.ReturnStatement:
        case node_types.DefaultStatement:
        case node_types.SwitchStatement:
        case node_types.CommaExpression:
        {
            // Detect in each subexpression
            for (let child of node.children)
                DetectNodeSymbols(scope, statement, child, parseContext, typedb.DBAllowSymbol.Properties);
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
                DetectNodeSymbols(scope, statement, node.children[i], parseContext, typedb.DBAllowSymbol.Properties);
        }
        break;
        // For each loops add symbols for the typename and the variable name
        case node_types.ForEachLoop:
        {
            // Add the declared loop variable
            let typenameSymbol = AddTypenameSymbol(scope, statement, node.children[0]);
            if (node.children[1])
                AddIdentifierSymbol(scope, statement, node.children[1], ASSymbolType.LocalVariable, null, node.children[1].value);

            // Detect in the expression that declares the variable
            let expressionType = DetectNodeSymbols(scope, statement, node.children[2], parseContext, typedb.DBAllowSymbol.Properties);

            // If this was an auto, we should update the typename symbol to match the expression
            if (typenameSymbol && typenameSymbol.symbol_name == "auto")
            {
                UpdateAutoTypenameSymbol(typenameSymbol, ResolveIteratorType(GetTypeFromSymbol(expressionType)));
            }
        }
        break;
        // Declarations for types should emit a type symbol
        case node_types.ClassDefinition:
        {
            // Add the typename of the class itself
            AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, node.name.value);

            // If we specified a super type, add the symbol for that too
            if (node.superclass)
            {
                let superType = typedb.LookupType(scope.getNamespace(), node.superclass.value);
                if (superType)
                {
                    let superSymbol = AddIdentifierSymbol(scope, statement, node.superclass, ASSymbolType.Typename, null, node.superclass.value);
                    if (superType.declaredModule && !ScriptSettings.automaticImports && !scope.module.isModuleImported(superType.declaredModule))
                        superSymbol.isUnimported = true;
                    scope.module.markDependencyType(superType);
                }
                else
                {
                    let hasPotentialCompletions = false;
                    if (scope.module.isEditingNode(statement, node.superclass))
                        hasPotentialCompletions = typedb.HasTypeWithPrefix(scope.getNamespace(), node.superclass.value);
                    AddUnknownSymbol(scope, statement, node.superclass, hasPotentialCompletions);
                    scope.module.markDependencyIdentifier(node.superclass.value);
                    return null;
                }
            }
        }
        break;
        case node_types.StructDefinition:
        {
            AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, node.name.value);
        }
        break;
        case node_types.EnumDefinition:
        {
            AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, node.name.value);
        }
        break;
        // Namespace definitions add a namespace symbol
        case node_types.NamespaceDefinition:
        {
            let namespace = typedb.LookupNamespace(scope.getNamespace(), node.name.value);
            if (namespace)
            {
                let shadowedType = typedb.LookupType(scope.getNamespace(), node.name.value);
                if (shadowedType)
                    AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, namespace.name);
                else
                    AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Namespace, null, namespace.getQualifiedNamespace());
            }
        }
        break;
        // Named argument
        case node_types.NamedArgument:
        {
            let expr_type = DetectNodeSymbols(scope, statement, node.children[1], parseContext, typedb.DBAllowSymbol.Properties);
            return expr_type;
        }
        break;
        // List of enum values
        case node_types.EnumValueList:
        {
            if (scope.dbtype)
            {
                for (let enumValue of statement.ast.children)
                {
                    if (!enumValue)
                        continue;
                    // Emit symbol for enum value node
                    AddIdentifierSymbol(scope, statement, enumValue.name, ASSymbolType.MemberVariable, scope.dbtype.name, enumValue.name.value);
                }
            }
        }
        break;
    }

    return null;
}

function DetectIdentifierSymbols(scope : ASScope, statement : ASStatement, node : any, parseContext : ASParseContext, symbol_type : typedb.DBAllowSymbol) : typedb.DBSymbol | typedb.DBType
{
    if (!node)
        return null;

    // Check for local variables
    if (typedb.AllowsProperties(symbol_type))
    {
        let checkscope = scope;
        while (checkscope && checkscope.isInFunctionBody())
        {
            let usedVariable = checkscope.variablesByName.get(node.value);
            if (usedVariable)
            {
                if (!parseContext.isRootIdentifier && (!parseContext.isWriteAccess || usedVariable.isReference()))
                    usedVariable.isUnused = false;
                usedVariable.hasAnyUsages = true;

                let symType = usedVariable.isArgument ? ASSymbolType.Parameter : ASSymbolType.LocalVariable;
                let varSymbol = AddIdentifierSymbol(scope, statement, node, symType, null, node.value, parseContext.isWriteAccess);

                if (!usedVariable.usages)
                    usedVariable.usages = new Array<ASSemanticSymbol>();
                usedVariable.usages.push(varSymbol);

                let dbType = typedb.LookupType(checkscope.getNamespace(), usedVariable.typename);
                scope.module.markDependencyType(dbType);
                return dbType;
            }
            checkscope = checkscope.parentscope;
        }
    }

    // Find a symbol in the class we're in
    let insideType = scope.getParentType();
    if (insideType)
    {
        let usedSymbol = insideType.findFirstSymbol(node.value, symbol_type);
        if (usedSymbol)
        {
            let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.MemberVariable : ASSymbolType.MemberFunction;
            AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.containingType, usedSymbol.name, parseContext.isWriteAccess);
            scope.module.markDependencySymbol(usedSymbol);
            return usedSymbol;
        }

        if (typedb.AllowsProperties(symbol_type))
        {
            let getAccessor = insideType.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.Functions);
            if (getAccessor && getAccessor instanceof typedb.DBMethod)
            {
                AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, getAccessor.containingType, getAccessor.name, parseContext.isWriteAccess);
                scope.module.markDependencyFunction(getAccessor);
                return typedb.LookupType(getAccessor.namespace, getAccessor.returnType);
            }

            let setAccessor = insideType.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.Functions);
            if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
            {
                AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, setAccessor.containingType, setAccessor.name, parseContext.isWriteAccess);
                scope.module.markDependencyFunction(setAccessor);
                return typedb.LookupType(setAccessor.namespace, setAccessor.args[0].typename);
            }
        }
    }

    // Find an unimported global symbol
    let globalSymbols = typedb.LookupGlobalSymbol(scope.getNamespace(), node.value);
    if (globalSymbols)
    {
        for (let usedSymbol of globalSymbols)
        {
            if (usedSymbol instanceof typedb.DBMethod && typedb.AllowsFunctions(symbol_type))
            {
                if (usedSymbol.isMixin)
                {
                    if (insideType)
                    {
                        if (usedSymbol.args.length == 0 || !insideType.inheritsFrom(usedSymbol.args[0].typename))
                            continue;
                    }
                    else
                    {
                        continue;
                    }
                }

                // Ignore constructors, they count as types not as global functions
                if (usedSymbol.isConstructor)
                    continue;

                if (usedSymbol.isLocal && !usedSymbol.IsAccessibleFromModule(scope.module.modulename))
                    continue;
                let addedSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalFunction,
                    usedSymbol.namespace.getQualifiedNamespace(), usedSymbol.name, parseContext.isWriteAccess);
                if (!ScriptSettings.automaticImports && usedSymbol.declaredModule && !scope.module.isModuleImported(usedSymbol.declaredModule))
                    addedSym.isUnimported = true;
                scope.module.markDependencyFunction(usedSymbol);
                return usedSymbol;
            }
            else if (usedSymbol instanceof typedb.DBProperty && typedb.AllowsProperties(symbol_type))
            {
                let addedSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalVariable,
                    usedSymbol.namespace.getQualifiedNamespace(), usedSymbol.name, parseContext.isWriteAccess);
                if (!ScriptSettings.automaticImports && usedSymbol.declaredModule && !scope.module.isModuleImported(usedSymbol.declaredModule))
                    addedSym.isUnimported = true;
                scope.module.markDependencyProperty(usedSymbol);
                return usedSymbol;
            }
        }
    }

    // Find an unimpoted global accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let globalGetAccessors = typedb.LookupGlobalSymbol(scope.getNamespace(), "Get"+node.value, typedb.DBAllowSymbol.Functions);
        if (globalGetAccessors)
        {
            for (let usedSymbol of globalGetAccessors)
            {
                if (usedSymbol instanceof typedb.DBMethod && usedSymbol.isProperty && !usedSymbol.isMixin)
                {
                    if (usedSymbol.isLocal && !usedSymbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    let addedSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalAccessor,
                        usedSymbol.namespace.getQualifiedNamespace(), usedSymbol.name, parseContext.isWriteAccess);
                    if (!ScriptSettings.automaticImports)
                        addedSym.isUnimported = true;
                    scope.module.markDependencyFunction(usedSymbol);
                    return typedb.LookupType(usedSymbol.namespace, usedSymbol.returnType);
                }
            }
        }

        let globalSetAccessors = typedb.LookupGlobalSymbol(scope.getNamespace(), "Set"+node.value, typedb.DBAllowSymbol.Functions);
        if (globalSetAccessors)
        {
            for (let usedSymbol of globalSetAccessors)
            {
                if (usedSymbol instanceof typedb.DBMethod && usedSymbol.isProperty && usedSymbol.args.length != 0 && !usedSymbol.isMixin)
                {
                    if (usedSymbol.isLocal && !usedSymbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    let addedSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalAccessor,
                        usedSymbol.namespace.getQualifiedNamespace(), usedSymbol.name, parseContext.isWriteAccess);
                    if (!ScriptSettings.automaticImports && usedSymbol.declaredModule && !scope.module.isModuleImported(usedSymbol.declaredModule))
                        addedSym.isUnimported = true;
                    scope.module.markDependencyFunction(usedSymbol);
                    return typedb.LookupType(usedSymbol.namespace, usedSymbol.args[0].typename);
                }
            }
        }
    }

    // If we're inside a function call's argument list, we could be typing one of the argument names
    if (parseContext.argumentFunction && parseContext.argumentFunction.args)
    {
        for (let arg of parseContext.argumentFunction.args)
        {
            if (arg.name == node.value)
                return null;
        }
    }

    // We might be typing a typename at the start of a declaration, which accidentally got parsed as an identifier due to incompleteness
    let isTypingSingleIdentifier = (node == statement.ast && scope.module.isEditingInside(statement.start_offset + node.start, statement.end_offset + node.end + 2));
    if (isTypingSingleIdentifier || node.maybeTypename)
    {
        // It could be a type as well
        let symType = typedb.LookupType(scope.getNamespace(), node.value);
        if (symType)
        {
            let addedSymbol = AddIdentifierSymbol(scope, statement, node, ASSymbolType.Typename, null, symType.name);
            if (symType.declaredModule && !ScriptSettings.automaticImports && !scope.module.isModuleImported(symType.declaredModule))
                addedSymbol.isUnimported = true;

            scope.module.markDependencyType(symType);

            // We do not return the symbol here, because we tried to parse a typename as an identifier
            // This should only happen on incomplete statements.
            return null;
        }

        // We could be typing a namespace
        let nsType = typedb.LookupNamespace(scope.getNamespace(), node.value);
        if (nsType)
        {
            let symType = ASSymbolType.Namespace;
            let addedSymbol = AddIdentifierSymbol(scope, statement, node, symType, null, nsType.getQualifiedNamespace());
            scope.module.markDependencyNamespace(nsType);

            // We do not return the symbol here, because we tried to parse a namespace as an identifier
            // This should only happen on incomplete statements.
            return null;
        }
    }

    // This could also be an 'auto' keyword
    if (node.value == "auto")
    {
        AddIdentifierSymbol(scope, statement, node, ASSymbolType.Typename, null, "auto");
        return null;
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (parseContext.allow_errors)
    {
        let hasPotentialCompletions = false;
        if (scope.module.isEditingNode(statement, node))
        {
            // Check if the symbol that we're editing can still complete to something valid later
            hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbol(scope, statement, parseContext, node.value, typedb.DBAllowSymbol.PropertiesAndFunctions);
        }

        AddUnknownSymbol(scope, statement, node, hasPotentialCompletions);
        scope.module.markDependencyIdentifier(node.value);
    }

    return null;
}

function DetectSymbolFromNamespacedIdentifier(scope : ASScope, statement : ASStatement, identifier : any, allow_errors = true, symbol_type : typedb.DBAllowSymbol) : boolean
{
    if (!identifier)
        return false;
    if (identifier.value.indexOf("::") == -1)
        return false;

    let scopes = identifier.value.split("::");
    let nsName = "";
    for (let i = 0; i < scopes.length-1; ++i)
    {
        if (i != 0)
            nsName += "::";
        nsName += scopes[i];
    }

    let refType = typedb.LookupType(scope.getNamespace(), nsName.trim());
    let namespace = typedb.LookupNamespace(scope.getNamespace(), nsName.trim());

    if (!refType && !namespace)
        return false;

    let nsSymbol = AddIdentifierSymbol(scope, statement, {
        start: identifier.start,
        end: identifier.start+nsName.length,
        value: nsName
    }, ASSymbolType.Namespace, null, null);

    if (refType && (namespace || refType.isEnum))
    {
        nsSymbol.type = ASSymbolType.Typename;
        nsSymbol.symbol_name = refType.name;
    }
    else
    {
        nsSymbol.symbol_name = namespace.getQualifiedNamespace();
    }

    // Could be a symbol inside the type
    let findName = identifier.value.substr(nsName.length+2).trim();
    let identifierNode = {
        start: identifier.start+nsName.length+2,
        end: identifier.end,
        value: findName,
    };

    if (refType && refType.isEnum)
    {
        let usedSymbol = refType.findFirstSymbol(findName, symbol_type);
        if (usedSymbol)
        {
            let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.MemberVariable : ASSymbolType.MemberFunction;
            AddIdentifierSymbol(scope, statement, identifierNode, symType, usedSymbol.containingType, usedSymbol.name);
            scope.module.markDependencySymbol(usedSymbol);
            return true;
        }
    }
    else
    {
        let usedSymbol = namespace.findFirstSymbol(findName, symbol_type);
        if (usedSymbol)
        {
            let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.GlobalVariable : ASSymbolType.GlobalFunction;
            AddIdentifierSymbol(scope, statement, identifierNode, symType, namespace.getQualifiedNamespace(), usedSymbol.name);
            scope.module.markDependencySymbol(usedSymbol);
            return true;
        }

        // Could be a property accessor
        if (typedb.AllowsProperties(symbol_type))
        {
            let getAccessor = namespace.findFirstSymbol("Get"+findName, typedb.DBAllowSymbol.Functions);
            if (getAccessor && getAccessor instanceof typedb.DBMethod)
            {
                AddIdentifierSymbol(scope, statement, identifierNode, ASSymbolType.GlobalAccessor, namespace.getQualifiedNamespace(), getAccessor.name);
                scope.module.markDependencyFunction(getAccessor);
                return true;
            }

            let setAccessor = namespace.findFirstSymbol("Set"+findName, typedb.DBAllowSymbol.Functions);
            if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
            {
                AddIdentifierSymbol(scope, statement, identifierNode, ASSymbolType.GlobalAccessor, namespace.getQualifiedNamespace(), setAccessor.name);
                scope.module.markDependencyFunction(setAccessor);
                return true;
            }
        }
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (allow_errors)
    {
        let hasPotentialCompletions = false;
        if (scope.module.isEditingNode(statement, identifier))
        {
            // Check if the symbol that we're editing can still complete to something valid later
            if (refType && refType.isEnum)
                hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbolInType(scope, statement, refType, findName, typedb.DBAllowSymbol.PropertiesAndFunctions);
            else
                hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbolInNamespace(scope, statement, namespace, findName, typedb.DBAllowSymbol.PropertiesAndFunctions);
        }

        AddUnknownSymbol(scope, statement, identifierNode, hasPotentialCompletions);
        scope.module.markDependencyIdentifier(identifierNode.value);
    }

    return true;
}

function DetectSymbolFromDelegateBindFunctionName(scope : ASScope, statement : ASStatement, parseContext : ASParseContext, delegateBind : ASDelegateBind)
{
    let insideType = ResolveTypeFromExpression(scope, delegateBind.node_object);
    let nameNode = delegateBind.node_name;
    if (nameNode && (nameNode.type == node_types.ConstName || nameNode.type == node_types.ConstString) && insideType)
    {
        let funcName = nameNode.value;
        let symbolOffset = 1;
        if (nameNode.type == node_types.ConstName)
        {
            symbolOffset = 2;
            funcName = funcName.substring(2, funcName.length-1);
        }
        else
        {
            funcName = funcName.substring(1, funcName.length-1);
        }

        let foundFunc = insideType.findFirstSymbol(funcName, typedb.DBAllowSymbol.Functions);
        if (!foundFunc)
        {
            if (!scope.module.isEditingNode(statement, nameNode))
            {
                AddUnknownSymbol(scope, statement, {
                    value: funcName,
                    start: nameNode.start + symbolOffset,
                    end: nameNode.end - 1,
                }, false);
            }
        }
        else
        {
            let symbol = AddIdentifierSymbol(scope, statement, nameNode, ASSymbolType.MemberFunction, foundFunc.containingType.name, foundFunc.name);
            if (symbol)
            {
                symbol.start += symbolOffset;
                symbol.end -= 1;
                symbol.noColor = true;
            }
        }
    }
}

function CheckIdentifierIsPrefixForValidSymbol(scope : ASScope, statement : ASStatement, parseContext : ASParseContext, identifierPrefix : string, symbol_type : typedb.DBAllowSymbol) : boolean
{
    if (identifierPrefix.length < 2)
        return true;

    // Check for local variables
    if (typedb.AllowsProperties(symbol_type))
    {
        let checkscope = scope;
        while (checkscope && checkscope.isInFunctionBody())
        {
            for (let usedVariable of checkscope.variables)
            {
                if (usedVariable.name.startsWith(identifierPrefix))
                    return true;
            }
            checkscope = checkscope.parentscope;
        }
    }

    // Find a symbol in the class we're in
    let insideType = scope.getParentType();
    if (insideType)
    {
        let usedSymbol = insideType.findFirstSymbolWithPrefix(identifierPrefix, symbol_type);
        if (usedSymbol)
            return true;

        if (typedb.AllowsProperties(symbol_type))
        {
            let getAccessor = insideType.findFirstSymbolWithPrefix("Get"+identifierPrefix, typedb.DBAllowSymbol.Functions);
            if (getAccessor && getAccessor instanceof typedb.DBMethod)
                return true;

            let setAccessor = insideType.findFirstSymbol("Set"+identifierPrefix, typedb.DBAllowSymbol.Functions);
            if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
                return true;
        }
    }

    // It could be a type as well
    if (typedb.HasTypeWithPrefix(scope.getNamespace(), identifierPrefix))
        return true;

    // Maybe we're typing a keyword?
    for (let kw of ASKeywords)
    {
        if (kw.startsWith(identifierPrefix))
            return true;
    }

    // If we're inside a function call's argument list, we could be completing one of the argument names
    if (parseContext.argumentFunction && parseContext.argumentFunction.args)
    {
        for (let arg of parseContext.argumentFunction.args)
        {
            if (arg.name.startsWith(identifierPrefix))
                return true;
        }
    }

    // We could be typing a global in a module we haven't imported yet
    {
        let prefixed = typedb.LookupGlobalSymbolsWithPrefix(scope.getNamespace(), identifierPrefix);
        if (prefixed)
        {
            for (let func of prefixed)
            {
                if (func instanceof typedb.DBMethod && typedb.AllowsFunctions(symbol_type) && func.IsAccessibleFromModule(scope.module.modulename))
                {
                    if (!func.isMixin || (insideType && func.args.length != 0 && insideType.inheritsFrom(func.args[0].typename)))
                        return true;
                }
                if (func instanceof typedb.DBProperty && typedb.AllowsProperties(symbol_type))
                    return true;
            }
        }
    }

    // We could be typing a namespace
    let namespaces = typedb.LookupNamespacesWithPrefix(scope.getNamespace(), identifierPrefix);
    if (namespaces && namespaces.length != 0)
        return true;

    // We could be typing a global get accessor from a module we haven't imported yet
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessors = typedb.LookupGlobalSymbolsWithPrefix(scope.getNamespace(), "Get"+identifierPrefix, typedb.DBAllowSymbol.Functions);
        if (getAccessors)
        {
            for (let func of getAccessors)
            {
                if (func instanceof typedb.DBMethod && func.isProperty && !func.isMixin && func.IsAccessibleFromModule(scope.module.modulename))
                    return true;
            }
        }

        let setAccessors = typedb.LookupGlobalSymbolsWithPrefix(scope.getNamespace(), "Set"+identifierPrefix, typedb.DBAllowSymbol.Functions);
        if (setAccessors)
        {
            for (let func of setAccessors)
            {
                if (func instanceof typedb.DBMethod && func.isProperty && !func.isMixin && func.IsAccessibleFromModule(scope.module.modulename))
                    return true;
            }
        }
    }

    // Nothing found whatsoever
    return false;
}

function DetectSymbolsInType(scope : ASScope, statement : ASStatement, inSymbol : typedb.DBType | typedb.DBSymbol, node : any, parseContext : ASParseContext, symbol_type : typedb.DBAllowSymbol) : typedb.DBSymbol | typedb.DBType
{
    if (!inSymbol)
        return null;

    let dbtype : typedb.DBType = null;
    if (inSymbol instanceof typedb.DBType)
        dbtype = inSymbol;
    else if (inSymbol instanceof typedb.DBProperty)
        dbtype = typedb.LookupType(inSymbol.namespace, inSymbol.typename);

    if (!dbtype)
        return null;

    let symType : ASSymbolType = ASSymbolType.UnknownError;

    // Could be a symbol inside the type
    let usedSymbol = dbtype.findFirstSymbol(node.value, symbol_type);
    if (usedSymbol)
    {
        if (usedSymbol instanceof typedb.DBProperty)
            symType = ASSymbolType.MemberVariable;
        else
            symType = ASSymbolType.MemberFunction;

        let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.containingType, usedSymbol.name);
        scope.module.markDependencySymbol(usedSymbol);
        return usedSymbol;
    }

    // Could be a property accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessor = dbtype.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.Functions);
        if (getAccessor && getAccessor instanceof typedb.DBMethod)
        {
            symType = ASSymbolType.MemberAccessor;
            let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, getAccessor.containingType, getAccessor.name);
            scope.module.markDependencyFunction(getAccessor);
            return typedb.LookupType(getAccessor.namespace, getAccessor.returnType);
        }

        let setAccessor = dbtype.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.Functions);
        if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
        {
            symType = ASSymbolType.MemberAccessor;
            let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, setAccessor.containingType, setAccessor.name);
            scope.module.markDependencyFunction(setAccessor);
            return typedb.LookupType(setAccessor.namespace, setAccessor.args[0].typename);
        }
    }

    if (typedb.AllowsFunctions(symbol_type))
    {
        // Check if this is a mixin call in an unimported global scope
        let mixinFunctions = typedb.LookupGlobalSymbol(scope.getNamespace(), node.value, typedb.DBAllowSymbol.Mixins);
        if (mixinFunctions)
        {
            for (let symbol of mixinFunctions)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    if (!symbol.isMixin)
                        continue;
                    if (symbol.args.length != 0 && dbtype.inheritsFrom(symbol.args[0].typename))
                    {
                        let addedSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalFunction, symbol.namespace.getQualifiedNamespace(), symbol.name);
                        if (!ScriptSettings.automaticImports && symbol.declaredModule && !scope.module.isModuleImported(symbol.declaredModule))
                            addedSym.isUnimported = true;
                        scope.module.markDependencyFunction(symbol);
                        return symbol;
                    }
                }
            }
        }
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (parseContext.allow_errors)
    {
        let hasPotentialCompletions = false;
        if (scope.module.isEditingNode(statement, node))
        {
            // Check if the symbol that we're editing can still complete to something valid later
            hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbolInType(scope, statement, dbtype, node.value, typedb.DBAllowSymbol.PropertiesAndFunctions);
        }

        AddUnknownSymbol(scope, statement, node, hasPotentialCompletions);
        scope.module.markDependencyIdentifier(node.value);
    }

    return null;
}

function CheckIdentifierIsPrefixForValidSymbolInType(scope : ASScope, statement : ASStatement, dbtype : typedb.DBType, identifierPrefix : string, symbol_type : typedb.DBAllowSymbol) : boolean
{
    if (identifierPrefix.length < 2)
        return true;

    // Could be a symbol inside the type
    let usedSymbol = dbtype.findFirstSymbolWithPrefix(identifierPrefix, symbol_type);
    if (usedSymbol)
        return true;

    // Could be a property accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessor = dbtype.findFirstSymbolWithPrefix("Get"+identifierPrefix, typedb.DBAllowSymbol.Functions);
        if (getAccessor && getAccessor instanceof typedb.DBMethod)
            return true;

        let setAccessor = dbtype.findFirstSymbolWithPrefix("Set"+identifierPrefix, typedb.DBAllowSymbol.Functions);
        if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
            return true;
    }

    if (typedb.AllowsFunctions(symbol_type))
    {
        // Could be a mixin function in global scope
        let mixinFunctions = typedb.LookupGlobalSymbolsWithPrefix(scope.getNamespace(), identifierPrefix, typedb.DBAllowSymbol.Mixins);
        if (mixinFunctions)
        {
            for (let usedSymbol of mixinFunctions)
            {
                if (usedSymbol instanceof typedb.DBMethod)
                {
                    if (!usedSymbol.isMixin)
                        continue;
                    if (usedSymbol.isLocal && usedSymbol.IsAccessibleFromModule(scope.module.modulename))
                        continue;
                    if (usedSymbol.args.length != 0 && dbtype.inheritsFrom(usedSymbol.args[0].typename))
                    {
                        return true;
                    }
                }
            }
        }
    }

    return false;
}

function DetectSymbolsInNamespace(scope : ASScope, statement : ASStatement, namespace : typedb.DBNamespace, node : any, parseContext : ASParseContext, symbol_type : typedb.DBAllowSymbol) : typedb.DBSymbol | typedb.DBType
{
    if (!namespace)
        return null;

    let symType : ASSymbolType = ASSymbolType.UnknownError;

    // Could be a symbol inside the type
    let usedSymbol = namespace.findFirstSymbol(node.value, symbol_type);
    if (usedSymbol)
    {
        if (usedSymbol instanceof typedb.DBType)
        {
            let identifierSym = AddIdentifierSymbol(scope, statement, node, ASSymbolType.Typename, null, usedSymbol.name);
            if (!ScriptSettings.automaticImports && usedSymbol.declaredModule && !scope.module.isModuleImported(usedSymbol.declaredModule))
                identifierSym.isUnimported = true;

            scope.module.markDependencyType(usedSymbol);
            return usedSymbol;
        }
        else
        {
            if (usedSymbol instanceof typedb.DBProperty)
                symType = ASSymbolType.GlobalVariable;
            else
                symType = ASSymbolType.GlobalFunction;

            let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.namespace.getQualifiedNamespace(), usedSymbol.name);
            if (!ScriptSettings.automaticImports && usedSymbol.declaredModule && !scope.module.isModuleImported(usedSymbol.declaredModule))
                identifierSym.isUnimported = true;

            scope.module.markDependencySymbol(usedSymbol);
            return usedSymbol;
        }
    }

    // Could be a property accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessor = namespace.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.Functions);
        if (getAccessor && getAccessor instanceof typedb.DBMethod)
        {
            symType = ASSymbolType.GlobalAccessor;
            let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, getAccessor.namespace.getQualifiedNamespace(), getAccessor.name);
            if (!ScriptSettings.automaticImports && getAccessor.declaredModule && !scope.module.isModuleImported(getAccessor.declaredModule))
                identifierSym.isUnimported = true;

            scope.module.markDependencyFunction(getAccessor);
            return typedb.LookupType(getAccessor.namespace, getAccessor.returnType);
        }

        let setAccessor = namespace.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.Functions);
        if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
        {
            symType = ASSymbolType.GlobalAccessor;
            let identifierSym = AddIdentifierSymbol(scope, statement, node, symType, setAccessor.namespace.getQualifiedNamespace(), setAccessor.name);
            if (!ScriptSettings.automaticImports && getAccessor.declaredModule && !scope.module.isModuleImported(setAccessor.declaredModule))
                identifierSym.isUnimported = true;

            scope.module.markDependencyFunction(setAccessor);
            return typedb.LookupType(setAccessor.namespace, setAccessor.args[0].typename);
        }
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (parseContext.allow_errors)
    {
        let hasPotentialCompletions = false;
        if (scope.module.isEditingNode(statement, node))
        {
            // Check if the symbol that we're editing can still complete to something valid later
            hasPotentialCompletions = CheckIdentifierIsPrefixForValidSymbolInNamespace(scope, statement, namespace, node.value, typedb.DBAllowSymbol.PropertiesAndFunctions);
        }

        AddUnknownSymbol(scope, statement, node, hasPotentialCompletions);
        scope.module.markDependencyIdentifier(node.value);
    }

    return null;
}

function CheckIdentifierIsPrefixForValidSymbolInNamespace(scope : ASScope, statement : ASStatement, namespace : typedb.DBNamespace, identifierPrefix : string, symbol_type : typedb.DBAllowSymbol) : boolean
{
    if (identifierPrefix.length < 2)
        return true;

    // Could be a symbol inside the type
    let usedSymbol = namespace.findFirstSymbolWithPrefix(identifierPrefix, symbol_type, true);
    if (usedSymbol)
        return true;

    // Could be a property accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessor = namespace.findFirstSymbolWithPrefix("Get"+identifierPrefix, typedb.DBAllowSymbol.Functions, true);
        if (getAccessor && getAccessor instanceof typedb.DBMethod)
            return true;

        let setAccessor = namespace.findFirstSymbolWithPrefix("Set"+identifierPrefix, typedb.DBAllowSymbol.Functions, true);
        if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
            return true;
    }

    // Could be a child namespace we're typing
    let childNS = namespace.findChildNamespacesWithPrefix(identifierPrefix);
    if (childNS)
        return true;

    return false;
}


let re_equalsspecifier = /^(.*)=\s*$/;
let re_formatspecifier = /^(.*)=?:(.?[=<>^])?[0-9dxXbconeEfFgG,+-\.%#\s]*$/;
function DetectFormatStringSymbols(scope : ASScope, statement : ASStatement, node : any, parseContext : ASParseContext)
{
    // It's not ideal having to re-parse the string into parts here, but not sure it can be avoided

    // Parse each {CODE} expression into a string
    let expressions = new Array<string>();
    let offsets = new Array<number>();

    let index = 2;
    let count = node.value.length;
    let expressionStart = -1;

    for (; index < count; ++index)
    {
        let char : string = node.value[index];

        if (expressionStart == -1)
        {
            if (char == '{')
            {
                if (index+1 < count && node.value[index+1] == '{')
                {
                    index += 1;
                    continue;
                }
                else
                {
                    expressionStart = index+1;
                }
            }
        }
        else
        {
            if (char == '}')
            {
                expressions.push(node.value.substring(expressionStart, index));
                offsets.push(expressionStart);
                expressionStart = -1;
            }
        }
    }

    if (expressionStart != -1 && expressionStart < count-1)
    {
        expressions.push(node.value.substring(expressionStart, count-1));
        offsets.push(expressionStart);
    }

    for (let i = 0; i < expressions.length; ++i)
    {
        // Run it through the format specifier regex to remove the specifier part
        let match = expressions[i].match(re_equalsspecifier);
        if (match)
        {
            expressions[i] = match[1];
        }
        else
        {
            match = expressions[i].match(re_formatspecifier);
            if (match)
            {
                expressions[i] = match[1];
            }
        }

        let fakeStatement = new ASStatement();
        fakeStatement.content = expressions[i];
        fakeStatement.start_offset = statement.start_offset + node.start + offsets[i];
        fakeStatement.end_offset = fakeStatement.start_offset + fakeStatement.content.length;

        fakeStatement.rawIndex = scope.module.rawStatements.length;
        scope.module.rawStatements.push(fakeStatement);

        // Parse the expression part with our grammar
        let fromCache = GetCachedStatementParse(scope.module, ASScopeType.Code, fakeStatement, fakeStatement.rawIndex);
        if (!fromCache)
        {
            ParseStatement(ASScopeType.Code, fakeStatement);
            scope.module.parsedStatementCount += 1;
        }
        else
        {
            scope.module.loadedFromCacheCount += 1;
        }

        // Detect symbols in the parsed expression
        if (fakeStatement.ast)
            DetectNodeSymbols(scope, fakeStatement, fakeStatement.ast, parseContext, typedb.DBAllowSymbol.Properties);
    }
}

function ParseScopeIntoStatements(scope : ASScope)
{
    let module = scope.module;
    let length = scope.end_offset - scope.start_offset;

    scope.parsed = true;

    let depth_brace = 0;
    let depth_paren = 0;
    let scope_start = -1;

    let statement_start = scope.start_offset;
    let log_start = statement_start;
    let cur_offset = scope.start_offset;

    let in_preprocessor_directive = false;
    let in_line_comment = false;
    let in_block_comment = false;
    let in_dq_string = false;
    let in_sq_string = false;
    let in_escape_sequence = false;

    let cur_element : ASElement = null;
    function finishElement(element : ASElement)
    {
        if (!scope.element_head)
            scope.element_head = element;
        element.previous = cur_element;
        if (cur_element)
            cur_element.next = element;
        cur_element = element;
    }

    function finishStatement(endsWithSemicolon : boolean)
    {
        if (statement_start != cur_offset)
        {
            let content = module.content.substring(statement_start, cur_offset);
            if (content.length != 0 && !/^[ \t\r\n]*$/.test(content))
            {
                let statement = new ASStatement;
                statement.content = content;
                statement.start_offset = statement_start;
                statement.end_offset = cur_offset;
                statement.endsWithSemicolon = endsWithSemicolon;

                scope.statements.push(statement);
                statement.rawIndex = scope.module.rawStatements.length;
                scope.module.rawStatements.push(statement);
                finishElement(statement);
            }
        }

        statement_start = cur_offset+1;
    }

    function restartStatement()
    {
        statement_start = cur_offset+1;
    }

    for (; cur_offset < scope.end_offset; ++cur_offset)
    {
        let curchar = scope.module.content[cur_offset];

        // Start the next line
        if (curchar == '\n')
        {
            if (in_preprocessor_directive)
                in_preprocessor_directive = false;

            if (in_line_comment)
                in_line_comment = false;

            continue;
        }

        if (in_line_comment)
            continue;

        if (in_block_comment)
        {
            if (curchar == '/' && scope.module.content[cur_offset-1] == '*')
            {
                in_block_comment = false;
            }
            continue;
        }

        if (in_sq_string)
        {
            if (!in_escape_sequence && curchar == '\'')
            {
                in_sq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = !in_escape_sequence;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_dq_string)
        {
            if (!in_escape_sequence && curchar == '"')
            {
                in_dq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = !in_escape_sequence;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_preprocessor_directive)
            continue;

        // String Literals
        if (curchar == '"')
        {
            in_dq_string = true;
            continue;
        }

        if (curchar == '\'')
        {
            in_sq_string = true;
            continue;
        }

        // Comments
        if (curchar == '/' && cur_offset+1 < scope.end_offset && scope.module.content[cur_offset+1] == '/')
        {
            in_line_comment = true;
            continue;
        }

        if (curchar == '/' && cur_offset+1 < scope.end_offset && scope.module.content[cur_offset+1] == '*')
        {
            in_block_comment = true;
            continue;
        }

        // Preprocessor directives
        if (curchar == '#' && depth_brace == 0)
        {
            in_preprocessor_directive = true;
            continue;
        }

        // We could be starting a scope
        if (curchar == '{')
        {
            if (depth_brace == 0)
            {
                finishStatement(false);
                scope_start = cur_offset;

                // Reset paren depth, must be an error if we still have parens open
                depth_paren = 0;
            }

            depth_brace += 1;
        }
        else if (curchar == '}')
        {
            if (depth_brace == 0)
            {
                // This is a brace mismatch error, we should actually ignore it
                continue;
            }

            depth_brace -= 1;
            if (depth_brace == 0)
            {
                // Create a subscope for this content
                let subscope = new ASScope;
                subscope.parentscope = scope;
                subscope.module = scope.module;
                subscope.start_offset = scope_start+1;
                subscope.end_offset = cur_offset;

                scope.scopes.push(subscope);
                finishElement(subscope);
                scope_start = null;

                restartStatement();
            }
        }

        // Skip character if we're in a subscope
        if (depth_brace != 0)
            continue;

        // Keep track of parentheses
        if (curchar == '(')
        {
            depth_paren += 1;
        }
        else if (curchar == ')')
        {
            depth_paren -= 1;

            // Ignore mismatched closing parens for this, can happen
            if (depth_paren < 0)
                depth_paren = 0;
        }

        // If we just typed a dot as the last character of the line,
        // and we aren't inside any parentheses, split on the dot.
        // This improves behaviour when in progress of typing a line above another line.
        if ((curchar == '.' || curchar == ':')
            && depth_paren == 0
            && scope.module.isEditingInside(cur_offset-16, cur_offset+1)
            && cur_offset+1 < scope.end_offset)
        {
            let nextchar = scope.module.content[cur_offset+1];
            if (nextchar == '\r' || nextchar == '\n')
            {
                cur_offset += 1;
                finishStatement(false);
            }
        }


        // Detect semicolons to delimit statements
        if (curchar == ';' && depth_paren == 0)
            finishStatement(true);
    }

    finishStatement(false);

    // Also parse any subscopes we detected
    for (let subscope of scope.scopes)
        ParseScopeIntoStatements(subscope);
}

function DetermineScopeType(scope : ASScope)
{
    // Determine what the type of this scope is based on the previous statement
    if (scope.parentscope)
    {
        // Scopes underneath a function are never anything but code scopes
        if (scope.parentscope.scopetype == ASScopeType.Function || scope.parentscope.scopetype == ASScopeType.LiteralAsset)
        {
            scope.scopetype = ASScopeType.Code;
            return;
        }

        // Default to the paren't scope type
        scope.scopetype = scope.parentscope.scopetype;
    }
    else
    {
        // If we have no parent we are global
        scope.scopetype = ASScopeType.Global;
    }

    if (scope.previous && scope.previous instanceof ASStatement)
    {
        if (scope.previous.ast)
        {
            let ast_type = scope.previous.ast.type;
            if (ast_type == node_types.ClassDefinition)
            {
                scope.scopetype = ASScopeType.Class;
            }
            else if (ast_type == node_types.StructDefinition)
            {
                scope.scopetype = ASScopeType.Class;
            }
            else if (ast_type == node_types.EnumDefinition)
            {
                scope.scopetype = ASScopeType.Enum;
            }
            else if (ast_type == node_types.NamespaceDefinition)
            {
                scope.scopetype = ASScopeType.Namespace;
            }
            else if (ast_type == node_types.FunctionDecl)
            {
                scope.scopetype = ASScopeType.Function;
            }
            else if (ast_type == node_types.ConstructorDecl)
            {
                scope.scopetype = ASScopeType.Function;
            }
            else if (ast_type == node_types.DestructorDecl)
            {
                scope.scopetype = ASScopeType.Function;
            }
            else if (ast_type == node_types.AssetDefinition)
            {
                scope.scopetype = ASScopeType.LiteralAsset;
            }
        }
    }
}

function GetCachedStatementParse(module : ASModule, scopetype : ASScopeType, statement : ASStatement, rawIndex : number) : boolean
{
    if (!module.cachedStatements)
        return false;
    if (rawIndex >= module.cachedStatements.length)
        return false;

    // Check if the last statement we have cached matches
    let cachedStatement = module.cachedStatements[rawIndex];
    if (cachedStatement && cachedStatement.parsed && cachedStatement.parsedType == scopetype && cachedStatement.content == statement.content)
    {
        statement.ast = cachedStatement.ast;
        statement.parsed = true;
        statement.parseError = cachedStatement.parseError;
        statement.parsedType = cachedStatement.parsedType;
        return true;
    }

    // Also check if the next statement in the cache matches, maybe we inserted something
    if (rawIndex+1 < module.cachedStatements.length)
    {
        cachedStatement = module.cachedStatements[rawIndex+1];
        if (cachedStatement && cachedStatement.parsed && cachedStatement.parsedType == scopetype && cachedStatement.content == statement.content)
        {
            statement.parsed = true;
            statement.parseError = cachedStatement.parseError;
            statement.parsedType = cachedStatement.parsedType;
            statement.ast = cachedStatement.ast;
            return true;
        }
    }

    // Also check if the previous statement in the cache matches, maybe we deleted something
    if (rawIndex > 0)
    {
        cachedStatement = module.cachedStatements[rawIndex-1];
        if (cachedStatement && cachedStatement.parsed && cachedStatement.parsedType == scopetype && cachedStatement.content == statement.content)
        {
            statement.parsed = true;
            statement.parseError = cachedStatement.parseError;
            statement.parsedType = cachedStatement.parsedType;
            statement.ast = cachedStatement.ast;
            return true;
        }
    }

    // No statement matches, but skip ahead in the cache anyway, more chance to find matching again later
    return false;
}

function ParseAllStatements(scope : ASScope, debug : boolean = false)
{
    // Determine what the type of this scope is based on the previous statement
    DetermineScopeType(scope);

    // Statements we detected should be parsed
    for (let i = 0, count = scope.statements.length; i < count; ++i)
    {
        let statement = scope.statements[i];
        if (!statement)
            continue;

        let fromCache = GetCachedStatementParse(scope.module, scope.scopetype, statement, statement.rawIndex);
        if (!fromCache)
        {
            ParseStatement(scope.scopetype, statement, debug);
            scope.module.parsedStatementCount += 1;
        }
        else
        {
            scope.module.loadedFromCacheCount += 1;
        }

        // The statement failed to parse, and we are currently editing
        // inside it. It's likely that we are typing a new statement in front of
        // the next statement, but haven't typed the semicolon yet.
        // In this case we will try to split it into two statements instead.
        let trySplit = false;
        let allowNoSplit = false;
        if (!statement.ast)
        {
            if (scope.module.isEditingInside(statement.start_offset, statement.end_offset))
            {
                trySplit = true;
            }
        }
        if (!trySplit && statement.ast && statement.ast.type == node_types.VariableDecl && scope.module.isEditingInside(statement.start_offset, statement.end_offset))
        {
            let startLine = scope.module.getPosition(statement.start_offset).line;
            let endLine = scope.module.getPosition(statement.end_offset).line;
            if (startLine != endLine && scope.module.getPosition(scope.module.lastEditStart).line < endLine)
            {
                trySplit = true;
                allowNoSplit = true;
            }
        }

        if (trySplit)
        {
            let splitContent = SplitStatementBasedOnEdit(statement.content, scope.module.lastEditStart - statement.start_offset, allowNoSplit);
            if (splitContent && splitContent.length != 0)
            {
                let orig_start = statement.start_offset;
                let orig_end = statement.end_offset;

                // Replace current statement with first split element
                statement.content = splitContent[0];
                statement.end_offset = statement.start_offset + statement.content.length;
                statement.parsed = false;

                let fromCache = GetCachedStatementParse(scope.module, scope.scopetype, statement, statement.rawIndex);
                if (!fromCache)
                {
                    ParseStatement(scope.scopetype, statement, debug);
                    scope.module.parsedStatementCount += 1;
                }
                else
                {
                    scope.module.loadedFromCacheCount += 1;
                }

                // Add new statements for each element in the split
                let splitOffset = statement.end_offset;
                let prevStatement = statement;
                for (let splitIndex = 1; splitIndex < splitContent.length; ++splitIndex)
                {
                    if (!splitContent[splitIndex])
                        continue;

                    let newStatement = new ASStatement();
                    newStatement.content = splitContent[splitIndex];
                    newStatement.start_offset = splitOffset;
                    newStatement.end_offset = splitOffset + newStatement.content.length;

                    newStatement.previous = prevStatement;
                    newStatement.next = prevStatement.next;

                    if (prevStatement.next)
                        prevStatement.next.previous = newStatement;
                    prevStatement.next = newStatement;

                    scope.statements.push(newStatement);

                    let fromCache = GetCachedStatementParse(scope.module, scope.scopetype, newStatement, statement.rawIndex);
                    if (!fromCache)
                    {
                        ParseStatement(scope.scopetype, newStatement, debug);
                        scope.module.parsedStatementCount += 1;
                    }
                    else
                    {
                        scope.module.loadedFromCacheCount += 1;
                    }
                }
            }
        }

        /*if (!statement.ast)
        {
            console.log("Failed to parse: "+statement.content);
            console.log("Statement: "+statement.start_offset+" -> "+statement.end_offset);
            console.log("Edit: "+scope.module.lastEditStart+" -> "+scope.module.lastEditEnd);
        }*/
    }

    // Also parse any subscopes we detected
    for (let subscope of scope.scopes)
        ParseAllStatements(subscope, debug)
}

function SplitStatementBasedOnEdit(content : string, editOffset : number, allowNoSplit : boolean) : Array<string>
{
    // Find the first linebreak after the edit position that completes all brackets before the edit position
    let length = content.length;

    let in_preprocessor_directive = false;
    let in_line_comment = false;
    let in_block_comment = false;
    let in_dq_string = false;
    let in_sq_string = false;
    let in_escape_sequence = false;

    let depth_brace = 0;
    let depth_paren = 0;
    let depth_squarebracket = 0;

    for (let splitIndex = 0; splitIndex < length; ++splitIndex)
    {
        let curchar = content[splitIndex];
        if (curchar == '\n')
        {
            if (in_preprocessor_directive)
                in_preprocessor_directive = false;

            if (in_line_comment)
                in_line_comment = false;
        }

        if (in_line_comment)
            continue;

        if (in_block_comment)
        {
            if (curchar == '/' && content[splitIndex-1] == '*')
            {
                in_block_comment = false;
            }
            continue;
        }

        if (in_sq_string)
        {
            if (!in_escape_sequence && curchar == '\'')
            {
                in_sq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = !in_escape_sequence;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_dq_string)
        {
            if (!in_escape_sequence && curchar == '"')
            {
                in_dq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = !in_escape_sequence;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_preprocessor_directive)
            continue;

        // String Literals
        if (curchar == '"')
        {
            in_dq_string = true;
            continue;
        }

        if (curchar == '\'')
        {
            in_sq_string = true;
            continue;
        }

        // Comments
        if (curchar == '/' && splitIndex+1 < length && content[splitIndex+1] == '/')
        {
            in_line_comment = true;
            continue;
        }

        if (curchar == '/' && splitIndex+1 < length && content[splitIndex+1] == '*')
        {
            in_block_comment = true;
            continue;
        }

        // Preprocessor directives
        if (curchar == '#' && depth_brace == 0)
        {
            in_preprocessor_directive = true;
            continue;
        }

        if (curchar == '{')
            depth_brace += 1;
        else if (curchar == '}')
            depth_brace -= 1;

        if (curchar == '(')
            depth_paren += 1;
        else if (curchar == ')')
            depth_paren -= 1;

        if (curchar == '[')
            depth_squarebracket += 1;
        else if (curchar == ']')
            depth_squarebracket -= 1;

        // Once we encounter a linebreak that is both after the
        // edit position, and also all parens and brackets have been closed,
        // we split it into two statements.
        if (splitIndex >= editOffset && curchar == '\n'
            && depth_brace == 0 && depth_paren == 0 && depth_squarebracket == 0)
        {
            return [
                content.substring(0, splitIndex+1),
                content.substring(splitIndex+1),
            ];
        }
    }

    // We reached the end of the statement without a linebreak, but we could still have a valid split all the way at the end
    if (allowNoSplit && depth_brace == 0 && depth_paren == 0 && depth_squarebracket == 0)
    {
        return [
            content,
            null,
        ];
    }

    // We didn't find a valid split that satisfies the bracket condition,
    // but we should still fall back to splitting after the line that we
    // are currently editing, in case that creates something valid.
    for (let splitIndex = editOffset; splitIndex < length; ++splitIndex)
    {
        let curchar = content[splitIndex];
        if (curchar == '\n')
        {
            return [
                content.substring(0, splitIndex+1),
                content.substring(splitIndex+1),
            ];
        }
    }

    return null;
}

function DisambiguateStatement(statement : ASStatement,  ast : any) : any
{
    // Sometimes in a class body we have ambiguous parsing between functions and variables.
    // This can happen in class bodies because "FVector Test()" can be either a function or a variable with a constructor.
    // We disambiguate based on whether the statement ends in a ';'
    if (ast[0].type == node_types.VariableDecl && ast[1].type == node_types.FunctionDecl)
        return statement.endsWithSemicolon ? ast[0] : ast[1];
    if (ast[1].type == node_types.VariableDecl && ast[0].type == node_types.FunctionDecl)
        return statement.endsWithSemicolon ? ast[1] : ast[0];

    // We prefer a variable declaration parse over a binary operation parse
    // This can happen when declaring variables of template types
    // eg "TArray<int> A" can be parsed as "(TArray < int) > A"
    if (ast[0].type == node_types.VariableDecl && ast[1].type == node_types.BinaryOperation)
        return ast[0];
    if (ast[1].type == node_types.VariableDecl && ast[0].type == node_types.BinaryOperation)
        return ast[1];

    return null;
}

export function ParseStatement(scopetype : ASScopeType, statement : ASStatement, debug : boolean = false)
{
    statement.parsed = true;
    statement.ast = null;
    statement.parsedType = scopetype;

    if (USE_PEGGY)
    {
        let startRule : string = null;
        switch (scopetype)
        {
            default:
            case ASScopeType.Global:
            case ASScopeType.Namespace:
                startRule = "start_global";
            break;
            case ASScopeType.Class:
                startRule = "start_class";
            break;
            case ASScopeType.Enum:
                startRule = "start_enum";
            break;
            case ASScopeType.Function:
            case ASScopeType.LiteralAsset:
            case ASScopeType.Code:
                startRule = "start";
            break;
        }

        let precedesBlock = statement.next && statement.next instanceof ASScope;
        let parseError = false;
        try
        {
            statement.ast = PEGGY_GRAMMAR.parse(statement.content, {
                startRule: startRule,
                precedesBlock: precedesBlock,
                endsWithSemicolon: statement.endsWithSemicolon,
            });
            statement.parseError = false;
        }
        catch (error)
        {
            // Debugging for unparseable statements
            if (debug)
            {
                console.log("Error Parsing Statement: ");
                console.log(statement.content);
                console.log(error);
            }

            parseError = true;
            statement.parseError = true;
        }
    }
    else
    {
        let parser : nearley.Parser = null;
        switch (scopetype)
        {
            default:
            case ASScopeType.Global:
            case ASScopeType.Namespace:
                parser = parser_global_statement;
                parser.restore(parser_global_statement_initial);
            break;
            case ASScopeType.Class:
                parser = parser_class_statement;
                parser.restore(parser_class_statement_initial);
            break;
            case ASScopeType.Enum:
                parser = parser_enum_statement;
                parser.restore(parser_enum_statement_initial);
            break;
            case ASScopeType.Function:
            case ASScopeType.LiteralAsset:
            case ASScopeType.Code:
                parser = parser_statement;
                parser.restore(parser_statement_initial);
            break;
        }

        let parseError = false;
        try
        {
            parser.feed(statement.content);
        }
        catch (error)
        {
            // Debugging for unparseable statements
            if (debug)
            {
                console.log("Error Parsing Statement: ");
                console.log(statement.content);
                console.log(error);
            }

            parseError = true;
            statement.parseError = true;
        }

        if (!parseError)
        {
            if (parser.results.length == 0)
            {
                statement.ast = null;
                statement.parseError = true;
            }
            else if (parser.results.length == 1)
            {
                // Unambiguous, take the first one
                statement.ast = parser.results[0];
                statement.parseError = false;
            }
            else
            {
                // We have some simple disambiguation rules to apply first
                statement.ast = DisambiguateStatement(statement, parser.results);
                statement.parseError = false;

                // If the disambiguation failed, take the first one anyway
                if (!statement.ast)
                {
                    statement.ast = parser.results[0];

                    // Debugging for ambiguous statements
                    if (debug)
                    {
                        console.log("Ambiguous Statement: ");
                        console.log(statement.content);
                        console.dir(parser.results, {depth:null});
                        throw "Ambiguous!";
                    }
                }
            }
        }
    }
}

