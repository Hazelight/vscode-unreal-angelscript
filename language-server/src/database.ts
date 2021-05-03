import { GetCompletionTypeAndMember } from "./completion";

export class DBProperty
{
    name : string;
    typename : string;
    documentation : string;
    isProtected : boolean;
    isPrivate : boolean;
    isNoEdit : boolean = false;
    isEditOnly : boolean = false;
    declaredModule : string | null;

    fromJSON(name : string, input : any)
    {
        this.name = name;
        this.typename = input[0];
        this.isProtected = false;
        this.isPrivate = false;
        this.isNoEdit = false;
        this.isEditOnly = false;

        if (input.length >= 3)
        {
            if (input[1] == 'NoEdit')
                this.isNoEdit = true;
            else if (input[1] == 'EditOnly')
                this.isEditOnly = true;

            this.documentation = FormatDocumentationComment(input[2]);
        }
        else if (input.length >= 2)
        {
            if (input[1] == 'NoEdit')
                this.isNoEdit = true;
            else if (input[1] == 'EditOnly')
                this.isEditOnly = true;
            else if (!input[1].startsWith("+"))
                this.documentation = FormatDocumentationComment(input[1]);
        }
    }

    format(prefix : string = null) : string
    {
        let str : string = "";
        if (this.isProtected)
            str += "protected ";
        if (this.isPrivate)
            str += "private ";
        str += this.typename;
        str += " ";
        if (prefix)
            str += prefix;
        str += this.name;
        return str;
    }

    createTemplateInstance(templateTypes : Array<string>, actualTypes : Array<string>) : DBProperty
    {
        let inst = new DBProperty();
        inst.name = this.name;
        inst.typename = ReplaceTemplateType(this.typename, templateTypes, actualTypes);
        return inst;
    }
};

export class DBArg
{
    name : string | null;
    typename : string;
    defaultvalue : string | null;

    init(typename : string, name : string, defaultvalue : string = "") : DBArg
    {
        this.name = name;
        this.typename = typename;
        if (defaultvalue)
            this.defaultvalue = defaultvalue;
        return this;
    }

    fromJSON(input : any)
    {
        this.name = 'name' in input ? input['name'] : null;
        this.typename = input['type'];
        this.defaultvalue = 'default' in input ? input['default'] : null;
    }

    format() : string
    {
        let decl = this.typename;
        if (this.name != null)
            decl += " " + this.name;
        if (this.defaultvalue != null)
            decl += " = " + this.defaultvalue;
        return decl;
    }

    createTemplateInstance(templateTypes : Array<string>, actualTypes : Array<string>) : DBArg
    {
        let inst = new DBArg();
        inst.name = this.name;
        inst.defaultvalue = this.defaultvalue;
        inst.typename = ReplaceTemplateType(this.typename, templateTypes, actualTypes);
        return inst;
    }
};

export class DBMethod
{
    name : string;
    returnType : string;
    args : Array<DBArg>;
    argumentStr : string;
    documentation : string;
    declaredModule : string;
    isProtected : boolean = false;
    isPrivate : boolean = false;
    isConstructor : boolean = false;
    isEvent : boolean = false;
    isConst : boolean = false;
    isProperty : boolean = false;
    isDefaultsOnly : boolean = false;
    id : number = NextMethodId++;

    createTemplateInstance(templateTypes : Array<string>, actualTypes : Array<string>) : DBMethod
    {
        let inst = new DBMethod();
        inst.name = this.name;
        inst.returnType = ReplaceTemplateType(this.returnType, templateTypes, actualTypes);
        inst.argumentStr = this.argumentStr;
        inst.documentation = this.documentation;
        inst.isProtected = this.isProtected;
        inst.isPrivate = this.isPrivate;
        inst.isConstructor = this.isConstructor;
        inst.isEvent = this.isEvent;
        inst.isConst = this.isConst;
        inst.isProperty = this.isProperty;
        inst.isDefaultsOnly = this.isDefaultsOnly;

        inst.args = [];
        for(let argval of this.args)
            inst.args.push(argval.createTemplateInstance(templateTypes, actualTypes));
        return inst;
    }

