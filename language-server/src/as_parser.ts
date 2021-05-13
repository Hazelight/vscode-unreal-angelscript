import { TextDocument, } from "vscode-languageserver-textdocument";
import { Range, Position, Location, UniquenessLevel, } from "vscode-languageserver";

import * as fs from 'fs';
import * as nearley from 'nearley';

import * as typedb from './database';
import { RemoveScopeFromDatabase } from "./as_file";

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

let node_types = require("../grammar/node_types.js");

export enum ASScopeType
{
    Global,
    Class,
    Function,
    Enum,
    Code,
    Namespace
}

export class ASModule
{
    created : boolean = false;
    modulename : string;
    filename : string;
    uri : string;

    content : string = null;

    loaded: boolean = false;
    textDocument : TextDocument = null;

    parsed : boolean = false;
    rootscope : ASScope = null;

    resolved : boolean = false;

    global_type : typedb.DBType = null;
    all_global_types : Array<typedb.DBType> = [];

    namespaces : Array<typedb.DBType> = [];
    types : Array<typedb.DBType> = [];
    symbols : Array<ASSymbol> = [];

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

    getLocation(offset : number) : Location
    {
        return Location.create(
            this.uri,
            Range.create(
                this.getPosition(offset),
                this.getPosition(offset),
            ),
        )
    }

    getLocationRange(start_offset : number, end_offset : number) : Location
    {
        return Location.create(
            this.uri,
            this.getRange(start_offset, end_offset),
        )
    }

    getSymbolAt(offset : number) : ASSymbol
    {
        for (let symbol of this.symbols)
        {
            if (offset >= symbol.start && offset < symbol.end)
                return symbol;
        }
        return null;
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
    isPrivate : boolean = false;
    isProtected : boolean = false;
    isAuto : boolean = false;
    isIterator : boolean = false;

    in_statement : boolean = false;
    node_typename : any = null;
    node_expression : any = null;

    start_offset_type : number = -1;
    end_offset_type : number = -1;
    start_offset_name : number = -1;
    end_offset_name : number = -1;
    start_offset_expression : number = -1;
    end_offset_expression : number = -1;
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

    UnknownError,
};

export class ASSymbol
{
    type : ASSymbolType;
    start: number = -1;
    end: number = -1;

    container_type : string = null;
    symbol_name : string = null;
};

export class ASScope extends ASElement
{
    module : ASModule;

    range : Range;
    start_offset : number = -1;
    end_offset : number = -1;

    parsed : boolean = false;
    statements : Array<ASStatement> = [];
    scopes : Array<ASScope> = [];

    element_head : ASElement = null;

    scopetype : ASScopeType = null;
    parentscope : ASScope = null;

    variables : Array<ASVariable> = [];
    variablesByName : Map<string, ASVariable> = new Map<string, ASVariable>();

    dbtype : typedb.DBType = null;
    dbfunc : typedb.DBMethod = null;

    available_global_types : Array<typedb.DBType> = null;

    isInFunctionBody() : boolean
    {
        switch (this.scopetype)
        {
            case ASScopeType.Function:
            case ASScopeType.Code:
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

    getParentTypeScope() : ASScope
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            let dbType = checkscope.getDatabaseType();
            if (dbType)
                return checkscope;
            checkscope = checkscope.parentscope;
        }
        return null;
    }

    getParentType() : typedb.DBType
    {
        let typeScope = this.getParentTypeScope();
        if (!typeScope)
            return null;
        return typeScope.getDatabaseType();
    }

    getGlobalOrNamespaceParentType() : typedb.DBType
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            let dbType = checkscope.getDatabaseType();
            if (dbType
                && (checkscope.scopetype == ASScopeType.Namespace
                    || checkscope.scopetype == ASScopeType.Global))
            {
                return dbType;
            }
            checkscope = checkscope.parentscope;
        }
        return null;
    }

    getNamespaceParentType() : typedb.DBType
    {
        let checkscope : ASScope = this;
        while (checkscope != null)
        {
            let dbType = checkscope.getDatabaseType();
            if (dbType && checkscope.scopetype == ASScopeType.Namespace)
                return dbType;
            checkscope = checkscope.parentscope;
        }
        return null;
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
        if(typename.startsWith("__"))
            typename = typename.substr(2);

        let dbtype = this.getDatabaseType();
        if(dbtype && dbtype.typename == typename)
            return this;
        for(let subscope of this.scopes)
        {
            let found = subscope.findScopeForType(typename);
            if(found)
                return found;
        }
        return null;
    }

    getAvailableGlobalTypes() : Array<typedb.DBType>
    {
        if (!this.available_global_types)
        {
            this.available_global_types = new Array<typedb.DBType>();

            let checkscope : ASScope = this;
            while (checkscope != null)
            {
                let dbType = checkscope.getDatabaseType();
                if (dbType && checkscope.scopetype == ASScopeType.Namespace)
                    this.available_global_types.push(dbType);
                checkscope = checkscope.parentscope;
            }

            for (let globalType of this.module.all_global_types)
            {
                if (globalType)
                    this.available_global_types.push(globalType);
            }
        }

        return this.available_global_types;
    }
};

