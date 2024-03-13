let AssetPathToClass = new Map<string, string>();
let ClassToReferencingAssets = new Map<string, Array<string>>();

export function AddAsset(assetPath : string, className: string)
{
    let prevClass = AssetPathToClass.get(assetPath);
    if (prevClass == className)
        return;

    AssetPathToClass.set(assetPath, className);
    let list = ClassToReferencingAssets.get(className);
    if (!list)
    {
        list = new Array<string>();
        ClassToReferencingAssets.set(className, list);
    }
    list.push(assetPath);
}

export function RemoveAsset(assetPath : string)
{
    let prevClass = AssetPathToClass.get(assetPath);
    if (!prevClass)
        return;

    AssetPathToClass.delete(assetPath);
    let list = ClassToReferencingAssets.get(prevClass);
    if (list)
    {
        let index = list.indexOf(assetPath);
        if (index != -1)
            list.splice(index, 1);
    }
}

export function GetAssetsImplementing(className : string) : Array<string>
{
    let references = ClassToReferencingAssets.get(className);
    if (!references && (className[0] == 'U' || className[0] == 'A'))
        references = ClassToReferencingAssets.get(className.substring(1));
    return references;
}

export function GetShortAssetName(assetPath : string)
{
    let index = assetPath.lastIndexOf('/');
    if (index == -1)
        return assetPath;
    return assetPath.substr(index+1);
}

export function ClearDatabase()
{
    AssetPathToClass.clear();
    ClassToReferencingAssets.clear();
}
