/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as path from 'path';

import { workspace, ExtensionContext, TextDocument, Range, InlayHint } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, Definition, TransportKind, Diagnostic, RequestType, ExecuteCommandRequest, ExecuteCommandParams, ExecuteCommandRegistrationOptions, TextDocumentPositionParams, ImplementationRequest, TypeDefinitionRequest, TextDocumentItem } from 'vscode-languageclient/node';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import { ASDebugSession } from './debug';
import * as Net from 'net';
import { ClientRequest } from 'http';
let copyPaste = require("copy-paste");

const EMBED_DEBUG_ADAPTER = true;

const GetModuleForSymbolRequest: RequestType<TextDocumentPositionParams, string, void> = new RequestType<TextDocumentPositionParams, string, void>('angelscript/getModuleForSymbol');
const ProvideInlineValuesRequest: RequestType<TextDocumentPositionParams, any[], void> = new RequestType<TextDocumentPositionParams, any[], void>('angelscript/provideInlineValues');

export function activate(context: ExtensionContext) {

    // The server is implemented in node
    let serverModule = context.asAbsolutePath(path.join('language-server', 'out', 'server.js'));
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
            fileEvents: workspace.createFileSystemWatcher('**/*.as'),
            configurationSection: "UnrealAngelscript",
        }
    }

    console.log("Activate angelscript extension");

    // Create the language client and start the client.
    let client = new LanguageClient('angelscriptLanguageServer', 'Angelscript Language Server', serverOptions, clientOptions)
    let started_client = client.start();

    // register a configuration provider for 'mock' debug type
    const provider = new ASConfigurationProvider();
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('angelscript', provider));
    context.subscriptions.push(provider);

    let inlineValuesProvider = new ASInlineValuesProvider();
    inlineValuesProvider.languageClient = client;
    context.subscriptions.push(vscode.languages.registerInlineValuesProvider('angelscript', inlineValuesProvider));

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
            if (result == "-")
            {
                return
            }
            else if (result == "")
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
                let hasEmptyLine = false;
                let importRegex = /\s*import\s+([A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*);/;

                // Find if the module is already imported, or the position to append the new import
                for(let i = 0; i < lines.length; ++i)
                {
                    let match = importRegex.exec(lines[i]);
                    if (match)
                    {
                        if (match[1] == result)
                        {
                            console.log(`${result} is already included`);
                            vscode.window.showInformationMessage(`'${result}' is already imported`);
                            return;
                        }

                        lastImportLine = i + 1;
                        hasEmptyLine = false;
                    }
                    else if (lines[i].trim().length != 0)
                    {
                        // Break if we find a line that's not empty, signalling the end of the import-block
                        break;
                    }
                    else
                    {
                        hasEmptyLine = true;
                    }
                }

                let insertString = "import "+result+";\n";
                if (!hasEmptyLine)
                    insertString += "\n";

                editor.edit((edit: vscode.TextEditorEdit) => {
                    edit.insert(new vscode.Position(lastImportLine, 0), insertString);
                });
            }
        });
    });

    context.subscriptions.push(addImportTo);

    let quickOpenImport = vscode.commands.registerCommand('angelscript.quickOpenImport', () => {
        let activeEditor = vscode.window.activeTextEditor;
        if (activeEditor != null) {
            let line_number = activeEditor.selection.active.line;
            let text_line = activeEditor.document.lineAt(line_number);
            let text = text_line.text.split(' ');
            if (text.length != 0 && text[0] === "import") {
                let path = text[1].slice(0, -1).split('.').join('\\');
                vscode.commands.executeCommand('workbench.action.quickOpen', path);
                return;
            }
        }
        vscode.commands.executeCommand('workbench.action.quickOpen', '');
    });
    context.subscriptions.push(quickOpenImport);

    let completionParen = vscode.commands.registerCommand('angelscript.paren', () =>
    {
        let activeEditor = vscode.window.activeTextEditor;
        if (activeEditor != null)
        {
            let line_number = activeEditor.selection.active.line;
            let text_line = activeEditor.document.lineAt(line_number);

            let char_number = activeEditor.selection.active.character;
            let char = text_line.text[char_number-1];

            if (char == '(')
            {
                // Inserted a opening bracket straight away, ignore anything
                return;
            }
            else if (char == '.')
            {
                // Replace the single dot from the commit character with a call
                activeEditor.edit((edit: vscode.TextEditorEdit) => {
                        edit.insert(new vscode.Position(line_number, char_number-1), "()");
                    },
                    {
                        undoStopBefore: false,
                        undoStopAfter: true,
                    });

                // Open suggestions again since the commit character dot did not act as a completion character dot
                vscode.commands.executeCommand('editor.action.triggerSuggest');
            }
            else if (char_number >= text_line.text.length || text_line.text[char_number] != '(')
            {
                let parenConfig = vscode.workspace.getConfiguration("UnrealAngelscript");
                if (!parenConfig.get("insertParenthesisOnFunctionCompletion"))
                    return;

                // There is not an opening paren here, and we are at the end of the line,
                // so we insert a pair of parenthesis
                activeEditor.insertSnippet(new vscode.SnippetString(
                    "($0)"),
                    undefined,
                    {
                        undoStopBefore: false,
                        undoStopAfter: true,
                    });

                // Open signature help popup since we skipped it by not typing the paren
                vscode.commands.executeCommand('editor.action.triggerParameterHints');
            }
        }
    });
    context.subscriptions.push(completionParen);

    let inlayHintsProvider = new ASInlayHintsProvider();
    inlayHintsProvider.lspClient = client;

    let inlaySubscription = vscode.languages.registerInlayHintsProvider('angelscript', inlayHintsProvider)
    context.subscriptions.push(inlaySubscription);

    console.log("Done activating angelscript extension");
}