export class ASStatement extends ASElement
{
    content : string;

    range : Range;
    start_offset : number = -1;
    end_offset : number = -1;

    ast : any = null;
    parsed : boolean = false;
}

let ModuleDatabase = new Map<string, ASModule>();
let ModulesByUri = new Map<string, ASModule>();

// Get all modules currently loaded
export function GetAllModules() : Array<ASModule>
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
        module.uri = NormalizeUri(uri);
        module.filename = filename;
        module.created = true;
        ModulesByUri.set(module.uri, module);
    }

    return module;
}

function NormalizeUri(uri : string) : string
{
    return uri.replace("%3A", ":");
}

// Ensure the module is parsed into an abstract syntax tree if it is not already parsed
export function ParseModule(module : ASModule, debug : boolean = false)
{
    if (module.parsed)
        return;
    module.parsed = true;

    module.rootscope = new ASScope;
    module.rootscope.module = module;
    module.rootscope.start_offset = 0;
    module.rootscope.end_offset = module.textDocument.getText().length;
    module.rootscope.range = module.getRange(module.rootscope.start_offset, module.rootscope.end_offset);

    // Parse content of file into distinct statements
    ParseScopeIntoStatements(module.rootscope);

    // Parse each statement into an abstract syntax tree
    ParseAllStatements(module.rootscope, debug);

    // Create the global type for the module
    module.global_type = AddDBType(module.rootscope, "//"+module.modulename);
    module.global_type.moduleOffset = 0;
    module.rootscope.dbtype = module.global_type;

    // Traverse syntax trees to lift out functions, variables and imports during this first parse step
    GenerateTypeInformation(module.rootscope);
}

// Resolve symbols in the module from the syntax tree if not already resolved
export function ResolveModule(module : ASModule)
{
    if (module.resolved)
        return;
    module.resolved = true;

    // Resolve which global types should be used
    module.all_global_types = [ module.global_type, typedb.GetType("__") ];

    // Resolve autos to the correct types
    ResolveAutos(module.rootscope);

    // Detect all symbols used in the scope
    DetectScopeSymbols(module.rootscope);
}

// Update a module with new transient content
export function UpdateModuleFromContent(module : ASModule, content : string)
{
    ClearModule(module);
    module.content = content;
    LoadModule(module);
}

export function UpdateModuleFromDisk(module : ASModule)
{
    ClearModule(module);
    module.content = fs.readFileSync(module.filename, 'utf8');
    LoadModule(module);
}

// Ensure the module is initialized from the loaded content
function LoadModule(module : ASModule)
{
    if (module.loaded)
        return;
    module.loaded = true;
    module.textDocument = TextDocument.create(module.uri, "angelscript", 1, module.content)
}

function ClearModule(module : ASModule)
{
    if (module.parsed)
    {
        // Remove the module globals from the type database
        if (module.global_type)
            typedb.GetDatabase().delete(module.global_type.typename);

        // Remove symbols from old namespaces
        for (let ns of module.namespaces)
            typedb.RemoveModuleFromNamespace(ns.typename, module.modulename);

        // Remove types declared in this file
        for (let type of module.types)
            typedb.GetDatabase().delete(type.typename);
    }

    module.loaded = false;
    module.parsed = false;
    module.symbols = [];
    module.resolved = false;
    module.rootscope = null;
    module.textDocument = null;
    module.content = null;
}

export function GetSymbolLocation(modulename : string, typename : string, symbolname : string) : Location | null
{
    let asmodule = GetModule(modulename);
    if (!asmodule)
        return null;

    if (!typename)
        return _GetScopeSymbol(asmodule, asmodule.rootscope, symbolname);
    if (typename.startsWith("__"))
        typename = typename.substr(2);
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
        if (scopeType.typename == typename)
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
    dbtype.typename = typename;
    dbtype.supertype = null;
    dbtype.properties = new Array<typedb.DBProperty>();
    dbtype.methods = new Array<typedb.DBMethod>();
    dbtype.declaredModule = scope.module.modulename;
    dbtype.documentation = null;
    dbtype.isStruct = false;
    dbtype.isEnum = false;

    if (addToDatabase)
        typedb.GetDatabase().set(dbtype.typename, dbtype);
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
    dbfunc.isEvent = false;
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
        strtype = typename.const_qualifier+" "+typename.value;
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
        strtype = qualifiers_from.const_qualifier+" "+typename;
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

// Add a variable declaration to the scope
function AddVarDeclToScope(scope : ASScope, statement : ASStatement, vardecl : any, in_statement : boolean = false) : ASVariable
{
    // Add it as a local variable
    let asvar = new ASVariable();
    asvar.name = vardecl.name.value;
    asvar.typename = GetQualifiedTypename(vardecl.typename);
    asvar.node_expression = vardecl.expression;
    asvar.node_typename = vardecl.typename;
    asvar.isAuto = vardecl.typename.value == 'auto';
    asvar.in_statement = in_statement;

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
        if (vardecl.access == "private")
            asvar.isPrivate = true;
        else if (vardecl.access == "protected")
            asvar.isProtected = true;
    }

    scope.variables.push(asvar);
    scope.variablesByName.set(asvar.name, asvar);

    // Add it to the type database
    if (scope.dbtype)
    {
        let dbprop = new typedb.DBProperty();
        dbprop.name = asvar.name;
        dbprop.typename = asvar.typename;
        dbprop.documentation = asvar.documentation;
        dbprop.declaredModule = scope.module.modulename;
        dbprop.moduleOffset = asvar.start_offset_name;
        dbprop.isPrivate = asvar.isPrivate;
        dbprop.isProtected = asvar.isProtected;
        scope.dbtype.properties.push(dbprop);
        scope.dbtype.addSymbol(dbprop);
    }

    return asvar;
}

