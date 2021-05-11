import * as parser from './as_parser';
import * as glob from 'glob';
import * as fs from 'fs';

import { performance } from "perf_hooks";

let as_modules : parser.ASModule[] = [];
glob(process.argv[2]+"\\**\\*.as", null, function(err : any, files : any)
{
    for (let filename of files)
    //let filename = "D:\\Split\\Split\\Script\\Core\\Camera\\Modifiers\\CameraImpulseSettings.as";
    //let filename = "D:\\Nuts\\Nuts\\Script\\Cake\\Environment\\Sky.as";
    {
        as_modules.push(parser.GetOrCreateModule(filename, filename, filename));
    }

    for (let asmodule of as_modules)
        parser.UpdateModuleFromDisk(asmodule);

    let startTime = performance.now()
    for (let asmodule of as_modules)
    {
        parser.ParseModule(asmodule, true);
        /*for (let statement of asmodule.rootscope.scopes[0].statements)
            console.dir(statement, {depth: 0});
        ParseAllStatements(asmodule.rootscope);
        return;*/
    }

    console.log("ParseModule took " + (performance.now() - startTime) + " ms")

    startTime = performance.now()
    for (let asmodule of as_modules)
    {
        //console.log("module: "+asmodule.filename);
        parser.ResolveModule(asmodule);
    }
    console.log("ResolveModule " + (performance.now() - startTime) + " ms")
});