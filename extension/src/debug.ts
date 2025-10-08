
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
    Logger, logger,
    LoggingDebugSession,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent,
    ContinuedEvent,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';

import { DebugProtocol } from 'vscode-debugprotocol';
import { basename } from 'path';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

import * as unreal from './unreal-debugclient';

const { Subject } = require('await-notify');


interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    trace?: boolean;
    port?: number;
    hostname?: string;
}

interface ASBreakpoint
{
    id : number;
    line : number;
}

interface ASDebugVariable
{
    name : string,
    value : string,
    type : string,
    address : bigint,
    valueSize : number,
    bHasMembers : boolean
}

interface ASDataBreakpoint
{
    id: number,
    variable: ASDebugVariable
}

export class ASDebugSession extends LoggingDebugSession
{
    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static THREAD_ID = 1;

    private static SUPPORTED_DATA_BREAKPOINT_COUNT = 4;

    private breakpoints = new Map<string, ASBreakpoint[]>();
    private dataBreakpoints = new Map<string, ASDataBreakpoint>();
    private nextBreakpointId = 1;

    private variableStore = new Map<string, ASDebugVariable>();
    private _variableHandles = new Handles<string>();

    private _configurationDone = new Subject();

    private _rootPaths = this.gatherRootPaths();

    hostname = "127.0.0.1";
    port = 27099;

    // Version of this debug adapter.
    debugAdapterVersion = 2;

    // Version of the Unreal Angelscript Debug Server we attach to.
    // Received during the DebugServerVersion event
    debugServerVersion = 0;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor()
    {
        super("angelscript-debug");

        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        unreal.events.removeAllListeners();
        unreal.events.on("CallStack", (msg : unreal.Message) => {
            this.receiveCallStack(msg);
        });

        unreal.events.on("Stopped", (msg : unreal.Message) => {
            this.receiveStopped(msg);
        });

        unreal.events.on("Continued", (msg : unreal.Message) => {
            this.receiveContinued();
        });

        unreal.events.on("Variables", (msg : unreal.Message) => {
            this.receiveVariables(msg);
        });

        unreal.events.on("Evaluate", (msg : unreal.Message) => {
            this.receiveEvaluate(msg);
        });

        unreal.events.on("BreakFilters", (msg : unreal.Message) => {
            this.receiveBreakFilters(msg);
        });

        unreal.events.on("Closed", () => {
            this.receiveClosed();
        });

        unreal.events.on("SetBreakpoint", (msg : unreal.Message) => {
            this.receiveBreakpoint(msg);
        });

        unreal.events.on("ClearDataBreakpoints", (msg : unreal.Message) => {
            this.receiveClearDataBreakpoints(msg);
        });

        unreal.events.on("DebugServerVersion", (msg : unreal.Message) => {
            this.receiveDebugVersion(msg);
        });
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */

    waitingInitializeResponse : DebugProtocol.InitializeResponse;
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) : void
    {
        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};

        // the adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;

        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsExceptionInfoRequest = true;
        response.body.supportsDataBreakpoints = true;

        unreal.connect(this.hostname, this.port);
        unreal.sendRequestBreakFilters();