// Extend a scope to include a previous statement
function ExtendScopeToStatement(scope : ASScope, statement : ASStatement)
{
    scope.start_offset = statement.start_offset;
    scope.range.start = statement.range.start;
}

// Create a fake scope to contain variables that are valid in a specif range
function CreateFakeVariableScope(scope : ASScope, statement : ASStatement) : ASScope
{
    let fakescope = new ASScope;
    fakescope.module = scope.module;
    fakescope.parentscope = scope;
    fakescope.start_offset = statement.start_offset;
    fakescope.end_offset = statement.end_offset;
    fakescope.range = statement.range;
    fakescope.parsed = true;

    scope.scopes.push(fakescope);
    return fakescope;
}

function GenerateTypeInformation(scope : ASScope)
{
    if (scope.previous && scope.previous instanceof ASStatement && scope.previous.ast)
    {
        // Class definition in global scope
        if (scope.previous.ast.type == node_types.ClassDefinition)
        {
            let classdef = scope.previous.ast;
            let dbtype = AddDBType(scope, classdef.name.value);
            dbtype.supertype = classdef.superclass ? classdef.superclass.value : "UObject";
            if (classdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(classdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + classdef.name.start;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;
        }
        // Struct definition in global scope
        else if (scope.previous.ast.type == node_types.StructDefinition)
        {
            let structdef = scope.previous.ast;
            let dbtype = AddDBType(scope, structdef.name.value);
            if (structdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(structdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + structdef.name.start;
            dbtype.isStruct = true;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;
        }
        // Namespace definition in global scope
        else if (scope.previous.ast.type == node_types.NamespaceDefinition)
        {
            let nsdef = scope.previous.ast;
            let dbtype = AddDBType(scope, "__"+nsdef.name.value, false);
            if (nsdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(nsdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + nsdef.name.start;

            scope.module.namespaces.push(dbtype);
            scope.dbtype = dbtype;
        }
        // Enum definition in global scope
        else if (scope.previous.ast.type == node_types.EnumDefinition)
        {
            let enumdef = scope.previous.ast;
            let dbtype = AddDBType(scope, "__"+enumdef.name.value);
            if (enumdef.documentation)
                dbtype.documentation = typedb.FormatDocumentationComment(enumdef.documentation);
            dbtype.moduleOffset = scope.previous.start_offset + enumdef.name.start;

            scope.module.types.push(dbtype);
            scope.dbtype = dbtype;
        }
        // Function declaration, either in a class or global
        else if (scope.previous.ast.type == node_types.FunctionDecl)
        {
            let funcdef = scope.previous.ast;
            let dbfunc = AddDBMethod(scope, funcdef.name.value);
            if (funcdef.documentation)
                dbfunc.documentation = typedb.FormatDocumentationComment(funcdef.documentation);
            dbfunc.moduleOffset = scope.previous.start_offset + funcdef.name.start;

            if (funcdef.returntype)
                dbfunc.returnType = GetQualifiedTypename(funcdef.returntype);
            else
                dbfunc.returnType = "void";

            AddParametersToFunction(scope, scope.previous, dbfunc, funcdef.parameters);

            if (funcdef.macro)
            {
                // Mark as event
                if (HasMacroSpecifier(funcdef.macro, "BlueprintEvent") || HasMacroSpecifier(funcdef.macro, "BlueprintOverride"))
                    dbfunc.isEvent = true;
            }

            if (funcdef.access)
            {
                if (funcdef.access == "protected")
                    dbfunc.isProtected = true;
                else if (funcdef.access == "private")
                    dbfunc.isPrivate = true;
            }

            if (funcdef.qualifiers)
            {
                for (let qual of funcdef.qualifiers)
                {
                    if (qual == "property")
                        dbfunc.isProperty = true;
                    else if (qual == "const")
                        dbfunc.isConst = true;
                }
            }

            scope.dbfunc = dbfunc;
            if (scope.parentscope && scope.parentscope.dbtype)
            {
                scope.parentscope.dbtype.methods.push(dbfunc);
                scope.parentscope.dbtype.addSymbol(dbfunc);
            }

            ExtendScopeToStatement(scope, scope.previous);
        }
        // Destructor declaration placed inside a class
        else if (scope.previous.ast.type == node_types.DestructorDecl)
        {
            let destrdef = scope.previous.ast;
            let dbfunc = AddDBMethod(scope, destrdef.name.value);
            dbfunc.moduleOffset = scope.previous.start_offset + destrdef.name.start;
            dbfunc.isConstructor = true;
            scope.dbfunc = dbfunc;
        }
        // We're inside a for loop that may have some declarations in it
        else if (scope.previous.ast.type == node_types.ForLoop)
        {
            let fordef = scope.previous.ast;
            if (fordef.children[0])
            {
                if (fordef.children[0].type == node_types.VariableDecl)
                {
                    AddVarDeclToScope(scope, scope.previous, fordef.children[0], true);
                }
                else if (fordef.children[0].type == node_types.VariableDeclMulti)
                {
                    for (let child of fordef.children[0].children)
                        AddVarDeclToScope(scope, scope.previous, child, true);
                }
            }
        }
        // We're inside a for loop that may have some declarations in it
        else if (scope.previous.ast.type == node_types.ForEachLoop)
        {
            let fordef = scope.previous.ast;

            // Add a local variable for the loop iterator
            let asvar = new ASVariable();
            asvar.name = fordef.children[1].value;
            asvar.typename = GetQualifiedTypename(fordef.children[0]);
            asvar.node_typename = fordef.children[0];
            asvar.node_expression = fordef.children[2];
            asvar.isAuto = fordef.children[0].value == 'auto';
            asvar.isIterator = true;
            asvar.in_statement = true;

            asvar.start_offset_type = scope.previous.start_offset + fordef.children[0].start;
            asvar.end_offset_type = scope.previous.start_offset + fordef.children[0].end;

            asvar.start_offset_name = scope.previous.start_offset + fordef.children[1].start;
            asvar.end_offset_name = scope.previous.start_offset + fordef.children[1].end;

            asvar.start_offset_expression = scope.previous.start_offset + fordef.children[2].start;
            asvar.end_offset_expression = scope.previous.start_offset + fordef.children[2].end;

            scope.variables.push(asvar);
            scope.variablesByName.set(asvar.name, asvar);

            ExtendScopeToStatement(scope, scope.previous);
        }
    }

    // Add variables for each declaration inside the scope
    for (let statement of scope.statements)
    {
        if (!statement.ast)
            continue;

        if (statement.ast.type == node_types.VariableDecl)
        {
            // Add variables for declaration statements
            AddVarDeclToScope(scope, statement, statement.ast);
        }
        else if (statement.ast.type == node_types.VariableDeclMulti)
        {
            // Add variables for multiple declarations in one statement (eg `int X, Y;`)
            for (let child of statement.ast.children)
                AddVarDeclToScope(scope, statement, child);
        }
        else if (statement.ast.type == node_types.ForLoop)
        {
            // Add variables declared inside a for loop to a fake scope covering the for loop's header statement
            let fakescope = CreateFakeVariableScope(scope, statement);
            let for_variables : Array<ASVariable> = [];
            let fordef = statement.ast;
            if (fordef.children[0])
            {
                if (fordef.children[0].type == node_types.VariableDecl)
                {
                    AddVarDeclToScope(fakescope, statement, fordef.children[0], true);
                }
                else if (fordef.children[0].type == node_types.VariableDeclMulti)
                {
                    for (let child of fordef.children[0].children)
                        AddVarDeclToScope(fakescope, statement, child, true);
                }
            }
        }
    }

    // Recurse into subscopes
    for (let subscope of scope.scopes)
        GenerateTypeInformation(subscope);

    // If this was a namespace, merge it after we've generated everything and update the dbtype
    if (scope.scopetype == ASScopeType.Namespace && scope.dbtype)
        scope.dbtype = typedb.MergeNamespaceToDB(scope.dbtype, false);
}

function AddIdentifierSymbol(scope : ASScope, statement : ASStatement, node : any, type : ASSymbolType, container_type : string = null, symbol_name : string = null)
{
    let symbol = new ASSymbol;
    symbol.type = type;
    symbol.start = node.start + statement.start_offset;
    symbol.end = node.end + statement.start_offset;
    symbol.container_type = container_type;
    symbol.symbol_name = symbol_name;

    scope.module.symbols.push(symbol);
}

function AddTypenameSymbol(scope : ASScope, statement : ASStatement, node : any)
{
    if (node.basetype)
    {
        AddIdentifierSymbol(scope, statement, node.basetype, ASSymbolType.TemplateBaseType, null, node.basetype.value);
        for (let child of node.subtypes)
            AddTypenameSymbol(scope, statement, child);
    }
    else
    {
        AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.Typename, null, node.name.value);
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
            asvar.typename = CopyQualifiersToTypename(asvar.node_typename, resolvedType.typename);
    }

    for (let subscope of scope.scopes)
        ResolveAutos(subscope);
}

function ResolveTypeFromExpression(scope : ASScope, node : any) : typedb.DBType
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
            return typedb.GetType("float");
        }
        break;
        // 0.0
        case node_types.ConstDouble:
        {
            return typedb.GetType("double");
        }
        // 0
        case node_types.ConstInteger:
        case node_types.ConstHexInteger:
        {
            return typedb.GetType("int");
        }
        break;
        // "X"
        case node_types.ConstString:
        {
            return typedb.GetType("FString");
        }
        break;
        // n"X"
        case node_types.ConstName:
        {
            return typedb.GetType("FName");
        }
        break;
        // true/false
        case node_types.ConstBool:
        {
            return typedb.GetType("bool");
        }
        // this
        case node_types.ConstThis:
        {
            return scope.getParentType();
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
            if (!node.children[0] || !node.children[1] || !node.children[0].value)
                return null;
            let nsType = typedb.GetType("__"+node.children[0].value);
            if (!nsType)
                return null;
            return ResolvePropertyType(nsType, node.children[1].value);
        }
        break;
        // X()
        case node_types.FunctionCall:
        {
            let left_func = ResolveFunctionFromExpression(scope, node.children[0]);
            if (!left_func)
                return null;
            return typedb.GetType(left_func.returnType);
        }
        break;
        // TType<TSubType>()
        case node_types.ConstructorCall:
            if (!node.children[0] || !node.children[0].value)
                return null;
            return typedb.GetType(node.children[0].value);
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
            return typedb.GetType(node.children[0].value);
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
            if (left_type)
                return left_type;
            let right_type = ResolveTypeFromExpression(scope, node.children[2]);
            if (right_type)
                return right_type;
            return null;
        }
        break;
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
    // Check if we have an iterator method
    let iterator_sym = dbtype.findFirstSymbol("Iterator");
    if (iterator_sym && iterator_sym instanceof typedb.DBMethod)
    {
        // Check the return type of the method
        let return_type = typedb.GetType(iterator_sym.returnType);
        if (!return_type)
            return dbtype;

        // Check the Proceed method of the iterator and take its return value as the type
        let proceed_sym = return_type.findFirstSymbol("Proceed");
        if (proceed_sym && proceed_sym instanceof typedb.DBMethod)
        {
            let proceed_return = typedb.GetType(proceed_sym.returnType);
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
    let usedSymbol = dbtype.findFirstSymbol(name);
    if (usedSymbol && usedSymbol instanceof typedb.DBProperty)
        return typedb.GetType(usedSymbol.typename);

    // Find get accessor
    let getAccessor = dbtype.findFirstSymbol("Get"+name);
    if (getAccessor && getAccessor instanceof typedb.DBMethod)
    {
        if (getAccessor.isProperty)
            return typedb.GetType(getAccessor.returnType);
    }

    // Find set accessor
    let setAccessor = dbtype.findFirstSymbol("Set"+name);
    if (setAccessor && setAccessor instanceof typedb.DBMethod)
    {
        if (setAccessor.isProperty && setAccessor.args.length != 0)
            return typedb.GetType(setAccessor.args[0].typename);
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
            return typedb.GetType(usedVariable.typename);
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
    for (let globalType of scope.getAvailableGlobalTypes())
    {
        let usedType = ResolvePropertyType(globalType, identifier);
        if (usedType)
            return usedType;
    }

    return null;
}

function ResolveTypeFromOperator(scope : ASScope, leftType : typedb.DBType, rightType : typedb.DBType, operator : string) : typedb.DBType
{
    if (!operator)
        return null;

    // Some operators always return bools
    if (operator == "BOOLEAN")
        return typedb.GetType("bool");

    // If both types are primitives we upgrade to the highest
    if (leftType && leftType.isPrimitive && rightType && rightType.isPrimitive)
    {
        if (leftType.typename == "double")
            return leftType;
        if (rightType.typename == "double")
            return rightType;
        if (leftType.typename == "float")
            return leftType;
        if (rightType.typename == "float")
            return rightType;
        return leftType;
    }

    // Try the operator overload for the left side
    if (leftType)
    {
        let sym = leftType.findFirstSymbol(operator);
        if (sym && sym instanceof typedb.DBMethod)
            return typedb.GetType(sym.returnType);
    }

    // Try the operator overload for the right side
    if (rightType)
    {
        let sym_r = rightType.findFirstSymbol(operator+"_r");
        if (sym_r && sym_r instanceof typedb.DBMethod)
            return typedb.GetType(sym_r.returnType);
    }

    return null;
}

function ResolveFunctionFromExpression(scope : ASScope, node : any) : typedb.DBMethod
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
            if (!node.children[0] || !node.children[1] || !node.children[0].value)
                return null;
            let nsType = typedb.GetType("__"+node.children[0].value);
            if (!nsType)
                return null;
            return ResolveFunctionFromType(scope, nsType, node.children[1].value);
        }
        break;
    }
    return null;
}

function ResolveFunctionFromType(scope : ASScope, dbtype : typedb.DBType, name : string, allowUCS = false) : typedb.DBMethod
{
    if (!dbtype || !name)
        return null;

    // Find property with this name
    let usedSymbol = dbtype.findFirstSymbol(name);
    if (usedSymbol && usedSymbol instanceof typedb.DBMethod)
        return usedSymbol;

    if (allowUCS)
    {
        // Check if this is a UCS call in the namespace
        let nsType = scope.getNamespaceParentType();
        if (nsType)
        {
            let usedSymbol = nsType.findFirstSymbol(name);
            if (usedSymbol && usedSymbol instanceof typedb.DBMethod)
            {
                if (usedSymbol.args.length != 0 && typedb.CleanTypeName(usedSymbol.args[0].typename) == dbtype.typename)
                    return usedSymbol;
            }
        }

        // Find a symbol in global scope
        let globalType = scope.module.global_type;
        if (globalType)
        {
            let usedSymbol = globalType.findFirstSymbol(name);
            if (usedSymbol && usedSymbol instanceof typedb.DBMethod)
            {
                if (usedSymbol.args.length != 0 && typedb.CleanTypeName(usedSymbol.args[0].typename) == dbtype.typename)
                    return usedSymbol;
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
    for (let globalType of scope.getAvailableGlobalTypes())
    {
        let usedFunc = ResolveFunctionFromType(scope, globalType, identifier);
        if (usedFunc)
            return usedFunc;
    }

    return null;
}

function DetectScopeSymbols(scope : ASScope)
{
    // Look at each statement to see if it has symbols
    let element = scope.element_head;
    while (element)
    {
        if (element instanceof ASStatement)
        {
            if (element.ast)
                DetectNodeSymbols(scope, element, element.ast);
        }
        else if (element instanceof ASScope)
        {
            DetectScopeSymbols(element);
        }
        element = element.next;
    }
}

function DetectNodeSymbols(scope : ASScope, statement : ASStatement, node : any, allow_errors : boolean = true, symbol_type : typedb.DBAllowSymbol = typedb.DBAllowSymbol.PropertyOnly) : typedb.DBSymbol | typedb.DBType
{
    if (!node)
        return;

    // Add symbols for parameters in function declarations
    switch (node.type)
    {
        // this and other constants
        case node_types.This: return scope.getParentType(); break;
        case node_types.ConstBool: return typedb.GetType("bool"); break;
        case node_types.ConstInteger: return typedb.GetType("int"); break;
        case node_types.ConstHexInteger: return typedb.GetType("int"); break;
        case node_types.ConstFloat: return typedb.GetType("float"); break;
        case node_types.ConstName: return typedb.GetType("FName"); break;
        case node_types.ConstString: return typedb.GetType("FString"); break;
        case node_types.ConstNullptr: return typedb.GetType("UObject"); break;
        // X
        case node_types.Identifier:
        {
            return DetectIdentifierSymbols(scope, statement, node, allow_errors, symbol_type);
        }
        break;
        // X.Y
        case node_types.MemberAccess:
        {
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], allow_errors, typedb.DBAllowSymbol.PropertyOnly);
            if (!left_symbol)
            {
                if (allow_errors)
                    AddIdentifierSymbol(scope, statement, node.children[1], ASSymbolType.UnknownError);
                return null;
            }

            if (node.children[1])
                return DetectSymbolsInType(scope, statement, left_symbol, node.children[1], allow_errors, symbol_type);

            return null;
        }
        break;
        // X::Y
        case node_types.NamespaceAccess:
        {
            if (!node.children[0] || !node.children[0].value)
                return null;

            let nsType = typedb.GetType("__"+node.children[0].value);
            if (!nsType)
            {
                if (allow_errors)
                    AddIdentifierSymbol(scope, statement, node.children[0], ASSymbolType.UnknownError);
                return null;
            }

            AddIdentifierSymbol(scope, statement, node.children[0], ASSymbolType.Namespace, nsType.typename, null);
            if (node.children[1])
                return DetectSymbolsInType(scope, statement, nsType, node.children[1], allow_errors, symbol_type);
            return null;
        }
        break;
        // X()
        case node_types.FunctionCall:
        {
            let left_symbol = DetectNodeSymbols(scope, statement, node.children[0], allow_errors, typedb.DBAllowSymbol.FunctionOnly);

            // Detect symbols in the argument expressions
            DetectNodeSymbols(scope, statement, node.children[1], allow_errors, typedb.DBAllowSymbol.PropertyOnly);

            // Pass through the return type to be used for the next level
            if (left_symbol && left_symbol instanceof typedb.DBMethod)
                return typedb.GetType(left_symbol.returnType);
            else
                return null;
        }
        break;
        case node_types.ArgumentList:
        {
            if (node.children)
            {
                for (let child of node.children)
                    DetectNodeSymbols(scope, statement, child);
            }
        }
        break;
        // void X(...)
        case node_types.FunctionDecl:
        {
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
                        DetectNodeSymbols(scope, statement, param.expression, allow_errors, typedb.DBAllowSymbol.PropertyOnly);
                }
            }
        }
        break;
        // Type X;
        case node_types.VariableDecl:
        {
            // Add the typename of the variable
            if (node.typename)
                AddTypenameSymbol(scope, statement, node.typename);
            // Add the name of the variable
            if (node.name)
                AddIdentifierSymbol(scope, statement, node.name, ASSymbolType.LocalVariable, null, node.name.value);
            // Detect inside the expression that initializes the variable
            if (node.expression)
                DetectNodeSymbols(scope, statement, node.expression, allow_errors, typedb.DBAllowSymbol.PropertyOnly);
        }
        break;
        // Type X, Y;
        case node_types.VariableDeclMulti:
        {
            // Detect in each declaration inside this statement
            for (let child of node.children)
                DetectNodeSymbols(scope, statement, child, allow_errors, typedb.DBAllowSymbol.PropertyOnly);
        }
        break;
    }

    return null;
}

function DetectIdentifierSymbols(scope : ASScope, statement : ASStatement, node : any, allow_errors : boolean, symbol_type : typedb.DBAllowSymbol) : typedb.DBSymbol | typedb.DBType
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
                let symType = usedVariable.isArgument ? ASSymbolType.Parameter : ASSymbolType.LocalVariable;
                AddIdentifierSymbol(scope, statement, node, symType, null, node.value);
                return typedb.GetType(usedVariable.typename);
            }
            checkscope = checkscope.parentscope;
        }
    }

    // Find a symbol in the class we're in
    {
        let insideType = scope.getParentType();
        if (insideType)
        {
            let usedSymbol = insideType.findFirstSymbol(node.value, symbol_type);
            if (usedSymbol)
            {
                let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.MemberVariable : ASSymbolType.MemberFunction;
                AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.containingType, usedSymbol.name);
                return usedSymbol;
            }

            if (typedb.AllowsProperties(symbol_type))
            {
                let getAccessor = insideType.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.FunctionOnly);
                if (getAccessor && getAccessor instanceof typedb.DBMethod)
                {
                    AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, getAccessor.containingType, getAccessor.name);
                    return typedb.GetType(getAccessor.returnType);
                }

                let setAccessor = insideType.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.FunctionOnly);
                if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
                {
                    AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, setAccessor.containingType, setAccessor.name);
                    return typedb.GetType(setAccessor.args[0].typename);
                }
            }
        }
    }

    // Find a symbol in global scope
    for (let globalType of scope.getAvailableGlobalTypes())
    {
        let usedSymbol = globalType.findFirstSymbol(node.value, symbol_type);
        if (usedSymbol)
        {
            let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.GlobalVariable : ASSymbolType.GlobalFunction;
            AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.containingType, usedSymbol.name);
            return usedSymbol;
        }

        if (typedb.AllowsProperties(symbol_type))
        {
            let getAccessor = globalType.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.FunctionOnly);
            if (getAccessor && getAccessor instanceof typedb.DBMethod)
            {
                AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalAccessor, getAccessor.containingType, getAccessor.name);
                return typedb.GetType(getAccessor.returnType);
            }

            let setAccessor = globalType.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.FunctionOnly);
            if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
            {
                AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalAccessor, setAccessor.containingType, setAccessor.name);
                return typedb.GetType(setAccessor.args[0].typename);
            }
        }
    }

    // It could be a type as well
    let symType = typedb.GetType(node.value);
    if (symType)
    {
        AddIdentifierSymbol(scope, statement, node, ASSymbolType.Typename, null, symType.typename);

        // We do not return the symbol here, because we tried to parse a typename as an identifier
        // This should only happen on incomplete statements.
        return null;
    }

    // We could be typing a namespace
    let nsType = typedb.GetType("__"+node.value);
    if (nsType)
    {
        AddIdentifierSymbol(scope, statement, node, ASSymbolType.Namespace, nsType.typename);

        // We do not return the symbol here, because we tried to parse a namespace as an identifier
        // This should only happen on incomplete statements.
        return null;
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (allow_errors)
        AddIdentifierSymbol(scope, statement, node, ASSymbolType.UnknownError);

    return null;
}