    fromJSON(input : any)
    {
        this.name = input.name;

        if ('return' in input)
            this.returnType = input['return'];
        else
            this.returnType = 'void';

        this.args = new Array<DBArg>();
        if ('args' in input)
        {
            for (let argDesc of input['args'])
            {
                let arg = new DBArg;
                arg.fromJSON(argDesc);

                this.args.push(arg);
            }
        }

        if ('doc' in input)
            this.documentation = FormatDocumentationComment(input['doc']);
        else
            this.documentation = null;

        if ('isConstructor' in input)
            this.isConstructor = input['isConstructor'];
        else
            this.isConstructor = false;

        if ('const' in input)
            this.isConst = input['const'];
        else
            this.isConst = false;

        if ('event' in input)
            this.isEvent = input['event'];
        else
            this.isEvent = false;

        if ('isProperty' in input)
            this.isProperty = input['isProperty'];
        else
            this.isProperty = true;

        if ('defaultsonly' in input)
            this.isDefaultsOnly = input['defaultsonly'];
    }

    format(prefix : string = null, skipFirstArg = false, skipReturn = false, replaceName : string = null) : string
    {
        let decl : string = "";
        if (!skipReturn)
            decl += this.returnType + " ";
        if(prefix != null)
            decl += prefix;
        if (replaceName)
            decl += replaceName + "(";
        else
            decl += this.name + "(";
        let firstArg = true;
        if (this.argumentStr)
        {
            let argStr = this.argumentStr;
            if (skipFirstArg)
            {
                let cPos = argStr.search(",");
                if(cPos != -1)
                    argStr = argStr.substr(cPos+1).trim();
                else
                    argStr = "";
            }
            decl += argStr;
        }
        else if(this.args)
        {
            for(let i = 0; i < this.args.length; ++i)
            {
                if (skipFirstArg && i == 0)
                    continue;

                if (i > 0 || (skipFirstArg && i > 1))
                    decl += ", ";
                decl += this.args[i].format();
            }
        }
        decl += ")";
        if (this.isConst)
            decl += " const";
        if (this.isProperty && this.declaredModule)
            decl += " property";
        return decl;
    }
};

export class DBType
{
    typename : string;
    supertype : string;
    properties : Array<DBProperty>;
    methods : Array<DBMethod>;
    unrealsuper : string;
    documentation : string;

    isStruct : boolean;
    isNS : boolean;
    isEnum : boolean;
    rawName : string;
    namespaceResolved : boolean;
    shadowedNamespace : boolean;
    isDelegate : boolean = false;
    isEvent : boolean = false;
    isPrimitive : boolean = false;

    declaredModule : string;

    siblingTypes : Array<string>;
    subTypes : Array<string>;

    createTemplateInstance(actualTypes : Array<string>) : DBType
    {
        if (actualTypes.length != this.subTypes.length)
            return null;

        let inst = new DBType();
        inst.typename = this.typename;
        inst.supertype = this.supertype;
        inst.isNS = this.isNS;
        inst.isEnum = this.isEnum;
        inst.rawName = this.rawName;
        inst.namespaceResolved = this.namespaceResolved;
        inst.shadowedNamespace = this.shadowedNamespace;
        inst.declaredModule = this.declaredModule;
        if(this.siblingTypes)
            inst.siblingTypes = this.siblingTypes.slice();
        inst.subTypes = null;

        inst.properties = [];
        for (let prop of this.properties)
            inst.properties.push(prop.createTemplateInstance(this.subTypes, actualTypes));

        inst.methods = [];
        for (let mth of this.methods)
            inst.methods.push(mth.createTemplateInstance(this.subTypes, actualTypes));

        return inst;
    }

    initEmpty(name : string) : DBType
    {
        this.typename = name;
        this.methods = new Array<DBMethod>();
        this.properties = new Array<DBProperty>();
        return this;
    }