        this.waitingInitializeResponse = response;
    }


    receiveBreakFilters(msg : unreal.Message) : void
    {
        this.waitingInitializeResponse.body.exceptionBreakpointFilters = [];
        let count = msg.readInt();
        for (let i = 0; i < count; ++i)
        {
            let filter = msg.readString();
            let filterTitle = msg.readString();

            this.waitingInitializeResponse.body.exceptionBreakpointFilters.push(
                <DebugProtocol.ExceptionBreakpointsFilter> {
                    filter: filter,
                    label: filterTitle,
                    default: true,
                },
            );
        }

        unreal.disconnect();

        this.sendResponse(this.waitingInitializeResponse);

        // since this debug adapter can accept configuration requests like 'setASBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new InitializedEvent());
    }

    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) : void
    {
        super.configurationDoneRequest(response, args);

        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments)
    {
        // make sure to 'Stop' the buffered logging if 'trace' is not set
        logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

        let hostname = args.hostname ?? this.hostname;
        let port = (args.port !== undefined && args.port > 0) ? args.port : this.port;

        unreal.connect(hostname, port);
        unreal.sendStartDebugging(this.debugAdapterVersion);

        for (let clientPath of this.breakpoints.keys())
        {
            let breakpointList = this.getBreakpointList(clientPath);
            if (breakpointList.length != 0)
            {
                const debugPath = this.convertClientPathToDebugger(clientPath);
                const moduleName = this.GetModuleNameForFilepath(debugPath);

                unreal.clearBreakpoints(debugPath, moduleName);

                for(let breakpoint of breakpointList)
                {
                    unreal.setBreakpoint(breakpoint.id, debugPath, breakpoint.line, moduleName);
                }
            }
        }

        // wait until configuration has finished (and configurationDoneRequest has been called)
        await this._configurationDone.wait(1000);

        this.sendResponse(response);
    }

    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void
    {
        unreal.sendStopDebugging();
        unreal.disconnect();
        this.clearAllDataBreakpoints();

        this.sendResponse(response);
    }

    protected getBreakpointList(path : string) : Array<ASBreakpoint>
    {
        let breakpointList = this.breakpoints.get(path);
        if(!breakpointList)
        {
            breakpointList = new Array<ASBreakpoint>();
            this.breakpoints.set(path, breakpointList);
        }
        return breakpointList;
    }

    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) : void
    {
        const clientLines = args.lines || [];
        const clientPath = <string>args.source.path;
        const debugPath = this.convertClientPathToDebugger(clientPath);
        const moduleName = this.GetModuleNameForFilepath(debugPath);

        let clientBreakpoints = new Array<DebugProtocol.Breakpoint>();
        let oldBreakpointList = this.getBreakpointList(clientPath);
        let breakpointList = new Array<ASBreakpoint>();

        if(unreal.connected)
            unreal.clearBreakpoints(debugPath, moduleName);

        for (let line of clientLines)
        {
            let id = -1;
            for (let oldBP of oldBreakpointList)
            {
                if (oldBP.line == line)
                    id = oldBP.id;
            }

            if (id == -1)
                id = this.nextBreakpointId++;

            let clientBreak = <DebugProtocol.Breakpoint> {
                id: id,
                verified: true,
                line: line
            }
            clientBreakpoints.push(clientBreak);

            let breakpoint = <ASBreakpoint> { id: clientBreak.id, line: line };
            breakpointList.push(breakpoint);

            if(unreal.connected)
                unreal.setBreakpoint(breakpoint.id, debugPath, line, moduleName);
        }

        this.breakpoints.set(clientPath, breakpointList);

        response.body = {
            breakpoints: clientBreakpoints
        };
        this.sendResponse(response);
    }

    protected receiveBreakpoint(msg : unreal.Message)
    {
        let filename = msg.readString();
        let line = msg.readInt();
        let id = msg.readInt();

        let breakpointList = this.getBreakpointList(filename);

        // If our line number has changed, but we are overlapping an existing breakpoint,
        // we should delete the new breakpoint.
        let overlapsExistingBreakpoint = false;
        for (let i = 0; i < breakpointList.length; ++i)
        {
            let bp = breakpointList[i];
            if (bp.id != id && bp.line == line)
            {
                overlapsExistingBreakpoint = true;
                break;
            }
        }

        // For some reason, doing multiple sendEvent calls at once
        // confuses visual studio code (?). So we spread them out
        // by a few ms so it can deal with it.
        let timeout = 1;

        let adapter = this;
        for (let i = 0; i < breakpointList.length; ++i)
        {
            let bp = breakpointList[i];
            if (bp.id == id)
            {
                if (overlapsExistingBreakpoint)
                {
                    // We created a breakpoint that was moved to a line that already has a breakpoint,
                    // so just remove the one we created.
                    breakpointList.splice(i, 1);
                    setTimeout(function()
                    {
                        adapter.sendEvent(new BreakpointEvent('removed', <DebugProtocol.Breakpoint>{ verified: false, id: bp.id }));
                    }, timeout++);
                }
                else if (line == -1)
                {
                    // No code existed at this line, so show it as an unverified breakpoint
                    breakpointList.splice(i, 1);
                    setTimeout(function()
                    {
                        adapter.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: false, id: bp.id, line: bp.line }));
                    }, timeout++);
                }
                else
                {
                    // The breakpoint was moved to a different line that actually has code on it, send a change back to the UI
                    bp.line = line;
                    setTimeout(function()
                    {
                        adapter.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: true, id: bp.id, line: bp.line }));
                    }, timeout++);
                }

                break;
            }
        }

        this.breakpoints.set(filename, breakpointList);
    }

    protected receiveClearDataBreakpoints(msg : unreal.Message)
    {
        // If we receive this message it means the debug server has cleared some data breakpoints on their own
        // accord, so we clear our breakpoints on the debug client as well to match.

        let count = msg.readInt();
        for (let i = 0; i < count; i++)
        {
            let id = msg.readInt();
            this.clearDataBreakpoint(id);
        }

        if (count == 0)
        {
            this.clearAllDataBreakpoints();
        }
    }

    protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments)
    {
        unreal.sendBreakOptions(args.filters);
        this.sendResponse(response);
    }

    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void
    {
        // runtime supports now threads so just return a default thread.
        response.body = {
            threads: [
                new Thread(ASDebugSession.THREAD_ID, "Unreal Editor")
            ]
        };
        this.sendResponse(response);
    }


    waitingTraces : Array<DebugProtocol.StackTraceResponse>;

    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) : void
    {
        unreal.sendRequestCallStack();

        if(!this.waitingTraces)
            this.waitingTraces = new Array<DebugProtocol.StackTraceResponse>();

        this.waitingTraces.push(response);
    }

    protected receiveCallStack(msg : unreal.Message)
    {
        let stack = new Array<StackFrame>();

        let count = msg.readInt();
        let previousSourcePath : string;
        let previousSourceLine : number;

        for(let i = 0; i < count; ++i)
        {
            let name = msg.readString().replace(/_Implementation$/, "");
            let sourcePath = msg.readString();
            let line = msg.readInt();

            let moduleName = "";
            if (this.debugServerVersion > 0)
            {
                moduleName = msg.readString();
            }

            let frame : StackFrame = null;
            if (sourcePath && sourcePath.length != 0)
            {
                if (sourcePath.startsWith("::"))
                {
                    let externalSource : any = new Source(
                        sourcePath.substring(2),
                        null, undefined, undefined, "bp-frame");
                    externalSource.presentationHint = 'deemphasize';

                    frame = new StackFrame(i, name+" ("+sourcePath.substring(2)+")");
                    frame.presentationHint = "label";
                }
                else
                {
                    previousSourceLine = line;
                    previousSourcePath = sourcePath;

                    const absoluteSourcePath = this.debugServerVersion > 0 ? this.resolvePathsToSourcePath(sourcePath, moduleName) : sourcePath;
                    frame = new StackFrame(i, name, this.createSource(absoluteSourcePath), line, 1);
                }
            }
            else
            {
                frame = new StackFrame(i, name);
            }

            stack.push(frame);
        }

        if(stack.length == 0)
        {
            stack.push(new StackFrame(0, "No CallStack"));
        }

        if (this.waitingTraces && this.waitingTraces.length > 0)
        {
            let response = this.waitingTraces[0];
            this.waitingTraces.splice(0, 1);

            response.body = {
                stackFrames: stack,
                totalFrames: stack.length,
            };

            this.sendResponse(response);
        }
    }

    private resolvePathsToSourcePath(sourcePath : string, moduleName : string) : string
    {
        if (fs.existsSync(sourcePath))
        {
            return sourcePath;
        }

        let relativeFilename = moduleName.split(".").join(path.sep);
        relativeFilename += ".as";

        for (let root of this._rootPaths)
        {
            let absoluteFilename = root + path.sep + relativeFilename;
            if (fs.existsSync(absoluteFilename))
            {
                return absoluteFilename;
            }
        }

        return sourcePath;
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) : void
    {
        const frameReference = args.frameId;
        const scopes = new Array<Scope>();

        let variablesScope : any = new Scope("Variables", this._variableHandles.create(frameReference+":%local%"), false);
        variablesScope.presentationHint = "locals";
        scopes.push(variablesScope);

        scopes.push(new Scope("this", this._variableHandles.create(frameReference+":%this%"), false));
        scopes.push(new Scope("Globals", this._variableHandles.create(frameReference+":%module%"), false));

        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }

    waitingVariableRequests : Array<any>;

    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) : void
    {
        const id = this._variableHandles.get(args.variablesReference);
        unreal.sendRequestVariables(id);

        if(!this.waitingVariableRequests)
            this.waitingVariableRequests = new Array<any>();

        this.waitingVariableRequests.push({
            response: response,
            id: id,
        });
    }

    combineExpression(expr : string, variable : string) : string
    {
        if(variable.startsWith("[") && variable.endsWith("]"))
            return expr + variable;

        return expr + "." + variable;
    }

    protected receiveVariables(msg : unreal.Message)
    {
        let id = "";
        if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
        {
            id = this.waitingVariableRequests[0].id;
        }

        let variables = new Array<DebugProtocol.Variable>();

        let count = msg.readInt();
        for(let i = 0; i < count; ++i)
        {
            let debugVariable : ASDebugVariable = {
                name: msg.readString(),
                value: msg.readString(),
                type: msg.readString(),
                bHasMembers: msg.readBool(),
                address: BigInt(0),
                valueSize: 0,
            };

            if (this.debugServerVersion >= 2)
            {
                debugVariable.address = msg.readAddress();
                debugVariable.valueSize = msg.readByte();
            }

            let hint = <DebugProtocol.VariablePresentationHint>{};

            let evalName = this.combineExpression(id, debugVariable.name);

            let varRef = 0;
            if (debugVariable.bHasMembers)
                varRef = this._variableHandles.create(evalName);

            if (debugVariable.name.endsWith("$"))
            {
                debugVariable.name = debugVariable.name.substr(0, debugVariable.name.length-1);
                hint.kind = 'method';
            }
            else if (debugVariable.name.startsWith("[") && debugVariable.name.endsWith("]"))
            {
                hint.kind = 'data';
            }

            if (this.dataBreakpoints.has(evalName))
            {
                hint.attributes = ['hasDataBreakpoint'];
            }

            let variable = {
                name: debugVariable.name,
                type: debugVariable.type,
                value: debugVariable.value,
                presentationHint: hint,
                variablesReference: varRef,
                evaluateName: debugVariable.name,
            };

            // Keep the full path in the name for our debug variables
            debugVariable.name = evalName.replace(/^[0-9]+:%.*%./g, "");

            this.variableStore.set(this.combineExpression(id, variable.evaluateName), debugVariable);
            variables.push(variable);
        }

        if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0)
        {
            let response = this.waitingVariableRequests[0].response;
            this.waitingVariableRequests.splice(0, 1);

            response.body = {
                variables: variables,
            };

            this.sendResponse(response);
        }
    }

    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) : void
    {
        unreal.sendContinue();
        this.sendResponse(response);
    }

    protected receiveContinued()
    {
        this.sendEvent(new ContinuedEvent(ASDebugSession.THREAD_ID));
    }

    protected receiveClosed()
    {
        this.sendEvent(new TerminatedEvent());
    }

    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void
    {
        unreal.sendPause();
        this.sendResponse(response);
    }

    previousException : string;
    protected receiveStopped(msg : unreal.Message)
    {
        let Reason = msg.readString();
        let Description = msg.readString();
        let Text = msg.readString();

        if(Text.length != 0 && Reason == 'exception')
        {
            this.previousException = Text;
            this.sendEvent(new StoppedEvent(Reason, ASDebugSession.THREAD_ID, Text));
        }
        else
        {
            this.previousException = null;
            this.sendEvent(new StoppedEvent(Reason, ASDebugSession.THREAD_ID));
        }
    }

    protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments, request?: DebugProtocol.Request): void {
        let id = this._variableHandles.get(args.variablesReference);
        const evalName = this.combineExpression(id, args.name);
        const variable = this.variableStore.get(evalName);

        let dataId = null;
        let description = "Data Breakpoint not available";

        // Don't allow breakpoints for the same variable twice, or if the variable has no valid address/size
        if (this.debugServerVersion >= 2 &&
            variable !== undefined &&
            this.dataBreakpoints.get(evalName) === undefined &&
            variable.address !== BigInt(0))
        {
            let breakpointSupported = false;
            switch (variable.valueSize)
            {
                case 1:
                case 2:
                case 4:
                case 8:
                    breakpointSupported = true;
                    break;
                default:
                    breakpointSupported = false;
                    break;
            }

            if (breakpointSupported)
            {
                dataId = evalName;
                description = `Data Breakpoint for ${variable.name} (${variable.valueSize} bytes 0x${variable.address.toString(16).toUpperCase().padStart(16, "0")})`;
            }
        }

        response.body= {
            dataId: dataId,
            description: description,
            accessTypes: ['write'],
            canPersist: false
        };

        this.sendResponse(response);
    }

    protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments, request?: DebugProtocol.Request): void
    {
        let dataBreakpointConfig = vscode.workspace.getConfiguration("UnrealAngelscript.dataBreakpoints");

        this.dataBreakpoints.clear();
        let responseBreakpoints = new Array<DebugProtocol.Breakpoint>();

        let dataBreakpoints = new Array<unreal.UnrealDataBreakpoint>();

        const triggerCppDataBreakpoints: boolean = dataBreakpointConfig.get("cppBreakpoints.enable");

        const hitCount: number = triggerCppDataBreakpoints ?
            dataBreakpointConfig.get("cppBreakpoints.triggerCount") :
            dataBreakpointConfig.get("asBreakpoints.triggerCount");

        for (let i = 0; i < args.breakpoints.length; i++)
        {
            let newBreakpoint = args.breakpoints[i];
            const variable : ASDebugVariable = this.variableStore.get(newBreakpoint.dataId);
            const breakpointId = this.nextBreakpointId++;
            this.dataBreakpoints.set(newBreakpoint.dataId, { variable, id: breakpointId });

            let responseBreakpoint : DebugProtocol.Breakpoint = {
                id: breakpointId,
                verified: i < ASDebugSession.SUPPORTED_DATA_BREAKPOINT_COUNT,
                instructionReference: `0x${variable.address.toString(16).toUpperCase().padStart(16, "0")})`
            }
            responseBreakpoints.push(responseBreakpoint);
            dataBreakpoints.push({
                id: breakpointId,
                address: variable.address,
                size: variable.valueSize,
                hitCount: hitCount,
                cppBreakpoint: triggerCppDataBreakpoints,
                name: `${variable.name}, ${variable.valueSize} bytes 0x${variable.address.toString(16).toUpperCase().padStart(16, "0")}`
            });
        }

        response.body = {
            breakpoints: responseBreakpoints
        }

        if (unreal.connected)
            unreal.setDataBreakpoints(dataBreakpoints);

        this.sendResponse(response);
    }

    private clearDataBreakpoint(id: number): void
    {
        let keyToDelete = undefined;
        for (let [key, value] of this.dataBreakpoints.entries())
        {
            if (value.id === id)
            {
                keyToDelete = key;
                break;
            }
        }

        if (keyToDelete !== undefined)
        {
            this.dataBreakpoints.delete(keyToDelete);
            this.sendEvent(new BreakpointEvent('removed', <DebugProtocol.Breakpoint>{ verified: false, id: id }));
        }
    }

    private clearAllDataBreakpoints(): void
    {
        this.dataBreakpoints.forEach(function (bp: ASDataBreakpoint, key: string): void {
            this.sendEvent(new BreakpointEvent('removed', <DebugProtocol.Breakpoint>{ verified: false, id: bp.id }));
        }, this);

        this.dataBreakpoints.clear();
    }

    protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments): void
    {
        if(!this.previousException)
        {
            this.sendResponse(response);
            return;
        }

        response.body = {
            exceptionId: "",
            breakMode: "unhandled",
            description: this.previousException,
        };
        this.sendResponse(response);
    }

        protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) : void
        {
        unreal.sendStepOver();
        this.sendResponse(response);
    }

    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void
    {
        unreal.sendStepIn();
        this.sendResponse(response);
    }

    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void
    {
        unreal.sendStepOut();
        this.sendResponse(response);
    }

    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void
    {
        //unreal.sendEngineBreak();
        this.sendResponse(response);
    }

    waitingEvaluateRequests : Array<any>;

    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) : void
    {
        unreal.sendRequestEvaluate(args.expression, args.frameId);

        if(!this.waitingEvaluateRequests)
            this.waitingEvaluateRequests = new Array<any>();

        this.waitingEvaluateRequests.push({
            expression: args.expression,
            frameId: args.frameId,
            response: response,
        });
    }

    protected receiveEvaluate(msg : unreal.Message)
    {
        let id = "";
        if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
        {
            id = this.waitingEvaluateRequests[0].expression;
            if(!/^[0-9]+:/.test(id))
            {
                id = this.waitingEvaluateRequests[0].frameId + ":" + id;
            }
        }

        let name = msg.readString();
        let value = msg.readString();
        let type = msg.readString();
        let bHasMembers = msg.readBool();

        if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0)
        {
            let response = this.waitingEvaluateRequests[0].response;
            this.waitingEvaluateRequests.splice(0, 1);

            if(value.length == 0)
            {

            }
            else
            {
                response.body = {
                    result: value,
                    variablesReference: bHasMembers ? this._variableHandles.create(id) : 0,
                };
            }
            this.sendResponse(response);
        }
    }

    private createSource(filePath: string): Source
    {
        return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, "as-script");
    }

    private gatherRootPaths() : Array<string>
    {
        let roots = [];
        for (let workspaceFolder of vscode.workspace.workspaceFolders)
        {
            roots.push(workspaceFolder.uri.fsPath);
        }
        return roots;
    }

    private GetModuleNameForFilepath(filePath: string) : string
    {
        for (let root of this._rootPaths)
        {
            let relativePath = path.relative(root, filePath);
            if (filePath.includes(relativePath))
            {
                return relativePath.split(path.sep).join(".").replace(".as", "");
            }
        }

        return "";
    }

    private receiveDebugVersion(msg: unreal.Message)
    {
        this.debugServerVersion = msg.readInt();
    }
}
