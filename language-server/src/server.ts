'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, Connection, TextDocuments, TextDocument,
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
	CompletionItemKind, SignatureHelp, Hover, DocumentSymbolParams, SymbolInformation,
	WorkspaceSymbolParams, Definition, ExecuteCommandParams, VersionedTextDocumentIdentifier, Location,
	TextDocumentSyncKind, SemanticTokensOptions, SemanticTokensLegend,
	SemanticTokensParams, SemanticTokens, SemanticTokensBuilder, ReferenceOptions, ReferenceParams,
	CodeLens, CodeLensParams, DocumentHighlight, DocumentHighlightKind, DocumentHighlightParams, DidOpenTextDocumentParams,
	RenameParams, WorkspaceEdit, ResponseError, PrepareRenameParams, Range, Position, Command
} from 'vscode-languageserver/node';

import { Socket } from 'net';

import * as scriptfiles from './as_parser';
import * as completion from './completion';
import * as parsedcompletion from './parsed_completion';
import * as typedb from './database';
import * as scriptreferences from './references';
import * as scriptoccurances from './highlight_occurances';
import * as scriptsemantics from './semantic_highlighting';
import * as scriptsymbols from './symbols';
import * as scriptdiagnostics from './ls_diagnostics';
import * as scriptlenses from './code_lenses';
import * as assets from './assets';
import * as fs from 'fs';
let glob = require('glob');

import { Message, MessageType, readMessages, buildGoTo, buildDisconnect, buildOpenAssets } from './unreal-buffers';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: Connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a connection to unreal
let unreal : Socket;

let ParseQueue : Array<scriptfiles.ASModule> = [];
let ParseQueueIndex = 0;
let LoadQueue : Array<scriptfiles.ASModule> = [];
let LoadQueueIndex = 0;
let PostProcessTypesQueue : Array<scriptfiles.ASModule> = [];
let PostProcessTypesQueueIndex = 0;

let ReceivingTypesTimeout : any = null;
let SetTypeTimeout = false;
let UnrealTypesTimedOut = false;

function connect_unreal() {
	if (unreal != null)
	{
		unreal.write(buildDisconnect());
		unreal.destroy();
	}
	unreal = new Socket;
	//connection.console.log('Connecting to unreal editor...');

	unreal.on("data", function(data : Buffer) {
		let messages : Array<Message> = readMessages(data);
		for (let msg of messages)
		{
			if (msg.type == MessageType.Diagnostics)
			{
				let diagnostics: Diagnostic[] = [];

				// Based on https://en.wikipedia.org/wiki/File_URI_scheme,
				// file:/// should be on both platforms, but on Linux the path
				// begins with / while on Windows it is omitted. So we need to
				// add it here to make sure both platforms are valid.
				let localpath = msg.readString();
				let filename = (localpath[0] == '/') ? ("file://" + localpath) : ("file:///" + localpath);
				//connection.console.log('Diagnostics received: '+filename);

				let msgCount = msg.readInt();
				for (let i = 0; i < msgCount; ++i)
				{
					let message = msg.readString();
					let line = msg.readInt();
					let char = msg.readInt();
					let isError = msg.readBool();
					let isInfo = msg.readBool();

					if (isInfo)
					{
						let hasExisting : boolean = false;
						for(let diag of diagnostics)
						{
							if (diag.range.start.line == line-1)
								hasExisting = true;
						}

						if(!hasExisting)
							continue;
					}

					let diagnosic: Diagnostic = {
						severity: isInfo ? DiagnosticSeverity.Information : (isError ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning),
						range: {
							start: { line: line-1, character: 0 },
							end: { line: line-1, character: 10000 }
						},
						message: message,
						source: 'as'
					};
					diagnostics.push(diagnosic);
				}

				scriptdiagnostics.UpdateCompileDiagnostics(filename, diagnostics);
			}
			else if(msg.type == MessageType.DebugDatabase)
			{
				let dbStr = msg.readString();
				let dbObj = JSON.parse(dbStr);
				typedb.AddPrimitiveTypes();
				typedb.AddTypesFromUnreal(dbObj);

				UnrealTypesTimedOut = false;
				if (ReceivingTypesTimeout)
					clearTimeout(ReceivingTypesTimeout);
				ReceivingTypesTimeout = setTimeout(DetectUnrealTypeListTimeout, 1000);
			}
			else if(msg.type == MessageType.DebugDatabaseFinished)
			{
				if (ReceivingTypesTimeout)
					clearTimeout(ReceivingTypesTimeout);
				typedb.FinishTypesFromUnreal();
			}
			else if(msg.type == MessageType.AssetDatabase)
			{
				let version = msg.readInt();
				if (version == 1)
				{
					let assetCount = msg.readInt();
					for (let i = 0; i < assetCount; i += 2)
					{
						let assetPath = msg.readString();
						let className = msg.readString();

						if (className.length == 0)
							assets.RemoveAsset(assetPath);
						else
							assets.AddAsset(assetPath, className);
					}
				}
			}
			else if(msg.type == MessageType.AssetDatabaseInit)
			{
				// Remove all old asset info from the database, we're receiving new stuff
				assets.ClearDatabase();
			}
			else if(msg.type == MessageType.AssetDatabaseFinished)
			{
			}
		}
	});

	unreal.on("error", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;
			setTimeout(connect_unreal, 5000);
		}
	});

	unreal.on("close", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;
			setTimeout(connect_unreal, 5000);
		}
	});

	unreal.connect(27099, "localhost", function()
	{
		//connection.console.log('Connection to unreal editor established.');
		setTimeout(function()
		{
			if (!unreal)
				return;
			let reqDb = Buffer.alloc(5);
			reqDb.writeUInt32LE(1, 0);
			reqDb.writeUInt8(MessageType.RequestDebugDatabase, 4);

			unreal.write(reqDb);
		}, 1000);
	});
}

