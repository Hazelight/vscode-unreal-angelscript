"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class DBProperty {
    fromJSON(name, input) {
        this.name = name;
        this.typename = input[0];
    }
    format(prefix = null) {
        if (prefix != null)
            return this.typename + " " + this.name;
        else
            return this.typename + " " + prefix + "::" + this.name;
    }
    createTemplateInstance(templateTypes, actualTypes) {
        let inst = new DBProperty();
        inst.name = this.name;
        inst.typename = ReplaceTemplateType(this.typename, templateTypes, actualTypes);
        return inst;
    }
}
exports.DBProperty = DBProperty;
;
class DBArg {
    init(name, typename, defaultvalue = "") {
        this.name = name;
        this.typename = typename;
        if (defaultvalue)
            this.defaultvalue = defaultvalue;
        return this;
    }
    fromJSON(input) {
        this.name = 'name' in input ? input['name'] : null;
        this.typename = input['type'];
        this.defaultvalue = 'default' in input ? input['default'] : null;
    }
    format() {
        let decl = this.typename;
        if (this.name != null)
            decl += " " + this.name;
        if (this.defaultvalue != null)
            decl += " = " + this.defaultvalue;
        return decl;
    }
    createTemplateInstance(templateTypes, actualTypes) {
        let inst = new DBArg();
        inst.name = this.name;
        inst.defaultvalue = this.defaultvalue;
        inst.typename = ReplaceTemplateType(this.typename, templateTypes, actualTypes);
        return inst;
    }
}
exports.DBArg = DBArg;
;
class DBMethod {
    createTemplateInstance(templateTypes, actualTypes) {
        let inst = new DBMethod();
        inst.name = this.name;
        inst.returnType = ReplaceTemplateType(this.returnType, templateTypes, actualTypes);
        inst.argumentStr = this.argumentStr;
        inst.documentation = this.documentation;
        inst.args = [];
        for (let argval of this.args)
            inst.args.push(argval.createTemplateInstance(templateTypes, actualTypes));
        return inst;
    }
    fromJSON(input) {
        this.name = input.name;
        if ('return' in input)
            this.returnType = input['return'];
        else
            this.returnType = 'void';
        this.args = new Array();
        if ('args' in input) {
            for (let argDesc of input['args']) {
                let arg = new DBArg;
                arg.fromJSON(argDesc);
                this.args.push(arg);
            }
        }
        if ('doc' in input)
            this.documentation = input['doc'];
        else
            this.documentation = null;
    }
    format(prefix = null, skipFirstArg = false) {
        let decl = this.returnType + " ";
        if (prefix != null)
            decl += prefix + "::";
        decl += this.name + "(";
        let firstArg = true;
        if (this.argumentStr) {
            let argStr = this.argumentStr;
            if (skipFirstArg) {
                let cPos = argStr.search(",");
                if (cPos != -1)
                    argStr = argStr.substr(cPos + 1).trim();
                else
                    argStr = "";
            }
            decl += argStr;
        }
        else if (this.args) {
            for (let i = 0; i < this.args.length; ++i) {
                if (skipFirstArg && i == 0)
                    continue;
                if (i > 0 || (skipFirstArg && i > 1))
                    decl += ", ";
                decl += this.args[i].format();
            }
        }
        decl += ")";
        return decl;
    }
}
exports.DBMethod = DBMethod;
;
class DBType {
    createTemplateInstance(actualTypes) {
        if (actualTypes.length != this.subTypes.length)
            return null;
        let inst = new DBType();
        inst.typename = this.typename;
        inst.supertype = this.supertype;
        inst.isNS = this.isNS;
        inst.rawName = this.rawName;
        inst.namespaceResolved = this.namespaceResolved;
        inst.shadowedNamespace = this.shadowedNamespace;
        inst.declaredModule = this.declaredModule;
        if (this.siblingTypes)
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
    initEmpty(name) {
        this.typename = name;
        this.methods = new Array();
        this.properties = new Array();
        return this;
    }
    fromJSON(name, input) {
        this.typename = name;
        this.properties = new Array();
        for (let key in input.properties) {
            let prop = new DBProperty();
            prop.fromJSON(key, input.properties[key]);
            this.properties.push(prop);
        }
        this.methods = new Array();
        for (let key in input.methods) {
            let func = new DBMethod();
            func.fromJSON(input.methods[key]);
            this.methods.push(func);
        }
        if ('subtypes' in input) {
            this.subTypes = new Array();
            for (let subtype of input['subtypes']) {
                this.subTypes.push(subtype);
            }
        }
        if ('supertype' in input) {
            this.unrealsuper = input['supertype'];
        }
    }
    resolveNamespace() {
        this.isNS = this.typename.startsWith("__");
        this.namespaceResolved = true;
        if (this.isNS) {
            let otherType = this.typename.substring(2);
            this.shadowedNamespace = exports.database.get(otherType) != null;
            this.rawName = otherType;
        }
    }
    isNamespace() {
        if (!this.namespaceResolved)
            this.resolveNamespace();
        return this.isNS;
    }
    isShadowedNamespace() {
        if (!this.namespaceResolved)
            this.resolveNamespace();
        return this.isNS && this.shadowedNamespace;
    }
    hasExtendTypes() {
        if (this.supertype)
            return true;
        if (this.siblingTypes)
            return true;
        return false;
    }
    getExtendTypes() {
        let extend = [];
        if (this.supertype) {
            let dbsuper = GetType(this.supertype);
            if (dbsuper)
                extend.push(dbsuper);
        }
        if (this.siblingTypes) {
            for (let sibling of this.siblingTypes) {
                let dbsibling = GetType(sibling);
                if (dbsibling)
                    extend.push(dbsibling);
            }
        }
        return extend;
    }
    allProperties() {
        if (!this.hasExtendTypes())
            return this.properties;
        let props = this.properties;
        for (let extend of this.getExtendTypes())
            props = props.concat(extend.allProperties());
        return props;
    }
    getProperty(name) {
        for (let prop of this.properties) {
            if (prop.name == name) {
                return prop;
            }
        }
        if (!this.hasExtendTypes())
            return null;
        for (let extend of this.getExtendTypes()) {
            let prop = extend.getProperty(name);
            if (prop)
                return prop;
        }
        return null;
    }
    getPropertyAccessorType(name) {
        let getter = this.getMethod("Get" + name);
        if (getter)
            return getter.returnType;
        let setter = this.getMethod("Get" + name);
        if (setter && setter.args.length >= 1)
            return setter.args[0].typename;
        return null;
    }
    allMethods() {
        if (!this.hasExtendTypes())
            return this.methods;
        let mth = this.methods;
        for (let extend of this.getExtendTypes())
            mth = mth.concat(extend.allMethods());
        return mth;
    }
    getMethod(name) {
        for (let func of this.methods) {
            if (func.name == name) {
                return func;
            }
        }
        if (!this.hasExtendTypes())
            return null;
        for (let extend of this.getExtendTypes()) {
            let mth = extend.getMethod(name);
            if (mth)
                return mth;
        }
        return null;
    }
    inheritsFrom(checktype) {
        let it = this;
        let dbCheck = GetType(checktype);
        if (!dbCheck)
            return false;
        while (it) {
            if (it.typename == dbCheck.typename)
                return true;
            if (it.supertype) {
                it = GetType(it.supertype);
                continue;
            }
            else if (it.unrealsuper) {
                it = GetType(it.unrealsuper);
                continue;
            }
            else {
                break;
            }
        }
        return false;
    }
}
exports.DBType = DBType;
;
exports.database = new Map();
function CleanTypeName(typename) {
    if (typename.startsWith("const "))
        typename = typename.substring(6);
    if (typename.endsWith("&"))
        typename = typename.substring(0, typename.length - 1);
    if (typename.endsWith("@"))
        typename = typename.substring(0, typename.length - 1);
    return typename;
}
exports.CleanTypeName = CleanTypeName;
function ReplaceTemplateType(typename, templateTypes, actualTypes) {
    typename = CleanTypeName(typename);
    for (let i = 0; i < templateTypes.length; ++i) {
        if (typename == templateTypes[i]) {
            return actualTypes[i];
        }
    }
    return typename;
}
exports.ReplaceTemplateType = ReplaceTemplateType;
let re_template = /([A-Za-z_0-9]+)\<([A-Za-z_0-9,\s]+)\>/;
function GetType(typename) {
    typename = CleanTypeName(typename);
    let foundType = exports.database.get(typename);
    if (foundType)
        return foundType;
    if (typename.indexOf('<') != -1) {
        // See if we can create a template instance
        let match = typename.match(re_template);
        if (match != null) {
            let basetype = match[1];
            let subtypes = match[2].split(",").map(function (s) {
                return s.trim();
            });
            let dbbasetype = GetType(basetype);
            if (!dbbasetype)
                return null;
            let inst = dbbasetype.createTemplateInstance(subtypes);
            inst.typename = typename;
            if (!inst)
                return null;
            exports.database.set(typename, inst);
            return inst;
        }
    }
    return null;
}
exports.GetType = GetType;
function AddPrimitiveTypes() {
    for (let primtype of [
        "int",
        "int8",
        "uint",
        "int32",
        "int64",
        "float",
        "double",
        "bool",
    ]) {
        exports.database.set(primtype, new DBType().initEmpty(primtype));
    }
}
exports.AddPrimitiveTypes = AddPrimitiveTypes;
function AddTypesFromUnreal(input) {
    for (let key in input) {
        let type = new DBType();
        type.fromJSON(key, input[key]);
        exports.database.set(key, type);
    }
}
exports.AddTypesFromUnreal = AddTypesFromUnreal;
function GetDatabase() {
    return exports.database;
}
exports.GetDatabase = GetDatabase;
//# sourceMappingURL=database.js.map