class ASConfigurationProvider implements vscode.DebugConfigurationProvider {

    private _server?: Net.Server;
    private _config?: DebugConfiguration;

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

        let port = config.port;
        if (EMBED_DEBUG_ADAPTER) {
            // start port listener on launch of first debug session
            // or if the port changed
            if (!this._server || (this._server && port != this._config.port)) {
                // start listening on a random port
                this._server = Net.createServer(socket => {
                    const session = new ASDebugSession();
                    session.setRunAsServer(true);
                    if (port !== undefined)
                        session.port = port;
                    session.start(<NodeJS.ReadableStream>socket, socket);
                }).listen(0);
            }

            // make VS Code connect to debug server instead of launching debug adapter
            //config.debugServer = this._server.address().port;
        }
        this._config = config;
        return config;
    }

    dispose() {
        if (this._server) {
            this._server.close();
        }
    }
}

const AngelscriptInlayHintsRequest : RequestType<any, any[], void> = new RequestType<any, any[], void>('angelscript/inlayHints');

class ASInlayHintsProvider implements vscode.InlayHintsProvider
{
    lspClient : LanguageClient = null;

    provideInlayHints(model: TextDocument, range: Range, token: CancellationToken): ProviderResult<InlayHint[]>
    {
        let params = {
            uri: model.uri.toString(),
            start: range.start,
            end: range.end,
        };
        return this.lspClient.sendRequest(AngelscriptInlayHintsRequest, params);
    }
};

class ASInlineValuesProvider implements vscode.InlineValuesProvider
{
    languageClient : LanguageClient = null;

    provideInlineValues(document: TextDocument, viewPort: Range, context: vscode.InlineValueContext, token: CancellationToken): ProviderResult<vscode.InlineValue[]>
    {
        var params: TextDocumentPositionParams = {
            position: context.stoppedLocation.start,
            textDocument: { uri: document.uri.toString() }
        };

        return this.languageClient.sendRequest(ProvideInlineValuesRequest, params).then(
            function (result: any[]) : Array<vscode.InlineValue>
            {
                let values = new Array<vscode.InlineValue>();
                for (let elem of result)
                {
                    if (elem.text)
                    {
                        values.push(
                            new vscode.InlineValueText(
                                elem.range, elem.text
                            )
                        );
                    }
                    else if (elem.variable)
                    {
                        values.push(
                            new vscode.InlineValueVariableLookup(
                                elem.range, elem.variable
                            )
                        );
                    }
                    else if (elem.expression)
                    {
                        values.push(
                            new vscode.InlineValueEvaluatableExpression(
                                elem.range, elem.expression
                            )
                        );
                    }
                }

                return values;
            },
            function (reason: any) : Array<vscode.InlineValue>
            {
                return null;
            }
        );
    }
};