connect_unreal();

// Create a simple text document manager. The text document manager
// supports full document sync only
// Make the text document manager listen on the connection
// for open, change and close text document events

let shouldSendDiagnosticRelatedInformation: boolean = false;
let RootPath : string = "";
let RootUri : string = "";

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize((_params): InitializeResult => {
	RootPath = _params.rootPath;
	RootUri = decodeURIComponent(_params.rootUri);
	shouldSendDiagnosticRelatedInformation = _params.capabilities && _params.capabilities.textDocument && _params.capabilities.textDocument.publishDiagnostics && _params.capabilities.textDocument.publishDiagnostics.relatedInformation;

	//connection.console.log("RootPath: "+RootPath);
	//connection.console.log("RootUri: "+RootUri+" from "+_params.rootUri);

	// Initially read and parse all angelscript files in the workspace
	glob(RootPath+"/**/*.as", null, function(err : any, files : any)
	{
		for (let file of files)
		{
			let uri = getFileUri(file);
			let asmodule = scriptfiles.GetOrCreateModule(getModuleName(uri), file, uri);
			LoadQueue.push(asmodule);
		}

		TickQueues();

		setTimeout(DetectUnrealConnectionTimeout, 20000);
	});

	return {
		capabilities: {
			// Tell the client that the server works in FULL text document sync mode
			textDocumentSync: TextDocumentSyncKind.Full,
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
			implementationProvider: true,
			referencesProvider: true,
			documentHighlightProvider: true,
			renameProvider: {
				prepareProvider: true
			},
			codeLensProvider: {
				resolveProvider: false
			},
			executeCommandProvider: {
				commands: ["angelscript.openAssets"],
			},
			semanticTokensProvider: <SemanticTokensOptions> {
				legend: <SemanticTokensLegend> {
					tokenTypes: scriptsemantics.SemanticTypeList.map(t => "as_"+t),
					tokenModifiers: [],
				},
				range: false,
				full: true,
			},
		}
	}
});

function DetectUnrealConnectionTimeout()
{
	UnrealTypesTimedOut = true;
}

function DetectUnrealTypeListTimeout()
{
	typedb.FinishTypesFromUnreal();
}

function TickQueues()
{
	if (LoadQueueIndex < LoadQueue.length)
	{
		for (let n = 0; n < 10 && LoadQueueIndex < LoadQueue.length; ++n, ++LoadQueueIndex)
		{
			if (!LoadQueue[LoadQueueIndex].loaded)
				scriptfiles.UpdateModuleFromDisk(LoadQueue[LoadQueueIndex]);
			ParseQueue.push(LoadQueue[LoadQueueIndex]);
		}
	}
	else if (LoadQueue.length != 0)
	{
		LoadQueue = [];
		LoadQueueIndex = 0;
	}
	else if (ParseQueueIndex < ParseQueue.length)
	{
		for (let n = 0; n < 5 && ParseQueueIndex < ParseQueue.length; ++n, ++ParseQueueIndex)
		{
			if (!ParseQueue[ParseQueueIndex].parsed)
				scriptfiles.ParseModule(ParseQueue[ParseQueueIndex]);
			PostProcessTypesQueue.push(ParseQueue[LoadQueueIndex]);
		}
	}
	else if (ParseQueue.length != 0)
	{
		ParseQueue = [];
		ParseQueueIndex = 0;
	}
	else if (PostProcessTypesQueueIndex < PostProcessTypesQueue.length)
	{
		if (CanResolveModules())
		{
			for (let n = 0; n < 5 && PostProcessTypesQueueIndex < PostProcessTypesQueue.length; ++n, ++PostProcessTypesQueueIndex)
			{
				if (!PostProcessTypesQueue[PostProcessTypesQueueIndex].typesPostProcessed)
					scriptfiles.PostProcessModuleTypes(PostProcessTypesQueue[PostProcessTypesQueueIndex]);
			}
		}
	}
	else if (PostProcessTypesQueue.length != 0)
	{
		PostProcessTypesQueue = [];
		PostProcessTypesQueueIndex = 0;
	}

	if (LoadQueue.length != 0 || ParseQueue.length != 0 || PostProcessTypesQueue.length != 0)
		setTimeout(TickQueues, 1);
}

