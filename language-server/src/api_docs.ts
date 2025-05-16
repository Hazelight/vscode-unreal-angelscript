import * as scriptfiles from './as_parser';
import * as typedb from './database';
import * as documentation from './documentation';

export function GetAPIList(root : string) : any
{
    let list : any[] = [];

    let addType = function(type : typedb.DBType | typedb.DBNamespace)
    {
        if (type instanceof typedb.DBNamespace)
        {
            for (let [_, childNamespace] of type.childNamespaces)
            {
                if (childNamespace.isShadowingType())
                    continue;

                list.push({
                    "type": "namespace",
                    "id": childNamespace.getQualifiedNamespace(),
                    "data": ["namespace", childNamespace.getQualifiedNamespace()],
                    "label": childNamespace.getQualifiedNamespace()+"::",
                });
            }

            if (type.isRootNamespace())
            {
                list.sort(function (a, b)
                {
                    if (a.label < b.label)
                        return -1;
                    else if (a.label > b.label)
                        return 1;
                    else
                        return 0;
                });
                return;
            }
        }

        type.forEachSymbol(function (symbol : typedb.DBSymbol)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.isMixin)
                    return;
                list.push({
                    "type": "function",
                    "label": symbol.name+"()",
                    "id": symbol.id.toString(),
                    "data": ["function", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name, symbol.id],
                });
            }
            else if (symbol instanceof typedb.DBProperty)
            {
                list.push({
                    "type": "property",
                    "label": symbol.name,
                    "id": symbol.namespace.getQualifiedNamespace() + "::" + symbol.name,
                    "data": ["global", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name],
                });
            }
        });
    }

    if (!root)
    {
        addType(typedb.GetRootNamespace());
    }
    else
    {
        let namespace = typedb.LookupNamespace(null, root);
        if (namespace)
        {
            addType(namespace);
        }
    }

    return list;
}

export function GetAPIDetails(data : any) : any
{
    if (data[0] == "namespace")
    {
        let namespace = typedb.LookupNamespace(null, data[1]);
        if (namespace)
        {
            return namespace.documentation ?? "";
        }
    }
    else if (data[0] == "function" || data[0] == "method")
    {
        let method : typedb.DBMethod;
        let symbols : Array<typedb.DBSymbol>;
        let method_id = 0;
        if (data[0] == "function")
        {
            symbols = typedb.LookupGlobalSymbol(null, data[1]);
            method_id = data[2];
        }
        else
        {
            let dbType = typedb.GetTypeByName(data[1]);
            if (dbType)
                symbols = dbType.findSymbols(data[2]);
            method_id = data[3];
        }

        for (let symbol of symbols)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.id != method_id)
                    continue;
                method = symbol;
            }
        }

        if (!method)
        {
            for (let symbol of symbols)
            {
                if (symbol instanceof typedb.DBMethod)
                {
                    method = symbol;
                }
            }
        }

        if (!method)
            return ""

        let details = "```angelscript_snippet\n";
        details += method.returnType;
        details += " ";
        if (method.containingType)
        {
            details += method.containingType.getQualifiedTypenameInNamespace(null);
            details += ".";
        }
        else if (method.isMixin)
        {
            details += method.args[0].typename;
            details += ".";
        }
        else
        {
            details += method.namespace.getQualifiedNamespace();
            details += "::";
        }

        details += method.name;

        if (method.args && method.args.length > 0)
        {
            details += "(";
            for(let i = 0; i < method.args.length; ++i)
            {
                if (method.isMixin && i == 0)
                    continue;
                details += "\n\t\t";
                details += method.args[i].format();
                if (i+1 < method.args.length)
                    details += ",";
            }
            details += "\n)";
        }
        else
        {
            details += "()";
        }

        details += "\n```\n";

        let doc = method.findAvailableDocumentation();
        if (doc)
            details += documentation.FormatFunctionDocumentation(doc, method);

        return details;
    }
    else if (data[0] == "global")
    {
        let symbols = typedb.LookupGlobalSymbol(null, data[1]);
        for (let symbol of symbols)
        {
            if (symbol instanceof typedb.DBProperty)
            {
                let details = "```angelscript_snippet\n"+symbol.format(
                    symbol.namespace.getQualifiedNamespace()+"::"
                )+"\n```\n";
                details += documentation.FormatPropertyDocumentation(symbol.documentation);

                return details;
            }
        }
    }
    else if (data[0] == "property")
    {
        let dbType = typedb.GetTypeByName(data[1]);
        if (!dbType)
            return "";
        let symbols = dbType.findSymbols(data[2]);
        for (let symbol of symbols)
        {
            if (symbol instanceof typedb.DBProperty)
            {
                let details = "```angelscript_snippet\n"+symbol.format(
                    symbol.containingType.getQualifiedTypenameInNamespace(null)+"."
                )+"\n```\n";
                details += documentation.FormatPropertyDocumentation(symbol.documentation);

                return details;
            }
        }
    }

    return "";
}