    fromJSON(name : string, input : any)
    {
        this.typename = name;
        this.properties = new Array<DBProperty>();
        for (let key in input.properties)
        {
            let prop = new DBProperty();
            prop.fromJSON(key, input.properties[key]);
            this.properties.push(prop);
        }
        this.methods = new Array<DBMethod>();
        for (let key in input.methods)
        {
            let func = new DBMethod();
            func.fromJSON(input.methods[key]);
            this.methods.push(func);
        }

        if ('subtypes' in input)
        {
            this.subTypes = new Array<string>();
            for(let subtype of input['subtypes'])
            {
                this.subTypes.push(subtype);
            }
        }

        if ('supertype' in input)
        {
            this.unrealsuper = input['supertype'];
        }

        if ('inherits' in input)
        {
            this.supertype = input['inherits'];
        }

        if ('doc' in input)
            this.documentation = FormatDocumentationComment(input['doc']);
        else
            this.documentation = null;

        if ('isStruct' in input)
            this.isStruct = input['isStruct'];
        else
            this.isStruct = false;

        if ('isEnum' in input)
            this.isEnum = input['isEnum'];
        else
            this.isEnum = false;
    }

    resolveNamespace()
    {
        this.isNS = this.typename.startsWith("__");
        this.namespaceResolved = true;

        if (this.isNS)
        {
            let otherType = this.typename.substring(2);
            this.shadowedNamespace = database.get(otherType) != null;
            this.rawName = otherType;
        }
    }

    isNamespace() : boolean
    {
        if (!this.namespaceResolved)
            this.resolveNamespace();
        return this.isNS;
    }

    isShadowedNamespace() : boolean
    {
        if (!this.namespaceResolved)
            this.resolveNamespace();
        return this.isNS && this.shadowedNamespace;
    }

    isUnrealType() : boolean
    {
        return !this.declaredModule;
    }

    hasExtendTypes() : boolean
    {
        if(this.supertype)
            return true;
        if(this.siblingTypes)
            return true;
        return false;
    }

    getExtendTypes() : Array<DBType>
    {
        let extend : Array<DBType> = [];
        if (this.supertype)
        {
            let dbsuper = GetType(this.supertype);
            if(dbsuper)
                extend.push(dbsuper);
        }

        if (this.siblingTypes)
        {
            for (let sibling of this.siblingTypes)
            {
                let dbsibling = GetType(sibling);
                if(dbsibling)
                    extend.push(dbsibling);
            }
        }

        return extend;
    }

    getCombineTypesList() : Array<DBType>
    {
        let extend : Array<DBType> = [ this ];
        let checkIndex = 0;
        while (checkIndex < extend.length)
        {
            let checkType = extend[checkIndex];

            if (checkType.supertype)
            {
                let dbsuper = GetType(checkType.supertype);
                if(dbsuper && !extend.includes(dbsuper))
                    extend.push(dbsuper);
            }

            if (checkType.siblingTypes)
            {
                for (let sibling of checkType.siblingTypes)
                {
                    let dbsibling = GetType(sibling);
                    if(dbsibling && !extend.includes(dbsibling))
                        extend.push(dbsibling);
                }
            }

            checkIndex += 1;
        }

        return extend;
    }

    allProperties() : Array<DBProperty>
    {
        if (!this.hasExtendTypes())
            return this.properties;

        let props : Array<DBProperty> = [];
        for(let extend of this.getCombineTypesList())
            props = props.concat(extend.properties);
        return props;
    }

    getProperty(name : string, recurse : boolean = true) : DBProperty | null
    {
        for (let prop of this.properties)
        {
            if (prop.name == name)
            {
                return prop;
            }
        }

        if (!recurse)
            return null;

        if (!this.hasExtendTypes())
            return null;

        for(let extend of this.getCombineTypesList())
        {
            let prop = extend.getProperty(name, false);
            if(prop)
                return prop;
        }

        return null;
    }

    getPropertyAccessorType(name : string) : string | null
    {
        let getter = this.getMethod("Get"+name);
        if (getter)
            return getter.returnType;
        let setter = this.getMethod("Get"+name);
        if (setter && setter.args.length >= 1)
            return setter.args[0].typename;
        return null;
    }

    allMethods() : Array<DBMethod>
    {
        if (!this.hasExtendTypes())
            return this.methods;

        let methodNames = new Map<string, DBType>();
        let outMethods = new Array<DBMethod>();

        for (let type of this.getCombineTypesList())
        {
            for (let mth of type.methods)
            {
                let declType = methodNames.get(mth.name);
                if (declType && declType != type)
                    continue;

                outMethods.push(mth);
                methodNames.set(mth.name, type);
            }
        }

        return outMethods;
    }

