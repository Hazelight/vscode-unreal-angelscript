import { assert } from 'console';
import * as typedb from './database';

let UseHazeGeneratedCode = true;

export function ProcessScriptTypeGeneratedCode(dbtype : typedb.DBType) : Array<typedb.DBType>
{
    let result : Array<typedb.DBType> = [];

    // Code that all delegate structs have
    if (dbtype.isEvent || dbtype.isDelegate)
        AddGeneratedCodeForDelegate(dbtype);

    if (!dbtype.isStruct)
    {
        let nsType = new typedb.DBType();
        nsType.declaredModule = dbtype.declaredModule;
        nsType.moduleOffset = dbtype.moduleOffset;
        nsType.initEmpty("__"+dbtype.typename);

        // Code that all UObject classes have
        AddGeneratedCodeForUObject(dbtype, nsType);

        // Code that only actor components have
        if (dbtype.inheritsFrom("UActorComponent"))
            AddGeneratedCodeForUActorComponent(dbtype, nsType);

        // Code that only actors have
        if (dbtype.inheritsFrom("AActor"))
            AddGeneratedCodeForAActor(dbtype, nsType);

        if (UseHazeGeneratedCode)
            AddHazeGeneratedCode(dbtype, nsType);

        // Merge namespace into the type database
        nsType = typedb.MergeNamespaceToDB(nsType, false);
        result.push(nsType);
    }

    return result;
}

function AddMethod(dbtype : typedb.DBType, name : string) : typedb.DBMethod
{
    let method = new typedb.DBMethod();
    method.name = name;
    method.declaredModule = dbtype.declaredModule;
    method.moduleOffset = dbtype.moduleOffset;
    dbtype.methods.push(method);
    dbtype.addSymbol(method);
    return method;
}

function AddProperty(dbtype : typedb.DBType, name : string) : typedb.DBProperty
{
    let method = new typedb.DBProperty();
    method.name = name;
    method.declaredModule = dbtype.declaredModule;
    method.moduleOffset = dbtype.moduleOffset;
    dbtype.properties.push(method);
    dbtype.addSymbol(method);
    return method;
}

function AddGeneratedCodeForUObject(dbtype : typedb.DBType, nsType : typedb.DBType)
{
    {
        let method = AddMethod(nsType, "StaticClass");
        method.returnType = "UClass";
        method.documentation = "Gets the descriptor for the class generated for the specified type.";
        method.args = [];
    }
}

function AddGeneratedCodeForUActorComponent(dbtype : typedb.DBType, nsType : typedb.DBType)
{
    {
        let method = AddMethod(nsType, "Get");
        method.returnType = dbtype.typename;
        method.documentation = "Get the component of this type from an actor. Specified name is optional.";
        method.args = [
            new typedb.DBArg().init("AActor", "Actor"),
            new typedb.DBArg().init("FName", "WithName", "NAME_None"),
        ];
    }

    {
        let method = AddMethod(nsType, "GetOrCreate");
        method.returnType = dbtype.typename;
        method.documentation = "Get a component of a particular type on an actor, create it if it doesn't exist. Specified name is optional.";
        method.args = [
            new typedb.DBArg().init("AActor", "Actor"),
            new typedb.DBArg().init("FName", "WithName", "NAME_None"),
        ];
    }

    {
        let method = AddMethod(nsType, "Create");
        method.returnType = dbtype.typename;
        method.documentation = "Always create a new component of this type on an actor.";
        method.args = [
            new typedb.DBArg().init("AActor", "Actor"),
            new typedb.DBArg().init("FName", "WithName", "NAME_None"),
        ];
    }
}

function AddGeneratedCodeForAActor(dbtype : typedb.DBType, nsType : typedb.DBType)
{
    {
        let method = AddMethod(nsType, "Spawn");
        method.returnType = dbtype.typename;
        method.documentation = "Spawn a new actor of this type into the world.";
        method.args = [
            new typedb.DBArg().init("FVector", "Location", "FVector::ZeroVector"),
            new typedb.DBArg().init("FRotator", "Rotation", "FRotator::ZeroRotator"),
            new typedb.DBArg().init("FName", "Name", "NAME_None"),
            new typedb.DBArg().init("bool", "bDeferredSpawn", "false"),
            new typedb.DBArg().init("ULevel", "Level", "nullptr"),
        ];
        dbtype.methods.push(method);
    }
}