export function GetAPISearch(filter : string) : any
{
    let list : any[] = [];
    let phrases = new Array<string>();

    for (let phrase of filter.split(" "))
    {
        if (phrase.length > 0)
            phrases.push(phrase.toLowerCase());
    }

    if (phrases.length == 0)
        return [];

    let filter_lower = filter.toLowerCase();

    let canComplete = function(name : string)
    {
        let hadLongMatch = false;
        for (let i = 0; i < phrases.length; ++i)
        {
            let phrase = phrases[i];
            if (phrase.length < 3 && !hadLongMatch)
            {
                if (!name.toLowerCase().startsWith(phrase))
                    return false;
            }
            else
            {
                hadLongMatch = true;
                if (!name.toLowerCase().includes(phrase))
                    return false;
            }
        }

        return true;
    }

    let searchType = function(type : typedb.DBType | typedb.DBNamespace)
    {
        let typePrefix : string = "";
        let typeMatches = false;
        if (type instanceof typedb.DBNamespace)
        {
            for (let [_, childNamespace] of type.childNamespaces)
            {
                if (childNamespace.isShadowingType())
                    continue;

                searchType(childNamespace);
            }

            if (!type.isRootNamespace())
            {
                typePrefix = type.getQualifiedNamespace() + "::";
                typeMatches = canComplete(type.name);
            }
        }
        else
        {
            typePrefix = type.getQualifiedTypenameInNamespace(null) + ".";
            typeMatches = canComplete(type.name);
        }

        type.forEachSymbol(function (symbol : typedb.DBSymbol)
        {
            if (symbol instanceof typedb.DBMethod)
            {
                if (symbol.isConstructor)
                    return;
                if (symbol.name.startsWith("op"))
                    return;
                if (typeMatches || canComplete(symbol.name))
                {
                    let symbol_id;
                    if (symbol.containingType)
                        symbol_id = ["method", symbol.containingType.name, symbol.name, symbol.id];
                    else if (symbol.namespace && !symbol.namespace.isRootNamespace())
                        symbol_id = ["function", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name];
                    else
                        symbol_id = ["function", symbol.name];

                    let label = typePrefix+symbol.name+"()";
                    if (symbol.isMixin)
                        label = symbol.args[0].typename+"."+symbol.name+"()";

                    list.push({
                        "type": "function",
                        "label": label,
                        "id": symbol.id.toString(),
                        "data": symbol_id,
                    });
                }
            }
            else if (symbol instanceof typedb.DBProperty)
            {
                if (typeMatches || canComplete(symbol.name))
                {
                    let symbol_id;
                    if (symbol.containingType)
                        symbol_id = ["property", symbol.containingType.name, symbol.name];
                    else if (symbol.namespace && !symbol.namespace.isRootNamespace())
                        symbol_id = ["global", symbol.namespace.getQualifiedNamespace() + "::" + symbol.name];
                    else
                        symbol_id = ["global", symbol.name];

                    list.push({
                        "type": "property",
                        "label": typePrefix+symbol.name,
                        "id": typePrefix+symbol.name,
                        "data": symbol_id,
                    });
                }
            }
            else if (symbol instanceof typedb.DBType)
            {
                if (!symbol.declaredModule && !symbol.isEnum && !symbol.isTemplateInstantiation && !symbol.isTemplateType() && !symbol.isDelegate && !symbol.isEvent)
                    searchType(symbol);
            }
        }, false);
    }

    searchType(typedb.GetRootNamespace());

    list.sort(function (a, b)
    {
        if (a.data[0] == "function" && b.data[0] != "function")
            return -1;
        else if (b.data[0] == "function" && a.data[0] != "function")
            return 1;

        if (a.label < b.label)
            return -1;
        else if (a.label > b.label)
            return 1;

        return 0;
    });

    return list;
}