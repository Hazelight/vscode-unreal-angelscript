'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_languageserver_1 = require("vscode-languageserver");
const net_1 = require("net");
const scriptfiles = require("./as_file");
const completion = require("./completion");
const typedb = require("./database");
const fs = require("fs");
let glob = require('glob');
const unreal_buffers_1 = require("./unreal-buffers");
// Create a connection for the server. The connection uses Node's IPC as a transport
let connection = vscode_languageserver_1.createConnection(new vscode_languageserver_1.IPCMessageReader(process), new vscode_languageserver_1.IPCMessageWriter(process));
// Create a connection to unreal
let unreal;
function connect_unreal() {
    if (unreal != null) {
        unreal.write(unreal_buffers_1.buildDisconnect());
        unreal.destroy();
    }
    unreal = new net_1.Socket;
    //connection.console.log('Connecting to unreal editor...');
    unreal.connect(27099, "localhost", function () {
        //connection.console.log('Connection to unreal editor established.');
        let reqDb = Buffer.alloc(5);
        reqDb.writeUInt32LE(1, 0);
        reqDb.writeUInt8(unreal_buffers_1.MessageType.RequestDebugDatabase, 4);
        unreal.write(reqDb);
    });
    unreal.on("data", function (data) {
        let messages = unreal_buffers_1.readMessages(data);
        for (let msg of messages) {
            if (msg.type == unreal_buffers_1.MessageType.Diagnostics) {
                let diagnostics = [];
                let filename = "file:///" + msg.readString();
                //connection.console.log('Diagnostics received: '+filename);
                let msgCount = msg.readInt();
                for (let i = 0; i < msgCount; ++i) {
                    let message = msg.readString();
                    let line = msg.readInt();
                    let char = msg.readInt();
                    let isError = msg.readBool();
                    let isInfo = msg.readBool();
                    if (isInfo) {
                        let hasExisting = false;
                        for (let diag of diagnostics) {
                            if (diag.range.start.line == line - 1)
                                hasExisting = true;
                        }
                        if (!hasExisting)
                            continue;
                    }
                    let diagnosic = {
                        severity: isInfo ? vscode_languageserver_1.DiagnosticSeverity.Information : (isError ? vscode_languageserver_1.DiagnosticSeverity.Error : vscode_languageserver_1.DiagnosticSeverity.Warning),
                        range: {
                            start: { line: line - 1, character: 0 },
                            end: { line: line - 1, character: 10000 }
                        },
                        message: message,
                        source: 'as'
                    };
                    diagnostics.push(diagnosic);
                }
                connection.sendDiagnostics({ uri: filename, diagnostics });
            }
            else if (msg.type == unreal_buffers_1.MessageType.DebugDatabase) {
                let dbStr = msg.readString();
                //connection.console.log('DATABASE: '+dbStr);
                let dbObj = JSON.parse(dbStr);
                typedb.AddPrimitiveTypes();
                typedb.AddTypesFromUnreal(dbObj);
            }
        }
    });
    unreal.on("error", function () {
        if (unreal != null) {
            unreal.destroy();
            unreal = null;
            setTimeout(connect_unreal, 5000);
        }
    });
    unreal.on("close", function () {
        if (unreal != null) {
            unreal.destroy();
            unreal = null;
            setTimeout(connect_unreal, 5000);
        }
    });
}
connect_unreal();
// Create a simple text document manager. The text document manager
// supports full document sync only
let documents = new vscode_languageserver_1.TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);
let shouldSendDiagnosticRelatedInformation = false;
let RootPath = "";
let RootUri = "";
// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params) => {
    RootPath = _params.rootPath;
    RootUri = decodeURIComponent(_params.rootUri);
    shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;
    //connection.console.log("RootPath: "+RootPath);
    //connection.console.log("RootUri: "+RootUri+" from "+_params.rootUri);
    // Read all files in the workspace before we complete initialization, so we have completion on everything
    glob(RootPath + "/**/*.as", null, function (err, files) {
        let modules = [];
        for (let file of files) {
            let asfile = UpdateFileFromDisk(getFileUri(file));
            modules.push(asfile);
        }
        for (let module of modules)
            completion.ResolveAutos(module.rootscope);
        for (let module of modules)
            scriptfiles.PostProcessModule(module.modulename);
    });
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true,
                triggerCharacters: [".", ":"],
            },
            signatureHelpProvider: {
                triggerCharacters: ["(", ")", ","],
            },
            hoverProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            definitionProvider: true,
            implementationProvider: true
        }
    };
});
connection.onDidChangeWatchedFiles((_change) => {
    for (let change of _change.changes) {
        let file = UpdateFileFromDisk(change.uri);
        completion.ResolveAutos(file.rootscope);
        scriptfiles.PostProcessModule(file.modulename);
    }
});
// This handler provides the initial list of the completion items.
connection.onCompletion((_textDocumentPosition) => {
    let completions = completion.Complete(_textDocumentPosition);
    //connection.console.log(JSON.stringify(completions));
    return completions;
});
// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item) => {
    return completion.Resolve(item);
});
connection.onSignatureHelp((_textDocumentPosition) => {
    return completion.Signature(_textDocumentPosition);
});
connection.onDefinition((_textDocumentPosition) => {
    let compl = completion.GetCompletionTypeAndMember(_textDocumentPosition);
    if (!compl)
        return null;
    let [typename, symbolname] = compl;
    let definition = completion.GetDefinition(_textDocumentPosition);
    if (definition)
        return definition;
    return null;
});
connection.onImplementation((_textDocumentPosition) => {
    let compl = completion.GetCompletionTypeAndMember(_textDocumentPosition);
    if (!compl)
        return null;
    let [typename, symbolname] = compl;
    //connection.console.log("Looking up Symbol (Implementation): ["+typename+", "+symbolname+"]");
    let definition = completion.GetDefinition(_textDocumentPosition);
    if (definition)
        return definition;
    // We didn't find a definition in angelscript, let's see what happens if we poke
    // the unreal editor with the type and symbol we've resolved that we want.
    if (unreal)
        unreal.write(unreal_buffers_1.buildGoTo(completion.GetUnrealTypeFor(typename), symbolname));
    return null;
});
connection.onHover((_textDocumentPosition) => {
    return completion.Hover(_textDocumentPosition);
});
connection.onDocumentSymbol((_params) => {
    return completion.DocumentSymbols(_params.textDocument.uri);
});
connection.onWorkspaceSymbol((_params) => {
    return completion.WorkspaceSymbols(_params.query);
});
function UpdateFileFromDisk(uri) {
    let filename = getPathName(uri);
    let modulename = getModuleName(uri);
    //connection.console.log("Update from disk: "+uri+" = "+modulename+" @ "+filename);
    let content = "";
    if (fs.existsSync(filename))
        content = fs.readFileSync(filename, 'utf8');
    return scriptfiles.UpdateContent(uri, modulename, content);
}
function getPathName(uri) {
    let pathname = decodeURIComponent(uri.replace("file://", "")).replace(/\//g, "\\");
    if (pathname.startsWith("\\"))
        pathname = pathname.substr(1);
    return pathname;
}
function getFileUri(pathname) {
    let uri = pathname.replace(/\\/g, "/");
    if (!uri.startsWith("/"))
        uri = "/" + uri;
    return ("file://" + uri);
}
function getModuleName(uri) {
    let modulename = decodeURIComponent(uri);
    modulename = modulename.replace(RootUri, "");
    modulename = modulename.replace(".as", "");
    modulename = modulename.replace(/\//g, ".");
    if (modulename[0] == '.')
        modulename = modulename.substr(1);
    return modulename;
}
/*connection.onDidOpenTextDocument((params) => {
    let content = params.textDocument.getText();
let uri = params.textDocument.uri;
let modulename = getModuleName(uri);

scriptfiles.UpdateContent(uri, modulename, content);
});*/
documents.onDidChangeContent((change) => {
    let content = change.document.getText();
    let uri = change.document.uri;
    let modulename = getModuleName(uri);
    //connection.console.log("Update from CODE: "+uri);
    let file = scriptfiles.UpdateContent(uri, modulename, content, change.document);
    completion.ResolveAutos(file.rootscope);
    scriptfiles.PostProcessModule(modulename);
});
connection.onRequest("angelscript/getModuleForSymbol", (...params) => {
    let pos = params[0];
    let def = completion.GetDefinition(pos);
    if (def == null) {
        connection.console.log(`Definition not found`);
        return "";
    }
    let defArr = def;
    let uri = defArr[0].uri;
    let module = getModuleName(uri);
    connection.console.log(`Definition found at ${module}`);
    return module;
});
// connection.onDidChangeTextDocument((params) => {
// The content of a text document did change in VSCode.
// params.uri uniquely identifies the document.
// params.contentChanges describe the content changes to the document.
//connection.console.log(`${params.textDocument.uri} changed: ${JSON.stringify(params.contentChanges)}`);
// 	connection.console.log("9");
// });
/*
connection.onDidCloseTextDocument((params) => {
    // A text document got closed in VSCode.
    // params.uri uniquely identifies the document.
    connection.console.log(`${params.textDocument.uri} closed.`);
});
*/
// Listen on the connection
connection.listen();
//# sourceMappingURL=server.js.map