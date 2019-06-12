import { TextDocument, Position, Location, Range } from 'vscode-languageserver';
import * as typedb from './database';
import { create } from 'domain';
import { type } from 'os';

export class ASFile
{
    pathname : string;
    modulename : string;
    rootscope : ASScope;
    document : TextDocument;

    GetScopeAt(offset : number) : ASScope
    {
        return this.rootscope.GetScopeAt(offset);
    }

    GetLocation(offset : number) : Location
    {
        return <Location> {
            uri: this.pathname,
            range: <Range> {
                start: CreatePosition(this.pathname, offset),
                end: CreatePosition(this.pathname, offset),
            },
        };
    }

    GetLocationRange(startOffset : number, endOffset : number) : Location
    {
        return <Location> {
            uri: this.pathname,
            range: <Range> {
                start: CreatePosition(this.pathname, startOffset),
                end: CreatePosition(this.pathname, endOffset),
            },
        };
    }
};

export enum ASScopeType
{
    Global,
    Class,
    Function,
    Enum,
    Other,
    Namespace
};

export class ASVariable
{
    name : string;
    typename : string;
    isArgument : boolean;
    posInParent : number;
    posInFile : number;
    expression : string;
};

export class ASScope
{
    scopetype : ASScopeType;
    declaration : string;

    typename : string;
    supertype : string;
    modulename : string;
    isStruct : boolean;

    funcname : string;
    funcreturn : string;
    funcargs : string;

    parentscope : ASScope;
    subscopes : Array<ASScope>;
    variables : Array<ASVariable>;

    startPosInParent : number;
    endPosInParent : number;

    startPosInFile : number;
    endPosInFile : number;

    content : string;
    unscopedContent : Array<string>;
    unscopedOffsets : Array<number>;
    imports : Array<string>;

    constructor()
    {
        this.scopetype = ASScopeType.Other;
        this.subscopes = new Array<ASScope>();
        this.variables = new Array<ASVariable>();
        this.content = "";
        this.unscopedContent = new Array<string>();
        this.unscopedOffsets = new Array<number>();
    }

    GetScopeAt(offset : number) : ASScope
    {
        for(let subscope of this.subscopes)
        {
            if(offset >= subscope.startPosInParent && offset < subscope.endPosInParent)
            {
                return subscope.GetScopeAt(offset - subscope.startPosInParent);
            }
        }

        return this;
    }

    findScopeType(typename : string) : ASScope
    {
        if(typename.startsWith("__"))
            typename = typename.substr(2);
        if(this.typename == typename)
            return this;
        for(let subscope of this.subscopes)
        {
            let found = subscope.findScopeType(typename);
            if(found)
                return found;
        }
        return null;
    }

    getDBTypename() : string | null
    {
        if (this.scopetype != ASScopeType.Class
         && this.scopetype != ASScopeType.Global
         && this.scopetype != ASScopeType.Namespace
         && this.scopetype != ASScopeType.Enum)
            return null;

        return this.typename;
    }

    toDBType() : typedb.DBType | null
    {
        if (this.scopetype != ASScopeType.Class
         && this.scopetype != ASScopeType.Global
         && this.scopetype != ASScopeType.Namespace
         && this.scopetype != ASScopeType.Enum)
            return null;

        let dbtype = new typedb.DBType();
        dbtype.typename = this.typename;
        dbtype.supertype = this.supertype;
        dbtype.properties = new Array<typedb.DBProperty>();
        dbtype.methods = new Array<typedb.DBMethod>();
        dbtype.declaredModule = this.modulename;

        if (this.scopetype == ASScopeType.Enum || this.scopetype == ASScopeType.Namespace)
            dbtype.typename = "__" + dbtype.typename;

        for (let prop of this.variables)
        {
            let dbprop = new typedb.DBProperty();
            dbprop.name = prop.name;
            dbprop.typename = prop.typename;
            dbtype.properties.push(dbprop);
        }

        for (let subscope of this.subscopes)
        {
            let dbfunc = subscope.toDBFunc();
            if (dbfunc)
            {
                dbtype.methods.push(dbfunc);
            }

            if (subscope.scopetype == ASScopeType.Class)
            {
                // Generate a 'constructor' function for the class for auto resolving
                let ctor = new typedb.DBMethod();
                ctor.name = subscope.typename;
                ctor.returnType = subscope.typename;
                ctor.declaredModule = subscope.modulename;
                ctor.args = new Array<typedb.DBArg>();
                dbtype.methods.push(ctor);
            }
        }

        if (this.imports)
        {
            dbtype.siblingTypes = new Array<string>();
            for (let importName of this.imports)
            {
                dbtype.siblingTypes.push("//"+importName);
            }
        }

        return dbtype;
    }

