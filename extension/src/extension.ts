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

const GetModuleForSymbolRequest = new RequestType<TextDocumentPositionParams, string, void>('angelscript/getModuleForSymbol');
const ProvideInlineValuesRequest = new RequestType<TextDocumentPositionParams, any[], void>('angelscript/provideInlineValues');
const GetAPIRequest = new RequestType<any, any[], void>('angelscript/getAPI');
const GetAPIDetailsRequest = new RequestType<any, string, void>('angelscript/getAPIDetails');
const GetAPISearchRequest = new RequestType<any, any[], void>('angelscript/getAPISearch');

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

    let apiTree = new ASApiTreeProvider(client);
    let apiSearch = new ASApiSearchProvider(client);
    let apiDetails = new ASApiDetailsProvider(client);

    apiSearch.tree = apiTree;

    vscode.window.registerTreeDataProvider("angelscript-api-list", apiTree);
    vscode.window.registerWebviewViewProvider("angelscript-api-search", apiSearch);
    vscode.window.registerWebviewViewProvider("angelscript-api-details", apiDetails);
    vscode.commands.registerCommand("angelscript-api-list.view-details", function (data : any)
    {
        apiDetails.showDetails(data);
    });
}

class ASApiSearchProvider implements vscode.WebviewViewProvider
{
    webview : vscode.Webview;
    client : LanguageClient;
    searchHtml : string;
    tree : ASApiTreeProvider;

    constructor(client : LanguageClient)
    {
        this.client = client;
        this.searchHtml = `
        <input
            id="search"
            type="text"
            style="width: 100%; display: block; padding: 5px; font-size: 130%; background: inherit; border: 1px solid gray; color: inherit;"
            placeholder="Search Angelscript API"
        />

        <script>
        let vscode = acquireVsCodeApi();
        let searchBox = document.getElementById("search");
        searchBox.addEventListener("input", function()
        {
            vscode.postMessage(searchBox.value);
        });
        </script>
    `;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void
    {
        this.webview = webviewView.webview;
        webviewView.webview.options = {
            enableScripts: true,
        };
        webviewView.webview.html = this.searchHtml;

        let searchProvider = this;
        webviewView.webview.onDidReceiveMessage(function (data : any)
        {
            searchProvider.onMessage(data);
        });
    }

    onMessage(data : any)
    {
        this.tree.search = data as string;
        this.tree.refresh();
    }
}

class ASApiDetailsProvider implements vscode.WebviewViewProvider
{
    webview : vscode.Webview;
    client : LanguageClient;

    constructor(client : LanguageClient)
    {
        this.client = client;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: CancellationToken): Thenable<void> | void
    {
        this.webview = webviewView.webview;
        webviewView.webview.html = "<em>Select API to see details...</em>";
    }

    showDetails(data : any)
    {
        let webview = this.webview;
        this.client.sendRequest(GetAPIDetailsRequest, data).then(
            async function (details : string)
            {
                let detailsHtml = await vscode.commands.executeCommand("markdown.api.render", details) as string;
                detailsHtml = `
                <style>
                body {
                    font-size: 100%;
                }
                pre {
                    font-size: 110%;
                    white-space: pre-wrap;
                    tab-size: 2;
                    background: none;
                }
                pre > code {
                    background: none;
                }
                </style>

                <div style="width: 100%; overflow: wrap;">
                ${detailsHtml}
                </div>
`;
                webview.html = detailsHtml;
            }
        );
    }
}

class ASApiTreeProvider implements vscode.TreeDataProvider<ASApiItem>
{
    client : LanguageClient;
    search : string;

    private _onDidChangeTreeData: vscode.EventEmitter<ASApiItem | undefined | void> = new vscode.EventEmitter<ASApiItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ASApiItem | undefined | void> = this._onDidChangeTreeData.event;

    constructor(client : LanguageClient)
    {
        this.client = client;
    }

    refresh()
    {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ASApiItem)
    {
        return element;
    }

    getChildren(element?: ASApiItem) : Thenable<ASApiItem[]>
    {
        let request;
        if (element)
            request = this.client.sendRequest(GetAPIRequest, element.id);
        else if (this.search)
            request = this.client.sendRequest(GetAPISearchRequest, this.search);
        else
            request = this.client.sendRequest(GetAPIRequest, "");

        return request.then(
            function (values : any[])
            {
                let items = new Array<ASApiItem>();
                for (let api of values)
                {
                    if (api.type == "namespace")
                    {
                        // In case of nested namespaces, only take the rightmost namespace name as a label
                        let label : string = api.label;
                        if (label.indexOf("::") != -1)
                        {
                            let parts = label.split("::");
                            label = parts[parts.length - 2] + "::";
                        }
                        let item = new ASApiItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                        item.type = api.type;
                        item.data = api.data;
                        item.id = `__ns_${api.id}`;
                        item.iconPath = new vscode.ThemeIcon("symbol-namespace", new vscode.ThemeColor("terminal.ansiBrightBlue"));
                        items.push(item);
                    }
                    else if (api.type == "function")
                    {
                        let item = new ASApiItem(api.label);
                        item.id = `__fun_${api.id}`;
                        item.data = api.data;
                        item.type = api.type;
                        item.command = {
                            "title": "View Details",
                            "command": "angelscript-api-list.view-details",
                            "arguments": [api.data],
                        };
                        item.iconPath = new vscode.ThemeIcon("symbol-function", new vscode.ThemeColor("terminal.ansiBrightYellow"));
                        items.push(item);
                    }
                    else if (api.type == "property")
                    {
                        let item = new ASApiItem(api.label);
                        item.id = `__prop_${api.id}`;
                        item.data = api.data;
                        item.type = api.type;
                        item.command = {
                            "title": "View Details",
                            "command": "angelscript-api-list.view-details",
                            "arguments": [api.data],
                        };
                        item.iconPath = new vscode.ThemeIcon("symbol-field", new vscode.ThemeColor("terminal.ansiBrightCyan"));
                        items.push(item);
                    }
                }

                return items;
            }
        );
    }

    resolveTreeItem(item: vscode.TreeItem, element: ASApiItem, token: CancellationToken): ProviderResult<vscode.TreeItem>
    {
        return this.client.sendRequest(GetAPIDetailsRequest, element.data).then(
            function (details : string)
            {
                element.tooltip = new vscode.MarkdownString(details);
                element.tooltip.supportHtml = true;
                return element;
            }
        );
    }
}

class ASApiItem extends vscode.TreeItem
{
    type : string;
    data : any;
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