function DetectSymbolsInType(scope : ASScope, statement : ASStatement, inSymbol : typedb.DBType | typedb.DBSymbol, node : any, allow_errors : boolean, symbol_type : typedb.DBAllowSymbol) : typedb.DBSymbol | typedb.DBType
{
    if (!inSymbol)
        return null;

    let dbtype : typedb.DBType = null;
    if (inSymbol instanceof typedb.DBType)
        dbtype = inSymbol;
    else if (inSymbol instanceof typedb.DBProperty)
        dbtype = typedb.GetType(inSymbol.typename);

    if (!dbtype)
        return null;

    // Could be a symbol inside the type
    let usedSymbol = dbtype.findFirstSymbol(node.value, symbol_type);
    if (usedSymbol)
    {
        let symType = (usedSymbol instanceof typedb.DBProperty) ? ASSymbolType.MemberVariable : ASSymbolType.MemberFunction;
        AddIdentifierSymbol(scope, statement, node, symType, usedSymbol.containingType, usedSymbol.name);
        return usedSymbol;
    }

    // Could be a property accessor
    if (typedb.AllowsProperties(symbol_type))
    {
        let getAccessor = dbtype.findFirstSymbol("Get"+node.value, typedb.DBAllowSymbol.FunctionOnly);
        if (getAccessor && getAccessor instanceof typedb.DBMethod)
        {
            AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, getAccessor.containingType, getAccessor.name);
            return typedb.GetType(getAccessor.returnType);
        }

        let setAccessor = dbtype.findFirstSymbol("Set"+node.value, typedb.DBAllowSymbol.FunctionOnly);
        if (setAccessor && setAccessor instanceof typedb.DBMethod && setAccessor.isProperty && setAccessor.args.length != 0)
        {
            AddIdentifierSymbol(scope, statement, node, ASSymbolType.MemberAccessor, setAccessor.containingType, setAccessor.name);
            return typedb.GetType(setAccessor.args[0].typename);
        }
    }

    if (typedb.AllowsFunctions(symbol_type))
    {
        // Could be a UCS function in global scope
        for (let globalType of scope.getAvailableGlobalTypes())
        {
            if (globalType)
            {
                let usedSymbol = globalType.findFirstSymbol(node.value, typedb.DBAllowSymbol.FunctionOnly);
                if (usedSymbol && usedSymbol instanceof typedb.DBMethod)
                {
                    if (usedSymbol.args.length != 0 && typedb.CleanTypeName(usedSymbol.args[0].typename) == dbtype.typename)
                    {
                        AddIdentifierSymbol(scope, statement, node, ASSymbolType.GlobalFunction, usedSymbol.containingType, usedSymbol.name);
                        return usedSymbol;
                    }
                }
            }
        }
    }

    // This symbol is entirely unknown, maybe emit an invalid symbol so the user knows
    if (allow_errors)
        AddIdentifierSymbol(scope, statement, node, ASSymbolType.UnknownError);

    return null;
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

    function finishStatement()
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
                statement.range = scope.module.getRange(statement_start, cur_offset);

                scope.statements.push(statement);
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
                in_escape_sequence = true;
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
                in_escape_sequence = true;
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
                finishStatement();
                scope_start = cur_offset;
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
                subscope.range = scope.module.getRange(subscope.start_offset, subscope.end_offset);

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

        // Detect semicolons to delimit statements
        if (curchar == ';' && depth_paren == 0)
            finishStatement();
    }

    finishStatement();

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
        if (scope.parentscope.scopetype == ASScopeType.Function)
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
                scope.scopetype = ASScopeType.Function;
            }
        }
    }
}