    toDBFunc() : typedb.DBMethod | null
    {
        if (this.scopetype != ASScopeType.Function)
            return null;

        let dbfunc = new typedb.DBMethod();
        dbfunc.name = this.funcname;
        dbfunc.returnType = this.funcreturn;
        dbfunc.argumentStr = this.funcargs;
        dbfunc.declaredModule = this.modulename;

        dbfunc.args = new Array<typedb.DBArg>();
        for (let funcVar of this.variables)
        {
            if (!funcVar.isArgument)
                continue;
            
            let arg = new typedb.DBArg();
            arg.name = funcVar.name;
            arg.typename = funcVar.typename;
            dbfunc.args.push(arg);
        }
        
        return dbfunc;
    }
};

function SplitScopes(root : ASScope)
{
    let scopes = 0;
    let activeScope : ASScope = null;
    let rootPos = 0;

    for (let pos = 0; pos < root.content.length; ++pos)
    {
        switch (root.content[pos])
        {
            case '{':
                if (scopes == 0)
                {
                    if (pos-1 > rootPos)
                    {
                        root.unscopedContent.push(root.content.substring(rootPos, pos));
                        root.unscopedOffsets.push(rootPos);
                    }
                    activeScope = new ASScope();
                    activeScope.startPosInParent = pos;
                    activeScope.startPosInFile = pos + root.startPosInFile;
                    activeScope.parentscope = root;
                    activeScope.modulename = root.modulename;

                    // Find the 'line' above the scope, its declaration.
                    let declPos = pos-1;
                    if (declPos < 0)
                    {
                        declPos = 0;
                    }
                    else while(declPos > 0)
                    {
                        if (root.content[declPos] == '{' || root.content[declPos] == ';' || root.content[declPos] == '}')
                        {
                            declPos += 1;
                            break;
                        }
                        declPos -= 1;
                    }

                    activeScope.declaration = root.content.substring(declPos, pos);
                    root.subscopes.push(activeScope);
                }
                scopes += 1;
            break;
            case '}':
                scopes -= 1;
                if(scopes == 0)
                {
                    activeScope.endPosInParent = pos;
                    activeScope.endPosInFile = pos + root.startPosInFile;
                    activeScope.content = root.content.substring(activeScope.startPosInParent+1, pos);
                    SplitScopes(activeScope);
                    activeScope = null;
                    rootPos = pos+1;
                }
            break;
        }
    }

    if (rootPos < root.content.length && scopes == 0)
    {
        root.unscopedContent.push(root.content.substring(rootPos, root.content.length));
        root.unscopedOffsets.push(rootPos);
    }
}

let re_enumvalue = /([A-Za-z0-9_]+)\s*(=\s*[\-x0-9]+)?(\/\/.*\n)?(\/\*.*\*\/)?(,|$)/g;
function ParseEnumValues(root : ASScope)
{
    re_enumvalue.lastIndex = 0;
    while(true)
    {
        let match = re_enumvalue.exec(root.content);
        if (match == null)
            break;

        let decl = new ASVariable();
        decl.typename = root.typename;
        decl.name = match[1];
        decl.isArgument = false;
        decl.posInParent = match.index;
        decl.posInFile = decl.posInParent + root.startPosInFile;

        root.variables.push(decl);
    }
}

