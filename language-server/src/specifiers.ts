
export let ASPropertySpecifiers : any = {
    "BlueprintReadWrite": "Allow the property to be read and written from blueprint nodes",
    "BlueprintReadOnly": "Allow the property to be read from blueprint but not written",
    "BlueprintHidden": "Do not make this property available to blueprint at all",
    "EditInstanceOnly": "Property can only be changed on instances in the level",
    "EditDefaultsOnly": "Property can only be changed on defaults inside blueprint classes",
    "EditAnywhere": "Property can be changed by blueprint classes and on instances in the level",
    "NotEditable": "Property cannot be edited from unreal anywhere",
    "NotVisible": "Property cannot be changed or seen in the details panel at all",
    "EditConst": "Property can be seen in the details panel but not edited",
    "VisibleAnywhere": "Property can be seen both on blueprint classes and instances in the level, but not changed",
    "VisibleInstanceOnly": "Property can only be seen on instances in the level, but not changed",
    "VisibleDefaultsOnly": "Property can only be seen on defaults inside blueprint classes, but not changed",
    "AdvancedDisplay": "Property can only be edited after expanding to advanced view",
    "Transient": "Property is never saved into the on-disk asset",
    "Config": "Property can be saved and loaded from config ini files",
    "Interp": "Property can be modified by sequence tracks",
    "AssetRegistrySearchable": "Property is indexed for searching in the Asset Registry",
    "NoClear": "Property is not allowed to be changed to nullptr",
    "Category": "Category to list this under in the editor",
    "Keywords": "Keywords this can be found by in the editor",
    "ToolTip": "Tooltip to show in the editor",
    "DisplayName": "Name to use to display in the editor",
    "EditInline": "Edit the values of this object inline in its container",
    "ExposeOnSpawn": "Property should be available to be changed when spawning this object from blueprint",
    "EditFixedSize": "Use on TArray propertie, the size of the array cannot be changed from the editor",
    "BlueprintProtected": "Treat this property as protected in blueprint, disallowing it from being edited by non-child blueprints",
    "DefaultComponent": "Component will be created as a default component on the actor",
    "OverrideComponent": "Specify a component in the parent class to override the class type of",
    "RootComponent": "Use on DefaultComponents, specify that this component should be the root component of the actor",
    "ShowOnActor": "Use on DefaultComponents, properties from the component will appear in the actor's details panel",
    "Attach": "Use on DefaultComponents, specify a different component to attach this to in the scene hierarchy",
    "AttachSocket": "Use on DefaultComponents with an Attach, specify a socket to attach to on this component's attach parent",
    "Meta": "Specify arbitrary meta tags",
    "Instanced": "The object in this property is a new instance for each containing instance",
    "BlueprintSetter": "Specify a function to call instead when writing this property from blueprint",
    "BlueprintGetter": "Specify a function to call instead when reading this property from blueprint",
    "BindWidget": "Automatically bind this property to the widget with the same name within child UMG blueprints",
    "SaveGame": "Property should be serialized for save games",
};

export let ASPropertySpecifiers_HAZE : any = {
};

export let ASPropertySpecifiers_NO_HAZE : any = {
    "Replicated": "Property should be replicated to clients",
    "ReplicatedUsing": "Specify a function to call when the property is replicated (requires Replicated)",
    "ReplicationCondition": "Specify when the property should be replicated",
};

export let ASPropertySubSpecifiers : any = {
    // Note: subspecifier keys should be lowercase so they can be found consistently
    "meta": {
        "InlineEditCondition": "When this boolean is used as an edit condition, display it inline to the left of the conditional property",
        "EditCondition": "Only allow this property to be edited depending on the state of other properties",
        "EditConditionHides": "Hide this property completely when its EditCondition is false",
        "MakeEditWidget": "Create a movable 3D widget in the world for transforms and vectors",
        "ClampMin": "Clamp the numeric value of this property so it is never below the specifiec value",
        "ClampMax": "Clamp the numeric value of this property so it is never below the specifiec value",
        "UIMin": "Set the minimum value for the UI slider for the numeric value of this property",
        "UIMax": "Set the maximum value for the UI slider for the numeric value of this property",
        "Units": "Determine the unit of this property's numeric value for the UI",
        "Delta": "How large is one value step in the UI for the numeric value of this property",
        "ShowOnlyInnerProperties": "Show this property's inner properties as if they are parent-level properties",
    },
    "replicationcondition": {
        "InitialOnly": "This property will only attempt to send on the initial bunch",
        "OwnerOnly": "This property will only send to the actor's owner",
        "SkipOwner": "This property send to every connection EXCEPT the owner",
        "SimulatedOnly": "This property will only send to simulated actors",
        "AutonomousOnly": "This property will only send to autonomous actors",
        "SimulatedOrPhysics": "This property will send to simulated OR bRepPhysics actors",
        "InitialOrOwner": "This property will send on the initial packet, or to the actors owner",
        "Custom": "",
        "ReplayOrOwner": "",
        "ReplayOnly": "",
        "SimulatedOnlyNoReplay": "",
        "SimulatedOrPhysicsNoReplay": "",
        "SkipReplay": "",
    },
};