function ParseAllStatements(scope : ASScope, debug : boolean = false)
{
    // Determine what the type of this scope is based on the previous statement
    DetermineScopeType(scope);

    // Statements we detected should be parsed
    for (let statement of scope.statements)
        ParseStatement(scope.scopetype, statement, debug);

    // Also parse any subscopes we detected
    for (let subscope of scope.scopes)
        ParseAllStatements(subscope, debug)
}

function DisambiguateStatement(ast : any) : any
{
    // We always prefer a function declaration parse over a variable declaration one.
    // This can happen in class bodies because "FVector Test()" can be either a function or a variable with a constructor.
    if (ast[0].type == node_types.VariableDecl && ast[1].type == node_types.FunctionDecl)
        return ast[1];
    if (ast[1].type == node_types.VariableDecl && ast[0].type == node_types.FunctionDecl)
        return ast[0];

    // We prefer a variable declaration parse over a binary operation parse
    // This can happen when declaring variables of template types
    // eg "TArray<int> A" can be parsed as "(TArray < int) > A"
    if (ast[0].type == node_types.VariableDecl && ast[1].type == node_types.BinaryOperation)
        return ast[0];
    if (ast[1].type == node_types.VariableDecl && ast[0].type == node_types.BinaryOperation)
        return ast[1];

    return null;
}

function ParseStatement(scopetype : ASScopeType, statement : ASStatement, debug : boolean = false)
{
    statement.parsed = true;
    statement.ast = null;

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
        case ASScopeType.Code:
            parser = parser_statement;
            parser.restore(parser_statement_initial);
        break
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
            throw "ParseError";
        }

        parseError = true;
    }

    if (!parseError)
    {
        if (parser.results.length == 0)
        {
            statement.ast = null;
        }
        else if (parser.results.length == 1)
        {
            // Unambiguous, take the first one
            statement.ast = parser.results[0];
        }
        else
        {
            // We have some simple disambiguation rules to apply first
            statement.ast = DisambiguateStatement(parser.results);

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