let re_declaration = /((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,[\t ]*[A-Za-z0-9_]+)*\>)?)[\t ]*&?)[\t ]+([A-Za-z_0-9]+)(;|\s*\(.*\)\s*;|\s*=.*;)/g;
let re_classheader = /(class|struct|namespace)\s+([A-Za-z0-9_]+)(\s*:\s*([A-Za-z0-9_]+))?\s*$/g;
let re_functionheader = /((const[ \t]+)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)[ \t]*&?)[\t ]+([A-Za-z0-9_]+)\((.*)\)/g;
let re_argument = /(,\s*|\(\s*|^\s*)((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)\s*&?(\s*(in|out|inout))?)\s+([A-Za-z_0-9]+)/g;
let re_enum = /enum\s*([A-Za-z0-9_]+)\s*$/g;
let re_import = /(\n|^)\s*import\s+([A-Za-z0-9_.]+)\s*;/g;
let re_for_declaration = /for\s*\(((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,[\t ]*[A-Za-z0-9_]+)*\>)?)[\t ]*&?)[\t ]+([A-Za-z_0-9]+)\s*:\s*([^\n]*)\)/g;

function ParseDeclarations(root : ASScope)
{
    re_classheader.lastIndex = 0;
    let classmatch = re_classheader.exec(root.declaration);
    if (classmatch)
    {
        root.typename = classmatch[2];
        root.supertype = classmatch[4];
        root.scopetype = ASScopeType.Class;
        root.isStruct = classmatch[1] == "struct";

        if (classmatch[1] == "namespace")
            root.scopetype = ASScopeType.Namespace;
    }
    else
    {
        re_functionheader.lastIndex = 0;
        let funcmatch = re_functionheader.exec(root.declaration);
        if (funcmatch)
        {
            root.scopetype = ASScopeType.Function;
            root.funcname = funcmatch[6];
            root.funcreturn = funcmatch[1];
            root.funcargs = funcmatch[7];

            re_argument.lastIndex = 0;
            while(true)
            {
                let match = re_argument.exec(root.funcargs);
                if (match == null)
                    break;

                let decl = new ASVariable();
                decl.typename = match[2];
                decl.name = match[9];
                decl.isArgument = true;
                decl.posInParent = 0;
                decl.posInFile = root.startPosInFile;

                root.variables.push(decl);
            }
        }
        else
        {
            re_enum.lastIndex = 0;
            let enummatch = re_enum.exec(root.declaration);
            if (enummatch)
            {
                root.scopetype = ASScopeType.Enum;
                root.typename = enummatch[1];
                
                ParseEnumValues(root);
            }
        }
    }

    for(let contentIndex = 0; contentIndex < root.unscopedContent.length; ++contentIndex)
    {
        let content = root.unscopedContent[contentIndex];
        let offset = root.unscopedOffsets[contentIndex];
        re_declaration.lastIndex = 0;
        while(true)
        {
            let match = re_declaration.exec(content);
            if (match == null)
                break;
            if(match[1] == 'return')
                continue;

            let decl = new ASVariable();
            decl.typename = match[1];
            decl.name = match[6];
            decl.isArgument = false;
            decl.posInParent = match.index + offset;
            decl.posInFile = root.startPosInFile + decl.posInParent;

            decl.expression = match[7].trim();
            if(decl.expression.startsWith("="))
                decl.expression = decl.expression.substr(1);
            if(decl.expression.endsWith(";"))
                decl.expression = decl.expression.substr(0, decl.expression.length-1);
            decl.expression = decl.expression.trim();

            root.variables.push(decl);
        }

        re_for_declaration.lastIndex = 0;
        while(true)
        {
            let match = re_for_declaration.exec(content);
            if (match == null)
                break;

            let decl = new ASVariable();
            decl.typename = match[1];
            decl.name = match[6];
            decl.isArgument = false;
            decl.posInParent = match.index + offset;
            decl.posInFile = root.startPosInFile + decl.posInParent;
            decl.expression = match[7].trim() + "[0]";

            root.variables.push(decl);
        }

        re_import.lastIndex = 0;
        while(true)
        {
            let match = re_import.exec(content);
            if (match == null)
                break;

            if (!root.imports)
                root.imports = new Array<string>();
            root.imports.push(match[2]);
        }
    }

    for(let subscope of root.subscopes)
        ParseDeclarations(subscope);

    let dbtype = root.toDBType();
    if (dbtype)
        typedb.GetDatabase().set(dbtype.typename, dbtype);
}

