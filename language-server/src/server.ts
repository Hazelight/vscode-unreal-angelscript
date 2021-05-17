'use strict';

import {
	IPCMessageReader, IPCMessageWriter, createConnection, Connection, TextDocuments, TextDocument,
	Diagnostic, DiagnosticSeverity, InitializeResult, TextDocumentPositionParams, CompletionItem,
	CompletionItemKind, SignatureHelp, Hover, DocumentSymbolParams, SymbolInformation,
	WorkspaceSymbolParams, Definition, ExecuteCommandParams, VersionedTextDocumentIdentifier, Location,
	TextDocumentSyncKind, DocumentHighlight, SemanticTokensOptions, SemanticTokensLegend,
	SemanticTokensParams, SemanticTokens, SemanticTokensBuilder, ReferenceOptions, ReferenceParams,
	CodeLens, CodeLensParams
} from 'vscode-languageserver/node';

import { Socket } from 'net';

import * as scriptfiles from './as_parser';
import * as completion from './completion';
import * as typedb from './database';
import * as scriptreferences from './references';
import * as fs from 'fs';
let glob = require('glob');

import { Message, MessageType, readMessages, buildGoTo, buildDisconnect } from './unreal-buffers';

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: Connection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a connection to unreal
let unreal : Socket;

let ParseQueue : Array<scriptfiles.ASModule> = [];
let ParseQueueIndex = 0;
let LoadQueue : Array<scriptfiles.ASModule> = [];
let LoadQueueIndex = 0;

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
				// We set this to true here, because the first Diagnostics message
				// indicates we no longer have any DebugDatabase messages coming
				typedb.FinishTypesFromUnreal();

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

				connection.sendDiagnostics({ uri: filename, diagnostics });
			}
			else if(msg.type == MessageType.DebugDatabase)
			{
				let dbStr = msg.readString();
				let dbObj = JSON.parse(dbStr);
				typedb.AddPrimitiveTypes();
				typedb.AddTypesFromUnreal(dbObj);
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

let SemanticTypes : any = {};
let SemanticTypeList : Array<string> = [
	"typename", "template_base_type", "invalid",
];

for (let i = 0, Count = SemanticTypeList.length; i < Count; ++i)
	SemanticTypes[SemanticTypeList[i]] = i;

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
			semanticTokensProvider: <SemanticTokensOptions> {
				legend: <SemanticTokensLegend> {
					tokenTypes:SemanticTypeList.map(t => "as_"+t),
					tokenModifiers: [],
				},
				range: false,
				full: true,
			},
		}
	}
});

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
		}
	}
	else if (ParseQueue.length != 0)
	{
		ParseQueue = [];
		ParseQueueIndex = 0;
	}

	if (LoadQueue.length != 0 || ParseQueue.length != 0)
		setTimeout(TickQueues, 1);
}

function CanResolveModules()
{
	return typedb.HasTypesFromUnreal();
}

connection.onDidChangeWatchedFiles((_change) => {
	for(let change of _change.changes)
	{
		let module = scriptfiles.GetOrCreateModule(getModuleName(change.uri), getPathName(change.uri), change.uri);
		if (module)
		{
			scriptfiles.UpdateModuleFromDisk(module);
			scriptfiles.ParseModule(module);

			if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
				scriptfiles.ResolveModule(module);
		}
	}
});

connection.onCompletion((_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
	let completions = completion.Complete(_textDocumentPosition);
	return completions;
});

connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	return completion.Resolve(item);
});

connection.onSignatureHelp((_textDocumentPosition: TextDocumentPositionParams): SignatureHelp => {
	let help = completion.Signature(_textDocumentPosition);
	return help;
});

connection.onDefinition((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
	let compl = completion.GetCompletionTypeAndMember(_textDocumentPosition);
	if (!compl)
		return null;

	let [typename, symbolname] = compl;
	
	let definition = completion.GetDefinition(_textDocumentPosition);
	if (definition)
		return definition;

	return null;
});

connection.onImplementation((_textDocumentPosition: TextDocumentPositionParams): Definition | null => {
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
	if(unreal)
		unreal.write(buildGoTo(completion.GetUnrealTypeFor(typename), symbolname));

	return null;
});

connection.onHover((_textDocumentPosition: TextDocumentPositionParams): Hover => {
	return completion.GetHover(_textDocumentPosition);
});

connection.onDocumentSymbol((_params : DocumentSymbolParams) : SymbolInformation[] => {
	return completion.DocumentSymbols(_params.textDocument.uri);
});

connection.onWorkspaceSymbol((_params : WorkspaceSymbolParams) : SymbolInformation[] => {
	return completion.WorkspaceSymbols(_params.query);
});

connection.onReferences(function (params : ReferenceParams) : Location[]
{
	return scriptreferences.FindReferences(params.textDocument.uri, params.position);
});

connection.onCodeLens(function (params : CodeLensParams) : CodeLens[]
{
	return null;
})

function TryResolveSymbols(asmodule : scriptfiles.ASModule) : SemanticTokens | null
{
	if (CanResolveModules())
	{
		let builder = new SemanticTokensBuilder();
		if (!asmodule)
			return null;
		scriptfiles.ParseModuleAndDependencies(asmodule);
		scriptfiles.ResolveModule(asmodule);
		HighlightSymbols(asmodule, builder);

		return builder.build();
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

	function timerFunc(resolve : any, reject : any) {
		let result = TryResolveSymbols(asmodule);
		if (result)
			return resolve(result);
		setTimeout(f => timerFunc(resolve, reject), 100);
	}
	let promise = new Promise<SemanticTokens>(timerFunc);
	return promise;
});

function HighlightSymbols(asmodule : scriptfiles.ASModule, builder : SemanticTokensBuilder)
{
	for (let symbol of asmodule.symbols)
	{
		let pos = asmodule.getPosition(symbol.start);
		let length = symbol.end - symbol.start;

		let type = -1;
		switch (symbol.type)
		{
			case scriptfiles.ASSymbolType.UnknownError:
				type = SemanticTypes.invalid;
			break;
			case scriptfiles.ASSymbolType.Typename:
				type = SemanticTypes.typename;
			break;
			case scriptfiles.ASSymbolType.TemplateBaseType:
				type = SemanticTypes.template_base_type;
			break;
		}

		if (type == -1)
			continue;

		let modifiers = 0;
		builder.push(pos.line, pos.character, length, type, modifiers);
	}
}

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
	scriptfiles.ParseModule(asmodule);
	if (CanResolveModules() && ParseQueue.length == 0 && LoadQueue.length == 0)
		scriptfiles.ResolveModule(asmodule);
 });

// Listen on the connection
connection.listen();