function CanResolveModules()
{
	return typedb.HasTypesFromUnreal();
}

scriptdiagnostics.OnDiagnosticsChanged( function (uri : string, diagnostics : Array<Diagnostic>){
	connection.sendDiagnostics({ "uri": uri, "diagnostics": diagnostics });
});

connection.onDidChangeWatchedFiles((_change) => {
	for(let change of _change.changes)
	{
		let module = scriptfiles.GetOrCreateModule(getModuleName(change.uri), getPathName(change.uri), change.uri);
		if (module)
		{
			scriptfiles.UpdateModuleFromDisk(module);
			scriptfiles.ParseModule(module);

			if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
			{
				scriptfiles.PostProcessModuleTypes(module);
				scriptfiles.ResolveModule(module);
				scriptdiagnostics.UpdateScriptModuleDiagnostics(module);
			}
		}
	}
});

function GetAndParseModule(uri : string) : scriptfiles.ASModule
{
	let asmodule = scriptfiles.GetModuleByUri(uri);
	if (!asmodule)
		return null;

	scriptfiles.ParseModuleAndDependencies(asmodule);
	if (CanResolveModules())
	{
		scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
		scriptfiles.ResolveModule(asmodule);
	}
	return asmodule;
}

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
	if (!asmodule)
		return null;
	let completions = parsedcompletion.Complete(asmodule, _textDocumentPosition.position);
	return completions;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return parsedcompletion.Resolve(item);
});

connection.onSignatureHelp((_textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
	let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
	if (!asmodule)
		return null;
	let help = parsedcompletion.Signature(asmodule, _textDocumentPosition.position);
	return help;
});

connection.onDefinition((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
	let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
	if (!asmodule)
		return null;
	if (!asmodule.resolved)
		return null;
	return scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
});

connection.onImplementation((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
	let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
	if (!asmodule)
		return null;
	if (!asmodule.resolved)
		return null;
	let definition = scriptsymbols.GetDefinition(asmodule, _textDocumentPosition.position);
	if (definition)
		return definition;

	let cppSymbol = scriptsymbols.GetCppSymbol(asmodule, _textDocumentPosition.position);
	if (cppSymbol)
	{
		// the unreal editor with the type and symbol we've resolved that we want.
		if (unreal)
			unreal.write(buildGoTo(cppSymbol[0], cppSymbol[1]));
	}

	return null;
});

connection.onHover((_textDocumentPosition: TextDocumentPositionParams): Hover => {
	let asmodule = GetAndParseModule(_textDocumentPosition.textDocument.uri);
	if (!asmodule)
		return null;
	if (!asmodule.resolved)
		return null;
	return scriptsymbols.GetHover(asmodule, _textDocumentPosition.position);
});

connection.onDocumentSymbol((_params : DocumentSymbolParams) : SymbolInformation[] => {
	return completion.DocumentSymbols(_params.textDocument.uri);
});

connection.onWorkspaceSymbol((_params : WorkspaceSymbolParams) : SymbolInformation[] => {
	return completion.WorkspaceSymbols(_params.query);
});

connection.onReferences(function (params : ReferenceParams) : Location[]
{
	if (!CanResolveModules())
		return null;
	return scriptreferences.FindReferences(params.textDocument.uri, params.position);
});

connection.onPrepareRename(function (params : PrepareRenameParams) : Range | ResponseError<void>
{
	let result : Range | ResponseError<void> = null;
	if (!CanResolveModules())
		result = new ResponseError<void>(0, "Please wait for all script parsing to finish...");
	else
		result = scriptreferences.PrepareRename(params.textDocument.uri, params.position);

	// TODO: Remove this when upgrading vscode-languageclient library to latest version.
	// Right now errors here will cause debug handling on the client, which we don't want.
	if (result instanceof ResponseError)
		return null;
	// END TODO

	return result;
});

connection.onRenameRequest(function (params : RenameParams) : WorkspaceEdit
{
	if (!CanResolveModules())
		return null;

	let result = scriptreferences.PerformRename(params.textDocument.uri, params.position, params.newName);
	if (!result)
		return null;

	let workspaceEdit : WorkspaceEdit = {};
	workspaceEdit.changes = {};
	for (let [uri, edits] of result)
		workspaceEdit.changes[uri] = edits;

	return workspaceEdit;
});