export function RemoveScopeFromDatabase(scope : ASScope)
{
    let typename = scope.getDBTypename();
    if(typename != null)
    {
        typedb.GetDatabase().delete(typename);
    }

    for(let subscope of scope.subscopes)
        RemoveScopeFromDatabase(subscope);
}

let loadedFiles = new Map<string,ASFile>();
let filesByModuleName = new Map<string,ASFile>();
export function GetFile(pathname : string) : ASFile | null
{
    return loadedFiles.get(decodeURIComponent(pathname));
}

export function GetFileByModuleName(modulename : string) : ASFile | null
{
    return filesByModuleName.get(modulename);
}

export function UpdateContent(pathname : string, modulename : string, content : string, document? : TextDocument) : ASFile
{
    pathname = decodeURIComponent(pathname);

    let previousFile = loadedFiles.get(pathname);
    if (previousFile != null)
    {
        RemoveScopeFromDatabase(previousFile.rootscope);
    }

    let file = new ASFile();
    file.modulename = modulename;
    file.pathname = pathname;
    file.rootscope = new ASScope();
    file.rootscope.typename = "//"+file.modulename;
    file.rootscope.modulename = file.modulename;
    file.rootscope.content = content;
    file.rootscope.startPosInFile = 0;
    file.rootscope.endPosInFile = content.length;
    file.rootscope.parentscope = null;
    file.rootscope.scopetype = ASScopeType.Global;
    if (document)
        file.document = document;
    else
        file.document = TextDocument.create(pathname, "angelscript", 1, content);
    SplitScopes(file.rootscope);
    ParseDeclarations(file.rootscope);

    loadedFiles.set(pathname, file);
    filesByModuleName.set(modulename, file);
    return file;
}

export function GetDocument(pathname : string) : TextDocument | null
{
    let file = GetFile(pathname);
    if(!file)
        return null;
    return file.document;
}

export function CreatePosition(pathname : string, offset : number) : Position
{
    let doc = GetDocument(pathname);
    if(doc == null)
        return <Position> {line: 0, character: 0};

    return doc.positionAt(offset);
}

export function ResolvePosition(pathname : string, pos : Position) : number
{
    let doc = GetDocument(pathname);
    if(doc == null)
        return -1;

    return doc.offsetAt(pos);
}

export function GetAllFiles() : Array<ASFile>
{
    let files = new Array<ASFile>();
    for ( let doc of loadedFiles )
    {
        files.push(doc[1]);
    }
    return files;
}

export function GetSymbolLocation(modulename : string, typename : string, symbolname : string) : Location | null
{
    let file = GetFileByModuleName(modulename);
    if (!file)
        return null;

    let subscope = typename != null ? file.rootscope.findScopeType(typename) : file.rootscope;
    if(!subscope)
        return null;

    return _GetScopeSymbol(file, subscope, symbolname);
}

export function GetSymbolLocationInScope(scope : ASScope, symbolname : string) : Location | null
{
    let file = GetFileByModuleName(scope.modulename);
    let checkScope = scope;
    while(checkScope)
    {
        let sym = _GetScopeSymbol(file, checkScope, symbolname);
        if (sym)
            return sym;
        checkScope = checkScope.parentscope;
    }
    return null;
}

function _GetScopeSymbol(file : ASFile, scope : ASScope, symbolname : string) : Location | null
{
    // Find variables
    for (let scopevar of scope.variables)
    {
        if (!scopevar.posInFile)
            continue;
        if (scopevar.name != symbolname)
            continue;
        return file.GetLocation(scopevar.posInFile);
    }

    // Find functions
    for (let innerscope of scope.subscopes)
    {
        if(innerscope.scopetype != ASScopeType.Function)
            continue;
        if (innerscope.funcname != symbolname)
            continue;
        return file.GetLocation(innerscope.startPosInFile);
    }

    // Find property accessors
    for (let innerscope of scope.subscopes)
    {
        if(innerscope.scopetype != ASScopeType.Function)
            continue;
        if (innerscope.funcname != "Get"+symbolname && innerscope.funcname != "Set"+symbolname)
            continue;
        return file.GetLocation(innerscope.startPosInFile);
    }

    return null;
}