    getMethod(name : string, recurse : boolean = true) : DBMethod | null
    {
        for (let func of this.methods)
        {
            if (func.name == name)
            {
                return func;
            }
        }

        if (!recurse)
            return null;

        if (!this.hasExtendTypes())
            return null;

        for(let extend of this.getCombineTypesList())
        {
            let mth = extend.getMethod(name, false);
            if(mth)
                return mth;
        }

        return null;
    }

    getMethodWithIdHint(name : string, idHint : number, recurse : boolean = true) : DBMethod | null
    {
        let fallback : DBMethod = null;
        for (let func of this.methods)
        {
            if (func.name == name)
            {
                if (func.id == idHint)
                    return func;
                else if (!fallback)
                    fallback = func;
            }
        }

        if (!recurse)
            return fallback;

        if (!this.hasExtendTypes())
            return fallback;

        for(let extend of this.getCombineTypesList())
        {
            let mth = extend.getMethodWithIdHint(name, idHint, false);
            if (mth)
            {
                if (mth.id == idHint)
                    return mth;
                else if (!fallback)
                    fallback = mth;
            }
        }

        return fallback;
    }

    inheritsFrom(checktype : string) : boolean
    {
        let it : DBType = this;
        let dbCheck : DBType = GetType(checktype);
        if(!dbCheck)
            return false;
        while(it)
        {
            if (it.typename == dbCheck.typename)
                return true;

            if (it.supertype)
            {
                it = GetType(it.supertype);
                continue;
            }
            else if (it.unrealsuper)
            {
                it = GetType(it.unrealsuper);
                continue;
            }
            else
            {
                break;
            }
        }
        return false;
    }

    canOverrideFromParent(methodname : string) : boolean
    {
        // Check script parents
        let checktype = this.supertype;
        while (checktype)
        {
            let dbsuper = GetType(checktype);
            if (!dbsuper)
                break;
            let method = dbsuper.getMethod(methodname, false);
            if (method)
            {
                if (!dbsuper.isUnrealType || method.isEvent)
                    return true;
            }
            checktype = dbsuper.supertype;
        }

        return false;
    }

    hasOverriddenMethod(methodname : string) : boolean
    {
        for (let func of this.methods)
        {
            if (func.name == methodname)
                return true;
        }
        return false;
    }
};

export let database = new Map<string, DBType>();
let NextMethodId = 0;

export function CleanTypeName(typename : string) : string
{
    if (typename.startsWith("const "))
        typename = typename.substring(6);
    if (typename.endsWith("&"))
        typename = typename.substring(0, typename.length-1);
    else if (typename.endsWith("&out"))
        typename = typename.substring(0, typename.length-4);
    else if (typename.endsWith("&in"))
        typename = typename.substring(0, typename.length-3);
    else if (typename.endsWith("&inout"))
        typename = typename.substring(0, typename.length-5);
    else if (typename.endsWith("@"))
        typename = typename.substring(0, typename.length-1);
    return typename;
}

export function TransferTypeQualifiers(typename : string, newtype : string) : string
{
    if (typename.startsWith("const "))
        newtype = "const "+newtype;
    if (typename.endsWith("&"))
        newtype = newtype+"&";
    else if (typename.endsWith("&out"))
        newtype = newtype+"&out";
    else if (typename.endsWith("&in"))
        newtype = newtype+"&in";
    else if (typename.endsWith("&inout"))
        newtype = newtype+"&inout";
    return newtype;
}

let re_template = /([A-Za-z_0-9]+)\<([A-Za-z_0-9,\s]+)\>/;
export function ReplaceTemplateType(typename : string, templateTypes : Array<string>, actualTypes : Array<string>)
{
    typename = CleanTypeName(typename);
    for (let i = 0; i < templateTypes.length; ++i)
    {
        if (typename == templateTypes[i])
        {
            return actualTypes[i];
        }
    }

    if (typename.indexOf('<') != -1)
    {
        // Replace the template types inside the subtemplate as well
        let match = typename.match(re_template);
        if (match != null)
        {
            let basetype = match[1];

            let newtype = "";
            for (let subtype of match[2].split(","))
            {
                subtype = subtype.trim();
                let templIndex = templateTypes.indexOf(subtype);
                if (templIndex != -1)
                    subtype = actualTypes[templIndex];
                if (newtype.length != 0)
                    newtype += ",";
                newtype += subtype;
            }

            return basetype+"<"+newtype+">";
        }
    }

    return typename;
}