function AddGeneratedCodeForDelegate(dbtype : typedb.DBType)
{
    {
        let method = AddMethod(dbtype, "IsBound");
        method.returnType = "bool";
        method.documentation = "Whether the anything is bound to the delegate.";
        method.args = [];
    }

    {
        let method = AddMethod(dbtype, "Clear");
        method.returnType = "void";
        method.documentation = "Remove all bindings from the delegate.";
        method.args = [];
    }

    if (dbtype.isEvent)
    {
        {
            let method = AddMethod(dbtype, "Broadcast");
            method.returnType = dbtype.delegateReturn;
            method.documentation = "Broadcast event to all existing bindings.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of dbtype.delegateArgs)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        }

        {
            let method = AddMethod(dbtype, "AddUFunction");
            method.returnType = "void";
            method.documentation = "Add a new binding to this event. Make sure the function you're binding is a UFUNCTION().";
            method.isDelegateBindFunction = true;
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
        }

        {
            let method = AddMethod(dbtype, "Unbind");
            method.returnType = "void";
            method.documentation = "Unbind a specific function that was previously added to this event.";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
        }

        {
            let method = AddMethod(dbtype, "UnbindObject");
            method.returnType = "void";
            method.documentation = "Unbind all previously added functions that are called on the specified object.";
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
            ];
        }
    }
    else
    {
        {
            let method = AddMethod(dbtype, "Execute");
            method.returnType = dbtype.delegateReturn;
            method.documentation = "Execute the function bound to the delegate. Will throw an error if nothing is bound, use ExecuteIfBound() if you do not want an error in that case.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of dbtype.delegateArgs)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        }

        {
            let method = AddMethod(dbtype, "ExecuteIfBound");
            method.returnType = dbtype.delegateReturn;
            method.documentation = "Execute the function if one is bound to the delegate, otherwise do nothing.";
            method.args = new Array<typedb.DBArg>();
            for (let delegateArg of dbtype.delegateArgs)
            {
                let arg = new typedb.DBArg();
                arg.name = delegateArg.name;
                arg.typename = delegateArg.typename;
                method.args.push(arg);
            }
        }

        {
            let method = AddMethod(dbtype, "BindUFunction");
            method.returnType = "void";
            method.documentation = "Set the function that is bound to this delegate. Make sure the function you're binding is a UFUNCTION().";
            method.isDelegateBindFunction = true;
            method.args = [
                new typedb.DBArg().init("UObject", "Object"),
                new typedb.DBArg().init("FName", "FunctionName"),
            ];
        }

        {
            let method = AddMethod(dbtype, "GetUObject");
            method.isProperty = true;
            method.name = "GetUObject";
            method.returnType = "UObject";
            method.documentation = "Get the object that this delegate is bound to. Returns nullptr if unbound.";
            method.args = [];
        }

        {
            let method = AddMethod(dbtype, "GetFunctionName");
            method.isProperty = true;
            method.returnType = "FName";
            method.documentation = "Get the function that this delegate is bound to. Returns NAME_None if unbound.";
            method.args = [];
        }
    }

    return dbtype;
}

function AddHazeGeneratedCode(dbtype : typedb.DBType, nsType : typedb.DBType)
{
    if (dbtype.inheritsFrom("UHazeComposableSettings"))
        AddGeneratedCodeForUHazeComposableSettings(dbtype, nsType);
}

function AddGeneratedCodeForUHazeComposableSettings(dbtype : typedb.DBType, nsType : typedb.DBType)
{
    {
        let method = AddMethod(nsType, "GetSettings");
        method.returnType = dbtype.typename;
        method.documentation = "Get the result settings asset for a specific actor.";
        method.args = [
            new typedb.DBArg().init("AHazeActor", "Actor"),
        ];
    }

    {
        let method = AddMethod(nsType, "TakeTransientSettings");
        method.returnType = dbtype.typename;
        method.documentation = "Grab a transient settings asset that can be used to temporarily overried values. Must be returned with Actor.ReturnTransientSettings to apply new values.";
        method.args = [
            new typedb.DBArg().init("AHazeActor", "Actor"),
            new typedb.DBArg().init("UObject", "Instigator"),
            new typedb.DBArg().init("EHazeSettingsPriority", "Priority", "EHazeSettingsPriority::Script"),
        ];
    }

    for (let dbprop of dbtype.properties)
    {
        if (!dbprop.isUProperty)
            continue;

        {
            let overrideProp = AddProperty(dbtype, "bOverride_"+dbprop.name);
            overrideProp.moduleOffset = dbprop.moduleOffset;
            overrideProp.typename = "bool";
        }

        let setName = dbprop.name;
        if (setName[0] == 'b' && setName[1] == setName[1].toUpperCase())
            setName = setName.substr(1);

        {
            let method = AddMethod(nsType, "Set"+setName);
            method.returnType = null;
            method.documentation = "Apply a transient override for this composable settings property.";
            method.args = [
                new typedb.DBArg().init("AHazeActor", "Actor"),
                new typedb.DBArg().init(dbtype.typename, "NewValue"),
                new typedb.DBArg().init("UObject", "Instigator"),
                new typedb.DBArg().init("EHazeSettingsPriority", "Priority", "EHazeSettingsPriority::Script"),
            ];
        }

        {
            let method = AddMethod(nsType, "Clear"+setName);
            method.returnType = null;
            method.documentation = "Clear a previously applied transient override.";
            method.args = [
                new typedb.DBArg().init("AHazeActor", "Actor"),
                new typedb.DBArg().init("UObject", "Instigator"),
                new typedb.DBArg().init("EHazeSettingsPriority", "Priority", "EHazeSettingsPriority::Script"),
            ];
        }
    }
}