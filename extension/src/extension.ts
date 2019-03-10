/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { workspace, ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Definition, TransportKind, Diagnostic, RequestType, ExecuteCommandRequest, ExecuteCommandParams, ExecuteCommandRegistrationOptions, TextDocumentPositionParams, ImplementationRequest, TypeDefinitionRequest } from 'vscode-languageclient';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { ASDebugSession } from './debug';
import * as Net from 'net';
import { ClientRequest } from 'http';
let copyPaste = require("copy-paste");

const EMBED_DEBUG_ADAPTER = true;

const GetModuleForSymbolRequest: RequestType<TextDocumentPositionParams, string, void, void> = new RequestType<TextDocumentPositionParams, string, void, void>('angelscript/getModuleForSymbol');

export function activate(context: ExtensionContext) {

	// The server is implemented in node
	let serverModule = context.asAbsolutePath(path.join('extension', 'server', 'server.js'));
	// The debug options for the server
	let debugOptions = { execArgv: ["--nolazy", "--inspect=6009"] };
	
	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run : { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	}
	
	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{scheme: 'file', language: 'angelscript'}],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.as')
		}
	}

	console.log("Activate angelscript extension");
	
	// Create the language client and start the client.
	let client = new LanguageClient('angelscriptLanguageServer', 'Angelscript Language Server', serverOptions, clientOptions)
	let disposable = client.start();
	
	// Push the disposable to the context's subscriptions so that the 
	// client can be deactivated on extension deactivation
	context.subscriptions.push(disposable);

	// register a configuration provider for 'mock' debug type
	const provider = new ASConfigurationProvider()
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('angelscript', provider));
	context.subscriptions.push(provider);

	// Register the 'copy import path' command
	let copyImportPath = vscode.commands.registerCommand('angelscript.copyImportPath', (selectedFile : any) => {
		let relPath = vscode.workspace.asRelativePath(selectedFile, false).trim();

		let extIndex = relPath.indexOf(".as");
		if (extIndex != -1)
			relPath = relPath.substr(0, extIndex);
		relPath = relPath.replace(/[\/\\]/g, ".");

		copyPaste.copy(relPath);
	});

	context.subscriptions.push(copyImportPath);

	// Register 'Go To Symbol'
	let goToSymbol = vscode.commands.registerCommand('angelscript.goToSymbol', (location : any) => {
		vscode.commands.executeCommand("editor.action.goToImplementation", location);
	});

	context.subscriptions.push(goToSymbol);

	// Register 'Add Import To'
	let addImportTo = vscode.commands.registerCommand('angelscript.addImportTo', (location : any) => {
		var editor = vscode.window.activeTextEditor;
		
		var params: TextDocumentPositionParams = {
			position: editor.selection.anchor,
			textDocument: { uri: editor.document.uri.toString(false) }
		};
		
		client.sendRequest(GetModuleForSymbolRequest, params).then((result: string) => {
			if (result == "")
			{
				// Find word under cursor
				let wordRange = editor.document.getWordRangeAtPosition(editor.selection.anchor);
				let word = editor.document.getText(wordRange);

				vscode.window.showErrorMessage(`The symbol '${word}' was not found`);
				return;
			}
			else
			{
				// Module found!
				let lines : string[] = editor.document.getText().split("\n");
				let lastImportLine = 0;

				// Find if the module is already imported, or the position to append the new import
				for(let i = 0; i < lines.length; ++i)
				{
					if (lines[i].includes("import "+result+";"))
					{
						console.log(`${result} is already included`);
						vscode.window.showInformationMessage(`'${result}' is already imported`);
						return;
					}
					
					if (lines[i].includes("import"))					
					{
						lastImportLine = i + 1;
						continue;
					}
					else if (lines[i].trim().length != 0)
					{
						// Break if we find a line that's not empty, signalling the end of the import-block
						break;
					}
				}

				editor.edit((edit: vscode.TextEditorEdit) => {
					edit.insert(new vscode.Position(lastImportLine, 0), `import ${result};\n`);
				});
			}
		});
	});

	context.subscriptions.push(addImportTo);
	console.log("Done activating angelscript extension");
}

class ASConfigurationProvider implements vscode.DebugConfigurationProvider {

	private _server?: Net.Server;

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration>
	{
		if (!config.type && !config.request && !config.name)
		{
			const editor = vscode.window.activeTextEditor;
			if (editor && editor.document.languageId === 'angelscript' )
			{
				config.type = 'angelscript';
				config.name = 'Debug Angelscript';
				config.request = 'launch';
				config.stopOnEntry = true;
			}
		}

		if (EMBED_DEBUG_ADAPTER) {
			// start port listener on launch of first debug session
			if (!this._server) {

				// start listening on a random port
				this._server = Net.createServer(socket => {
					const session = new ASDebugSession();
					session.setRunAsServer(true);
					session.start(<NodeJS.ReadableStream>socket, socket);
				}).listen(0);
			}

			// make VS Code connect to debug server instead of launching debug adapter
			config.debugServer = this._server.address().port;
		}

		return config;
	}

	dispose() {
		if (this._server) {
			this._server.close();
		}
	}
}