connection.onDocumentHighlight(function (params : DocumentHighlightParams) : Array<DocumentHighlight>
{
	if (!CanResolveModules())
		return null;
	return scriptoccurances.HighlightOccurances(params.textDocument.uri, params.position);
})

connection.onCodeLens(function (params : CodeLensParams) : CodeLens[]
{
	if (!CanResolveModules())
		return null;
	let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
	if (!asmodule)
		return null;

	scriptfiles.ParseModuleAndDependencies(asmodule);
	scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
	scriptfiles.ResolveModule(asmodule);
	return scriptlenses.ComputeCodeLenses(asmodule);
})

connection.onCodeLensResolve(function (lens : CodeLens) : CodeLens{
	return lens;
});

connection.onExecuteCommand(function (params : ExecuteCommandParams)
{
	if (params.command == "angelscript.openAssets")
	{
		if (params.arguments && params.arguments[0])
		{
			let references = assets.GetAssetsImplementing(params.arguments[0]);
			if (!references || references.length == 0)
				return;

			unreal.write(buildOpenAssets(references));
		}
	}
});

function TryResolveSymbols(asmodule : scriptfiles.ASModule) : SemanticTokens | null
{
	if (CanResolveModules())
	{
		if (!asmodule)
			return null;
		scriptfiles.ParseModuleAndDependencies(asmodule);
		scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
		scriptfiles.ResolveModule(asmodule);
		return scriptsemantics.HighlightSymbols(asmodule);
	}
	else
	{
		return null;
	}
}

connection.languages.semanticTokens.on(function(params : SemanticTokensParams) : SemanticTokens | Thenable<SemanticTokens>
{
	let asmodule = scriptfiles.GetModuleByUri(params.textDocument.uri);
	let result = TryResolveSymbols(asmodule);
	if (result)
		return result;

	function timerFunc(resolve : any, reject : any, triesLeft : number) {
		if (triesLeft <= 0 || UnrealTypesTimedOut)
			return resolve(null);
		let result = TryResolveSymbols(asmodule);
		if (result)
			return resolve(result);
		setTimeout(function() { timerFunc(resolve, reject, triesLeft-1); }, 100);
	}
	let promise = new Promise<SemanticTokens>(function(resolve, reject)
	{
		timerFunc(resolve, reject, 50);
	});
	return promise;
});

function getPathName(uri : string) : string
{
	let pathname = decodeURIComponent(uri.replace("file://", "")).replace(/\//g, "\\");
	if(pathname.startsWith("\\"))
		pathname = pathname.substr(1);

	return pathname;
}

function getFileUri(pathname : string) : string
{
	let uri = pathname.replace(/\\/g, "/");
	if(!uri.startsWith("/"))
		uri = "/" + uri;

	return ("file://" + uri);
}

function getModuleName(uri : string) : string
{
	let modulename = decodeURIComponent(uri);
	modulename = modulename.replace(RootUri, "");
	modulename = modulename.replace(".as", "");
	modulename = modulename.replace(/\//g, ".");

	if (modulename[0] == '.')
		modulename = modulename.substr(1);

	return modulename;
}

connection.onRequest("angelscript/getModuleForSymbol", (...params: any[]) : string => {
	let pos : TextDocumentPositionParams = params[0];

	let def = completion.GetDefinition(pos);
	if (def == null)
	{
		connection.console.log(`Definition not found`);
		return "";
	}

	let defArr = def as Location[];

	let uri = defArr[0].uri;
	let module = getModuleName(uri);

	connection.console.log(`Definition found at ${module}`);

	return module;
});
	
 connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.

	if (params.contentChanges.length == 0)
		return;

	let content = params.contentChanges[0].text;
	let uri = params.textDocument.uri;
	let modulename = getModuleName(uri);
	
	let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
	scriptfiles.UpdateModuleFromContent(asmodule, content);
	scriptfiles.ParseModuleAndDependencies(asmodule);
	if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
	{
		scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
		scriptfiles.ResolveModule(asmodule);
		scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
	}
 });

 connection.onDidOpenTextDocument(function (params : DidOpenTextDocumentParams)
 {
	let uri = params.textDocument.uri;
	let modulename = getModuleName(uri);

	let asmodule = scriptfiles.GetOrCreateModule(modulename, getPathName(uri), uri);
	scriptfiles.ParseModuleAndDependencies(asmodule);
	if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
	{
		scriptfiles.PostProcessModuleTypesAndDependencies(asmodule);
		scriptfiles.ResolveModule(asmodule);
		scriptdiagnostics.UpdateScriptModuleDiagnostics(asmodule);
	}
 });

// Listen on the connection
connection.listen();