export function GetTypeSymbolLocation(modulename : string, typename : string) : Location | null
{
    let file = GetFileByModuleName(modulename);
    if (!file)
        return null;

    let subscope = file.rootscope.findScopeType(typename);
    if(!subscope)
        return null;

    return file.GetLocation(subscope.startPosInFile);
}

function PostProcessScope(scope : ASScope)
{
    if (scope.scopetype == ASScopeType.Class && !scope.isStruct)
    {
        let dbtype = new typedb.DBType();
        dbtype.initEmpty("__"+scope.typename);

        {
            let method = new typedb.DBMethod();
            method.name = "StaticClass";
            method.returnType = "UClass";
            method.documentation = "Gets the descriptor for the class generated for the specified type.";
            method.args = [];
            dbtype.methods.push(method);
        }

        let basetype = typedb.GetType(scope.typename);
        if(basetype && basetype.inheritsFrom("UActorComponent"))
        {
            {
                let method = new typedb.DBMethod();
                method.name = "Get";
                method.returnType = scope.typename;
                method.documentation = "Get the component of this type from an actor. Specified name is optional.";
                method.args = [
                    new typedb.DBArg().init("AActor", "Actor"),
                    new typedb.DBArg().init("FName", "WithName", "NAME_None"),
                ];
                dbtype.methods.push(method);
            }

            {
                let method = new typedb.DBMethod();
                method.name = "GetAll";
                method.returnType = "void";
                method.documentation = "Get all components of a particular type on an actor.";
                method.args = [
                    new typedb.DBArg().init("AActor", "Actor"),
                    new typedb.DBArg().init("TArray<"+scope.typename+">&", "OutComponents"),
                ];
                dbtype.methods.push(method);
            }

            {
                let method = new typedb.DBMethod();
                method.name = "GetOrCreate";
                method.returnType = scope.typename;
                method.documentation = "Get a component of a particular type on an actor, create it if it doesn't exist. Specified name is optional.";
                method.args = [
                    new typedb.DBArg().init("AActor", "Actor"),
                    new typedb.DBArg().init("FName", "WithName", "NAME_None"),
                ];
                dbtype.methods.push(method);
            }

            {
                let method = new typedb.DBMethod();
                method.name = "Create";
                method.returnType = scope.typename;
                method.documentation = "Always create a new component of this type on an actor.";
                method.args = [
                    new typedb.DBArg().init("AActor", "Actor"),
                    new typedb.DBArg().init("FName", "WithName", "NAME_None"),
                ];
                dbtype.methods.push(method);
            }
        }

        if(basetype && basetype.inheritsFrom("AActor"))
        {
            {
                let method = new typedb.DBMethod();
                method.name = "GetAll";
                method.returnType = "void";
                method.documentation = "Get all actors of this type that are currently in the world.";
                method.args = [
                    new typedb.DBArg().init("TArray<"+scope.typename+">&", "OutActors"),
                ];
                dbtype.methods.push(method);
            }

            {
                let method = new typedb.DBMethod();
                method.name = "Spawn";
                method.returnType = scope.typename;
                method.documentation = "Spawn a new actor of this type into the world.";
                method.args = [
                    new typedb.DBArg().init("FVector", "Location", "FVector::ZeroVector"),
                    new typedb.DBArg().init("FRotator", "Rotation", "FRotator::ZeroRotator"),
                    new typedb.DBArg().init("FName", "Name", "NAME_None"),
                ];
                dbtype.methods.push(method);
            }
        }

        typedb.database.set(dbtype.typename, dbtype);
    }

    for (let subscope of scope.subscopes)
        PostProcessScope(subscope);
}

export function PostProcessModule(modulename : string)
{
    let file = GetFileByModuleName(modulename);
    if (!file)
        return;

    PostProcessScope(file.rootscope);
}