export function GetType(typename : string) : DBType | null
{
    if (!typename)
        return null;
    typename = CleanTypeName(typename);
    let foundType = database.get(typename);
    if (foundType)
        return foundType;

    if (typename.indexOf('<') != -1)
    {
        // See if we can create a template instance
        let match = typename.match(re_template);
        if (match != null)
        {
            let basetype = match[1];
            let subtypes = match[2].split(",").map(
                function(s : string) : string
                {
                    return s.trim();
                });

            let dbbasetype = GetType(basetype);
            if (!dbbasetype)
                return null;

            let inst = dbbasetype.createTemplateInstance(subtypes);
            inst.typename = typename;
            if (!inst)
                return null;

            database.set(typename, inst);
            return inst;
        }
    }

    return null;
}

export function AddPrimitiveTypes()
{
    for (let primtype of [
        "int",
        "int8",
        "uint",
        "int32",
        "int64",
        "float",
        "double",
        "bool",
    ])
    {
        let dbtype = new DBType().initEmpty(primtype);
        dbtype.isPrimitive = true;
        database.set(primtype, dbtype);
    }
}

export function AddTypesFromUnreal(input : any)
{
    for (let key in input)
    {
        let type = new DBType();
        type.fromJSON(key, input[key]);

        if (type.isNamespace())
            MergeNamespaceToDB(type);
        else
            database.set(key, type);
    }
}

export function GetDatabase() : Map<string, DBType>
{
    return database;
}

let re_comment_star_start = /^[ \t]*\*+[ \t]*[\r\n]+/gi;
let re_comment_star_end = /[\r\n]+[ \t]*\*+[ \t]*/gi;
export function FormatDocumentationComment(doc : string) : string
{
    doc = doc.replace(re_comment_star_end, "\n");
    doc = doc.replace(re_comment_star_start, " ");
    doc = doc.trim();
    return doc;
}

export function RemoveTypesInModule(module : string)
{
    for (let [name, dbtype] of database)
    {
        if (dbtype.declaredModule == module)
            database.delete(name);
    }
}

export function RemoveModuleFromNamespace(namespace : string, modulename : string)
{
    // Check if we already have a database entry for this namespace
    let dbtype = database.get(namespace);
    if (!dbtype)
        return;
    if (dbtype.declaredModule == modulename)
    {
        database.delete(namespace);
        return;
    }

    // Remove old methods from the same module that we are replacing
    let keepMethods = [];
    for (let method of dbtype.methods)
    {
        if (method.declaredModule != modulename)
            keepMethods.push(method);
    }

    // Replace method list in type
    dbtype.methods = keepMethods;
}

export function MergeNamespaceToDB(newtype : DBType, removeOldMethods : boolean = true)
{
    // Check if we already have a database entry for this namespace
    let dbtype = database.get(newtype.typename);
    if (!dbtype || (dbtype.declaredModule == newtype.declaredModule && removeOldMethods))
    {
        database.set(newtype.typename, newtype);
        return;
    }

    // Remove old methods from the same module that we are replacing
    let keepMethods = [];
    if (removeOldMethods)
    {
        for (let method of dbtype.methods)
        {
            if (method.declaredModule != newtype.declaredModule)
                keepMethods.push(method);
        }
    }
    else
    {
        // Keep all methods
        keepMethods = dbtype.methods;
    }

    // Add all the new methods we're adding
    for (let method of newtype.methods)
        keepMethods.push(method);

    // Replace method list in type
    dbtype.methods = keepMethods;

    // Now that we're merging methods this type is no longer exclusive to this module
    if (dbtype.declaredModule != newtype.declaredModule)
        dbtype.declaredModule = null;
}