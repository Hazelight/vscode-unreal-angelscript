import { TextDocument, Position, Location, Range, DocumentSymbol } from 'vscode-languageserver';
import * as typedb from './database';
import { create } from 'domain';
import { type } from 'os';
import { createDecipher } from 'crypto';

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
    documentation : string;
    isArgument : boolean;
    posInParent : number;
    posInFile : number;
    expression : string;
    isPrivate : boolean;
    isProtected : boolean;
};

export class ASDelegate
{
    name : string;
    returnValue : string;
    arglist : string;
    posInParent : number;
    posInFile : number;
    isMulticast : boolean;
    args : Array<ASVariable>;
};

export class ASScope
{
    scopetype : ASScopeType;
    declaration : string;

    typename : string;
    supertype : string;
    modulename : string;
    isStruct : boolean;
    documentation : string;

    funcname : string;
    funcreturn : string;
    funcargs : string;
    funcprivate : boolean;
    funcprotected : boolean;
    isConstructor : boolean = false;
    isConst : boolean = false;

    parentscope : ASScope;
    subscopes : Array<ASScope>;
    variables : Array<ASVariable>;
    delegates : Array<ASDelegate>;

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

    remove_variable(name : string)
    {
        for (let i = 0; i < this.variables.length; ++i)
        {
            if (this.variables[i].name == name)
            {
                this.variables.splice(i, 1);
                break;
            }
        }
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

    getTypeScopeIsIn()  : string | null
    {
        let checktype : ASScope = this;
        while (checktype)
        {
            if (checktype.scopetype == ASScopeType.Class)
            {
                return checktype.typename;
            }
            checktype = checktype.parentscope;
        }
        return null;
    }

    getSuperTypeForScope()  : string | null
    {
        let checktype : ASScope = this;
        while (checktype)
        {
            if (checktype.scopetype == ASScopeType.Class)
            {
                return checktype.supertype;
            }
            checktype = checktype.parentscope;
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
        dbtype.documentation = this.documentation;
        dbtype.isStruct = this.isStruct;
        dbtype.isEnum = this.scopetype == ASScopeType.Enum;;

        if (this.scopetype == ASScopeType.Enum || this.scopetype == ASScopeType.Namespace)
            dbtype.typename = "__" + dbtype.typename;

        for (let prop of this.variables)
        {
            let dbprop = new typedb.DBProperty();
            dbprop.name = prop.name;
            dbprop.typename = prop.typename;
            dbprop.documentation = prop.documentation;
            dbprop.isPrivate = prop.isPrivate;
            dbprop.isProtected = prop.isProtected;
            dbtype.properties.push(dbprop);
        }

        for (let subscope of this.subscopes)
        {
            let dbfunc = subscope.toDBFunc();
            if (dbfunc)
            {
                if (!subscope.isConstructor)
                    dbtype.methods.push(dbfunc);
            }

            if (subscope.scopetype == ASScopeType.Class)
            {
                // Add all constructors from the class to the global scope
                let foundConstructor = false;
                for (let funcscope of subscope.subscopes)
                {
                    if (funcscope.isConstructor)
                    {
                        let ctor = funcscope.toDBFunc();
                        if (ctor)
                        {
                            dbtype.methods.push(ctor);
                            foundConstructor = true;
                        }
                    }
                }

                // Generate a default constructor function for the class for auto resolving
                if (!foundConstructor && subscope.isStruct)
                {
                    let ctor = new typedb.DBMethod();
                    ctor.isConstructor = true;
                    ctor.name = subscope.typename;
                    ctor.returnType = subscope.typename;
                    ctor.declaredModule = subscope.modulename;
                    ctor.args = new Array<typedb.DBArg>();
                    dbtype.methods.push(ctor);
                }
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
        dbfunc.argumentStr = RemoveSpacing(this.funcargs);
        dbfunc.declaredModule = this.modulename;
        dbfunc.documentation = this.documentation;
        dbfunc.isPrivate = this.funcprivate;
        dbfunc.isProtected = this.funcprotected;
        dbfunc.isConstructor = this.isConstructor;
        dbfunc.isConst = this.isConst;

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

    hasPrivateAccessTo(typename : string) : boolean
    {
        let checkScope : ASScope = this;
        while (checkScope)
        {
            if (checkScope.scopetype == ASScopeType.Class)
            {
                if (checkScope.typename == typename)
                    return true;
            }
            checkScope = checkScope.parentscope;
        }
        return false;
    }

    hasProtectedAccessTo(typename : string) : boolean
    {
        let checkScope : ASScope = this;
        while (checkScope)
        {
            if (checkScope.scopetype == ASScopeType.Class)
            {
                if (checkScope.typename == typename)
                    return true;

                let dbtype = typedb.GetType(checkScope.typename);
                if (dbtype.inheritsFrom(typename))
                    return true;
            }
            checkScope = checkScope.parentscope;
        }
        return false;
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
        decl.typename = root.typename.trim();
        decl.name = match[1];
        decl.isArgument = false;
        decl.posInParent = match.index;
        decl.posInFile = decl.posInParent + root.startPosInFile;
        decl.documentation = ExtractCommentOnPreviousLine(root.content, match.index);

        root.variables.push(decl);
    }
}

let re_declaration = /(private\s+|protected\s+)?((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,[\t ]*[A-Za-z0-9_]+)*\>)?)[\t ]*&?)[\t ]+([A-Za-z_0-9]+)(\s*;|\s*\(.*\)\s*;|\s*=.*;)/g;
let re_classheader = /(class|struct|namespace)\s+([A-Za-z0-9_]+)(\s*:\s*([A-Za-z0-9_]+))?\s*$/g;
let re_functionheader = /(private\s+|protected\s+)?((const[ \t]+)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)[ \t]*&?)[\t ]+([A-Za-z0-9_]+)\(((.|\n|\r)*)\)(\s*const)?/g;
let re_constructor = /[\t ]*([A-Za-z0-9_]+)\(((.|\n|\r)*)\)/g;
let re_argument = /(,\s*|\(\s*|^\s*)((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)\s*&?(\s*(in|out|inout))?)\s+([A-Za-z_0-9]+)/g;
let re_enum = /enum\s*([A-Za-z0-9_]+)\s*$/g;
let re_import = /(\n|^)\s*import\s+([A-Za-z0-9_.]+)\s*;/g;
let re_for_declaration = /for\s*\(((const\s*)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,[\t ]*[A-Za-z0-9_]+)*\>)?)[\t ]*&?)[\t ]+([A-Za-z_0-9]+)\s*:\s*([^\n]*)\)/g;
let re_delegate = /(delegate|event)[ \t]+((const[ \t]+)?([A-Za-z_0-9]+(\<[A-Za-z0-9_]+(,\s*[A-Za-z0-9_]+)*\>)?)[ \t]*&?)[\t ]+([A-Za-z0-9_]+)\((.*)\);/g;

