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

    client.onNotification("angelscript/wantSave", (uri : string) => {
        setTimeout(() => vscode.workspace.saveAll(), 100);
    });

    // register a configuration provider for 'mock' debug type
    const provider = new ASConfigurationProvider();
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('angelscript', provider));
    context.subscriptions.push(provider);

    let evaluatableExpressionProvider = new ASEvaluateableExpressionProvider();
    context.subscriptions.push(vscode.languages.registerEvaluatableExpressionProvider('angelscript', evaluatableExpressionProvider));

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

    let saveAndCreateBlueprint = vscode.commands.registerCommand('angelscript.saveAndCreateBlueprint',
        function(uri : string, className : string)
        {
            let activeEditor = vscode.window.activeTextEditor;
            if (activeEditor != null)
            {
                if (activeEditor.document.isDirty)
                {
                    activeEditor.document.save().then(
                        function(success : boolean)
                        {
                            setTimeout(function()
                            {
                                vscode.commands.executeCommand('angelscript.createBlueprint', className);
                            }, 300);
                        }
                    );
                }
                else
                {
                    vscode.commands.executeCommand('angelscript.createBlueprint', className);
                }
            }
        });
    context.subscriptions.push(saveAndCreateBlueprint);

    let saveAndEditAsset = vscode.commands.registerCommand('angelscript.saveAndEditAsset',
        function(uri : string, assetPath : string)
        {
            let activeEditor = vscode.window.activeTextEditor;
            if (activeEditor != null)
            {
                if (activeEditor.document.isDirty)
                {
                    activeEditor.document.save().then(
                        function(success : boolean)
                        {
                            setTimeout(function()
                            {
                                vscode.commands.executeCommand('angelscript.editAsset', assetPath);
                            }, 300);
                        }
                    );
                }
                else
                {
                    vscode.commands.executeCommand('angelscript.editAsset', assetPath);
                }
            }
        });
    context.subscriptions.push(saveAndEditAsset);

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
        let hostname = config.hostname;

        // start port listener on launch of first debug session
        // or if the port changed
        if (!this._server || (this._server && (port != this._config.port || hostname != this._config.hostname))) {
            // start listening on a random port
            this._server = Net.createServer(socket => {
                const session = new ASDebugSession();
                session.setRunAsServer(true);

                if (port !== undefined)
                {
                    session.port = port;
                }

                if (hostname !== undefined)
                {
                    session.hostname = hostname;
                }

                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }

        // make VS Code connect to debug server instead of launching debug adapter
        config.debugServer = (this._server.address() as Net.AddressInfo).port;

        this._config = config;
        return config;
    }

    dispose() {
        if (this._server) {
            this._server.close();
        }
    }
}

class ASEvaluateableExpressionProvider implements vscode.EvaluatableExpressionProvider
{
    provideEvaluatableExpression(document: TextDocument, position: vscode.Position, token: CancellationToken): ProviderResult<vscode.EvaluatableExpression>
    {
        let lineContent = document.lineAt(position.line).text;

        // Search backward until we find a character that makes us want to stop
        let start = position.character;
        let depth = 0;
        while (start > 0)
        {
            let stop = false;
            switch (lineContent[start])
            {
                case '(':
                case ')':
                case '{':
                case '}':
                case '<':
                case '>':
                case ' ':
                case '\t':
                case '\n':
                case '\r':
                case '+':
                case '-':
                case '/':
                case '%':
                case '~':
                case '#':
                case '^':
                case ';':
                case '=':
                case '|':
                case ',':
                case ',':
                case '`':
                case '!':
                case '\\':
                    if (depth == 0)
                    {
                        stop = true;
                    }
                break;
                case ']':
                    if (start+1 < lineContent.length && lineContent[start+1] == '.')
                    {
                        depth += 1;
                    }
                    else
                    {
                        stop = true;
                    }
                break;
                case '[':
                    if (depth == 0)
                    {
                        stop = true;
                    }
                    else
                    {
                        depth -= 1;
                    }
                break;
            }

            if (stop)
            {
                start += 1;
                break;
            }
            else
            {
                start -= 1;
            }
        }

        // Complete the word after the cursor
        let end = position.character;
        while (end < lineContent.length)
        {
            let charCode = lineContent.charCodeAt(end);
            if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122) || (charCode >= 48 && charCode <= 57) || charCode == 95)
            {
                end += 1;
                continue;
            }
            else
            {
                break;
            }
        }

        if (start >= end)
        {
            return null;
        }
        else
        {
            return new vscode.EvaluatableExpression(
                new vscode.Range(
                    new vscode.Position(position.line, start),
                    new vscode.Position(position.line, end),
                )
            );
        }
    }
};