export let ASClassSpecifiers : any = {
    "NotPlaceable": "Class cannot be placed in the level or on an actor by the editor",
    "NotBlueprintable": "Blueprints cannot be choose this as a parent class",
    "Blueprintable": "Blueprints can be created with this as a parent class",
    "Abstract": "Cannot be instantiated on its own, must have a child class to spawn",
    "Transient": "All instances of this class will be transient",
    "HideDropdown": "This class will be hidden from property combo boxes in Editor",
    "Config": "Allow properties in this class to be saved and loaded to the specified ini",
    "Deprecated": "This class is deprecated and should not be used",
    "HideCategories": "Properties in these categories are not editable on this class",
    "DefaultConfig": "Config properties on this class should be saved to default configs, not user configs",
    "ComponentWrapperClass": "Actor is a lightweight wrapper around a single component",
    "ClassGroup": "List this class under the specified group in the editor",
    "DefaultToInstanced": "Indicates that references to this class default to instanced",
    "EditInlineNew": "Class can be constructed from editinline New button",
    "Meta": "Specify arbitrary meta tags",
};

export let ASClassSubSpecifiers : any = {
    // Note: subspecifier keys should be lowercase so they can be found consistently
    "meta": {
        "DisplayName": "Name to use to display in the editor",
    }
};

export let ASStructSpecifiers : any = {
    "Meta": "Specify arbitrary meta tags",
};

export let ASStructSubSpecifiers : any = {
    // Note: subspecifier keys should be lowercase so they can be found consistently
    "meta": {
        "DisplayName": "Name to use to display in the editor",
    }
};

export let ASFunctionSpecifiers : any = {
    "BlueprintCallable": "Function can be called from blueprint",
    "NotBlueprintCallable": "Function is not available in blueprint at all",
    "BlueprintPure": "Function is a pure node in blueprint without an exec pin",
    "BlueprintEvent": "Function can be overridden by child blueprint classes",
    "Unreliable": "Network function is sent as unreliable",
    "BlueprintOverride": "Override a BlueprintEvent in a parent script or C++ class",
    "CallInEditor": "Create a button in the details panel to call this function in the editor",
    "Category": "Category to list this under in the editor",
    "Keywords": "Keywords this can be found by in the editor",
    "ToolTip": "Tooltip to show in the editor",
    "DisplayName": "Name to use to display the function in the editor",
    "BlueprintProtected": "Treat this function as protected in blueprint, disallowing it from being called by non-child blueprints",
    "Meta": "Specify arbitrary meta tags",
};

export let ASFunctionSpecifiers_HAZE : any = {
    "NetFunction": "Function is a NetFunction",
    "CrumbFunction": "Function is a CrumbFunction",
    "DevFunction": "Function is a DevFunction",
};

export let ASFunctionSpecifiers_NO_HAZE : any = {
    "NetMulticast": "The function is executed both locally on the server, and replicated to all clients, regardless of the Actor's NetOwner",
    "Client": "The function is only executed on the only client if called from the server",
    "Server": "The function is only executed on the server if called from the owning client",
    "BlueprintAuthorityOnly": "This function will only execute from Blueprint code if running on a machine with network authority (a server, dedicated server, or single-player game)",
};

export let ASFunctionSubSpecifiers : any = {
    // Note: subspecifier keys should be lowercase so they can be found consistently
    "meta": {
        "NoSuperCall": "This function is allowed to not call its Super, suppress the warning",
        "AdvancedDisplay": "Determine which parameters to the function are considered Advanced",
    }
};