function ParseDeclarations(root : ASScope)
{
    let cleanedDeclaration = root.declaration ? RemoveComments(root.declaration) : null;

    re_classheader.lastIndex = 0;
    let classmatch = re_classheader.exec(cleanedDeclaration);
    if (classmatch)
    {
        root.typename = classmatch[2];
        root.supertype = classmatch[4];
        root.scopetype = ASScopeType.Class;
        root.isStruct = classmatch[1] == "struct";
        root.documentation = ExtractDocumentationBackwards(root.declaration, root.declaration.length-1);

        if (classmatch[1] == "namespace")
            root.scopetype = ASScopeType.Namespace;
    }
    else
    {
        re_functionheader.lastIndex = 0;
        let funcmatch = re_functionheader.exec(cleanedDeclaration);
        if (funcmatch)
        {
            root.scopetype = ASScopeType.Function;
            root.funcname = funcmatch[7];
            root.funcreturn = funcmatch[2];
            root.funcargs = funcmatch[8];
            root.funcprivate = funcmatch[1] && funcmatch[1].startsWith("private");
            root.funcprotected = funcmatch[1] && funcmatch[1].startsWith("protected");
            root.documentation = ExtractDocumentationBackwards(root.declaration, root.declaration.length-1);
            if (funcmatch[10])
                root.isConst = true;

            re_argument.lastIndex = 0;
            while(true)
            {
                let match = re_argument.exec(root.funcargs);
                if (match == null)
                    break;

                let decl = new ASVariable();
                decl.typename = match[2].trim();
                decl.name = match[9];
                decl.isArgument = true;
                decl.posInParent = 0;
                decl.posInFile = root.startPosInFile;

                root.variables.push(decl);
            }
        }
        else
        {
            re_constructor.lastIndex = 0;
            let constructormatch = re_constructor.exec(cleanedDeclaration);

            if (constructormatch && constructormatch[1] == root.parentscope.typename)
            {
                root.scopetype = ASScopeType.Function;
                root.funcname = constructormatch[1];
                root.funcreturn = constructormatch[1];
                root.funcargs = constructormatch[2];
                root.funcprivate = false;
                root.funcprotected = false;
                root.isConstructor = true;
                root.documentation = ExtractDocumentationBackwards(root.declaration, root.declaration.length-1);

                re_argument.lastIndex = 0;
                while(true)
                {
                    let match = re_argument.exec(root.funcargs);
                    if (match == null)
                        break;

                    let decl = new ASVariable();
                    decl.typename = match[2].trim();
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
                let enummatch = re_enum.exec(cleanedDeclaration);
                if (enummatch)
                {
                    root.scopetype = ASScopeType.Enum;
                    root.typename = enummatch[1];
                    root.documentation = ExtractDocumentationBackwards(root.declaration, root.declaration.length-1);
                    
                    ParseEnumValues(root);
                }
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
            if(match[2] == 'return')
                continue;
            if(match[2] == 'default')
                continue;

            let decl = new ASVariable();
            decl.typename = match[2].trim();
            decl.name = match[7];
            decl.isArgument = false;
            decl.posInParent = match.index + offset;
            decl.posInFile = root.startPosInFile + decl.posInParent;
            decl.isPrivate = match[1] && match[1].startsWith("private");
            decl.isProtected = match[1] && match[1].startsWith("protected");

            if (root.scopetype == ASScopeType.Class)
                decl.documentation = ExtractDocumentationBackwards(content, match.index);

            decl.expression = match[8].trim();
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
            decl.typename = match[1].trim();
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

        if (root.scopetype == ASScopeType.Global)
        {
            re_delegate.lastIndex = 0;
            while(true)
            {
                let match = re_delegate.exec(content);
                if (match == null)
                    break;

                let decl = new ASDelegate();
                decl.name = match[7];
                decl.arglist = match[8];
                decl.returnValue = match[2].trim();
                decl.posInParent = match.index + offset;
                decl.posInFile = root.startPosInFile + decl.posInParent;
                decl.isMulticast = match[1] == "event";
                decl.args = new Array<ASVariable>();

                root.remove_variable(decl.name);

                re_argument.lastIndex = 0;
                while(true)
                {
                    let match = re_argument.exec(decl.arglist);
                    if (match == null)
                        break;

                    let arg = new ASVariable();
                    arg.typename = match[2].trim();
                    arg.name = match[9];
                    arg.isArgument = true;
                    arg.posInParent = decl.posInParent;
                    arg.posInFile = decl.posInFile;

                    decl.args.push(arg);
                }

                if (!root.delegates)
                    root.delegates = new Array<ASDelegate>();
                root.delegates.push(decl);
            }
        }
    }

    for(let subscope of root.subscopes)
        ParseDeclarations(subscope);

    let dbtype = root.toDBType();
    if (dbtype)
    {
        typedb.GetDatabase().set(dbtype.typename, dbtype);
    }

    if (root.delegates)
    {
        for (let delegate of root.delegates)
        {
            dbtype = MakeDelegateDBType(root, delegate);
            typedb.GetDatabase().set(delegate.name, dbtype);
        }
    }
}

let re_comment_oneline = /\/\/.*?\n/gi;
let re_comment_multiline = /\/\*(.|\n|\r)*?\*\//gi;
let re_spacing = /[\r\n\t]+/gi;

function RemoveComments(code : string) : string
{
    code = code.replace(re_comment_multiline, "");
    code = code.replace(re_comment_oneline, "");
    return code;
}

function RemoveSpacing(code : string) : string
{
    code = code.replace(re_spacing, " ");
    return code;
}

function ExtractDocumentationBackwards(code : string, position : number, minPosition : number = 0) : string
{
    while (position >= minPosition)
    {
        if (code[position] == '/')
        {
            if (position+1 < code.length)
            {
                if (code[position+1] == '/')
                {
                    let endIndex = code.indexOf("\n", position);
                    if (endIndex == -1)
                        return typedb.FormatDocumentationComment(code.substr(position+2));
                    else
                        return typedb.FormatDocumentationComment(code.substring(position+2, endIndex));
                }
                else if (code[position+1] == '*')
                {
                    let endIndex = code.indexOf("*/", position);
                    if (endIndex == -1)
                        return typedb.FormatDocumentationComment(code.substr(position+2));
                    else
                        return typedb.FormatDocumentationComment(code.substring(position+2, endIndex));
                }
            }
        }
        else if (code[position] == ';' || code[position] == '}')
        {
            break;
        }
        position -= 1;
    }

    return "";
}

function ExtractCommentOnPreviousLine(code : string, position : number, minPosition : number = 0) : string
{
    let prevLine : boolean = false;
    while (position >= minPosition)
    {
        if (code[position] == '\n')
        {
            if (prevLine)
                return "";
            prevLine = true;
        }

        if (prevLine)
        {
            if (code[position] == '/' && position > minPosition)
            {
                if (code[position-1] == '/')
                {
                    let endIndex = code.indexOf("\n", position);
                    if (endIndex == -1)
                        return typedb.FormatDocumentationComment(code.substr(position+1));
                    else
                        return typedb.FormatDocumentationComment(code.substring(position+1, endIndex));
                }
                else if (code[position-1] == '*')
                {
                    let startIndex = code.lastIndexOf("/*", position);
                    if (startIndex == -1)
                        return typedb.FormatDocumentationComment(code.substr(0, position-1));
                    else
                        return typedb.FormatDocumentationComment(code.substring(startIndex+2, position-1));
                }
            }
        }
        position -= 1;
    }

    return "";
}

export function RemoveScopeFromDatabase(scope : ASScope)
{
    let typename = scope.getDBTypename();
    if(typename != null)
    {
        typedb.GetDatabase().delete(typename);
        typedb.GetDatabase().delete("__"+typename);
    }

    if (scope.scopetype == ASScopeType.Function && scope.isConstructor)
    {
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

    // Remove any types that were in this module before
    typedb.RemoveTypesInModule(modulename);

    // Add newly created types to the type database
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

function MakeDelegateDBType(scope : ASScope, delegate : ASDelegate) : typedb.DBType
{
    let dbtype = new typedb.DBType();
    dbtype.typename = delegate.name;
    dbtype.properties = new Array<typedb.DBProperty>();
    dbtype.methods = new Array<typedb.DBMethod>();
    dbtype.declaredModule = scope.modulename;
    if (delegate.isMulticast)
        dbtype.isEvent = true;
    else
        dbtype.isDelegate = true;

    {
        let method = new typedb.DBMethod();
        method.name = "IsBound";
        method.returnType = "bool";
        method.documentation = "Whether the anything is bound to the delegate.";
        method.args = [];
        dbtype.methods.push(method);
    }

    {
        let method = new typedb.DBMethod();
        method.name = "Clear";
        method.returnType = "void";
        method.documentation = "Remove all bindings from the delegate.";
        method.args = [];
        dbtype.methods.push(method);
    }

    if (delegate.isMulticast)
    {
        {
            let method = new typedb.DBMethod();
            method.name = "Broadcast";
            method.returnType = delegate.returnValue;
            method.documentation = "Broadcast event to all existing bindings.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of delegate.args)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "AddUFunction";
            method.returnType = "void";
            method.documentation = "Add a new binding to this event. Make sure the function you're binding is a UFUNCTION().";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "Unbind";
            method.returnType = "void";
            method.documentation = "Unbind a specific function that was previously added to this event.";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "UnbindObject";
            method.returnType = "void";
            method.documentation = "Unbind all previously added functions that are called on the specified object.";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
            ];
            dbtype.methods.push(method);
        }
    }
    else
    {
        {
            let method = new typedb.DBMethod();
            method.name = "Execute";
            method.returnType = delegate.returnValue;
            method.documentation = "Execute the function bound to the delegate. Will throw an error if nothing is bound, use ExecuteIfBound() if you do not want an error in that case.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of delegate.args)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "ExecuteIfBound";
            method.returnType = delegate.returnValue;
            method.documentation = "Execute the function if one is bound to the delegate, otherwise do nothing.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of delegate.args)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "BindUFunction";
            method.returnType = "void";
            method.documentation = "Set the function that is bound to this delegate. Make sure the function you're binding is a UFUNCTION().";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "GetUObject";
            method.returnType = "UObject";
            method.documentation = "Get the object that this delegate is bound to. Returns nullptr if unbound.";
            method.args = [];
            dbtype.methods.push(method);
        }

        {
            let method = new typedb.DBMethod();
            method.name = "GetFunctionName";
            method.returnType = "FName";
            method.documentation = "Get the function that this delegate is bound to. Returns NAME_None if unbound.";
            method.args = [];
            dbtype.methods.push(method);
        }
    }

    return dbtype;
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