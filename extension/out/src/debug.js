"use strict";
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const vscode_debugadapter_1 = require("vscode-debugadapter");
const path_1 = require("path");
const unreal = require("./unreal-debugclient");
//import { ASDebugRuntime, ASBreakpoint } from './debugRuntime';
const { Subject } = require('await-notify');
let GLOBID = 0;
class ASDebugSession extends vscode_debugadapter_1.LoggingDebugSession {
    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    constructor() {
        super("angelscript-debug");
        this.breakpoints = new Map();
        this.nextBreakpointId = 1;
        this._variableHandles = new vscode_debugadapter_1.Handles();
        this._configurationDone = new Subject();
        this.instId = 0;
        this.instId = GLOBID++;
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
        unreal.events.removeAllListeners();
        unreal.events.on("CallStack", (msg) => {
            this.receiveCallStack(msg);
        });
        unreal.events.on("Stopped", (msg) => {
            this.receiveStopped(msg);
        });
        unreal.events.on("Continued", (msg) => {
            this.receiveContinued();
        });
        unreal.events.on("Variables", (msg) => {
            this.receiveVariables(msg);
        });
        unreal.events.on("Evaluate", (msg) => {
            this.receiveEvaluate(msg);
        });
        unreal.events.on("BreakFilters", (msg) => {
            this.receiveBreakFilters(msg);
        });
        unreal.events.on("Closed", () => {
            this.receiveClosed();
        });
        /*this._runtime = new ASDebugRuntime();

        // setup event handlers
        this._runtime.on('stopOnEntry', () => {
            this.sendEvent(new StoppedEvent('entry', ASDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnStep', () => {
            this.sendEvent(new StoppedEvent('step', ASDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnBreakpoint', () => {
            this.sendEvent(new StoppedEvent('breakpoint', ASDebugSession.THREAD_ID));
        });
        this._runtime.on('stopOnException', () => {
            this.sendEvent(new StoppedEvent('exception', ASDebugSession.THREAD_ID));
        });
        this._runtime.on('breakpointValidated', (bp: ASBreakpoint) => {
            this.sendEvent(new BreakpointEvent('changed', <DebugProtocol.Breakpoint>{ verified: true, id: 0 }));
        });
        this._runtime.on('output', (text, filePath, line, column) => {
            const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
            e.body.source = this.createSource(filePath);
            e.body.line = this.convertDebuggerLineToClient(line);
            e.body.column = this.convertDebuggerColumnToClient(column);
            this.sendEvent(e);
        });
        this._runtime.on('end', () => {
            this.sendEvent(new TerminatedEvent());
        });*/
    }
    initializeRequest(response, args) {
        // build and return the capabilities of this debug adapter:
        response.body = response.body || {};
        // the adapter implements the configurationDoneRequest.
        response.body.supportsConfigurationDoneRequest = true;
        // make VS Code to use 'evaluate' when hovering over source
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsExceptionInfoRequest = true;
        unreal.connect();
        unreal.sendRequestBreakFilters();
        this.waitingInitializeResponse = response;
    }
    receiveBreakFilters(msg) {
        this.waitingInitializeResponse.body.exceptionBreakpointFilters = [];
        let count = msg.readInt();
        for (let i = 0; i < count; ++i) {
            let filter = msg.readString();
            let filterTitle = msg.readString();
            this.waitingInitializeResponse.body.exceptionBreakpointFilters.push({
                filter: filter,
                label: filterTitle,
                default: true,
            });
        }
        unreal.disconnect();
        this.sendResponse(this.waitingInitializeResponse);
        // since this debug adapter can accept configuration requests like 'setASBreakpoint' at any time,
        // we request them early by sending an 'initializeRequest' to the frontend.
        // The frontend will end the configuration sequence by calling 'configurationDone' request.
        this.sendEvent(new vscode_debugadapter_1.InitializedEvent());
    }
    /**
     * Called at the end of the configuration sequence.
     * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
     */
    configurationDoneRequest(response, args) {
        super.configurationDoneRequest(response, args);
        // notify the launchRequest that configuration has finished
        this._configurationDone.notify();
    }
    launchRequest(response, args) {
        return __awaiter(this, void 0, void 0, function* () {
            // make sure to 'Stop' the buffered logging if 'trace' is not set
            vscode_debugadapter_1.logger.setup(args.trace ? vscode_debugadapter_1.Logger.LogLevel.Verbose : vscode_debugadapter_1.Logger.LogLevel.Stop, false);
            unreal.connect();
            unreal.sendStartDebugging();
            for (let clientPath of this.breakpoints.keys()) {
                let breakpointList = this.getBreakpointList(clientPath);
                if (breakpointList.length != 0) {
                    const debugPath = this.convertClientPathToDebugger(clientPath);
                    unreal.clearBreakpoints(debugPath);
                    for (let breakpoint of breakpointList) {
                        unreal.setBreakpoint(debugPath, breakpoint.line);
                    }
                }
            }
            // wait until configuration has finished (and configurationDoneRequest has been called)
            yield this._configurationDone.wait(1000);
            // start the program in the runtime
            //this._runtime.start(args.program, !!args.stopOnEntry);
            this.sendResponse(response);
        });
    }
    disconnectRequest(response, args) {
        unreal.sendStopDebugging();
        unreal.disconnect();
        this.sendResponse(response);
    }
    getBreakpointList(path) {
        let breakpointList = this.breakpoints.get(path);
        if (!breakpointList) {
            breakpointList = new Array();
            this.breakpoints.set(path, breakpointList);
        }
        return breakpointList;
    }
    setBreakPointsRequest(response, args) {
        const clientLines = args.lines || [];
        const clientPath = args.source.path;
        const debugPath = this.convertClientPathToDebugger(clientPath);
        let clientBreakpoints = new Array();
        let breakpointList = this.getBreakpointList(clientPath);
        if (unreal.connected)
            unreal.clearBreakpoints(debugPath);
        for (let line of clientLines) {
            let clientBreak = new vscode_debugadapter_1.Breakpoint(true, line);
            clientBreakpoints.push(clientBreak);
            let breakpoint = { id: this.nextBreakpointId++, line: line };
            breakpointList.push(breakpoint);
            if (unreal.connected)
                unreal.setBreakpoint(debugPath, line);
        }
        this.breakpoints.set(clientPath, breakpointList);
        response.body = {
            breakpoints: clientBreakpoints
        };
        this.sendResponse(response);
    }
    setExceptionBreakPointsRequest(response, args) {
        unreal.sendBreakOptions(args.filters);
        this.sendResponse(response);
    }
    threadsRequest(response) {
        // runtime supports now threads so just return a default thread.
        response.body = {
            threads: [
                new vscode_debugadapter_1.Thread(ASDebugSession.THREAD_ID, "Unreal Editor")
            ]
        };
        this.sendResponse(response);
    }
    stackTraceRequest(response, args) {
        unreal.sendRequestCallStack();
        if (!this.waitingTraces)
            this.waitingTraces = new Array();
        this.waitingTraces.push(response);
    }
    receiveCallStack(msg) {
        let stack = new Array();
        let count = msg.readInt();
        for (let i = 0; i < count; ++i) {
            let name = msg.readString().replace(/_Implementation$/, "");
            let source = this.createSource(msg.readString());
            let line = msg.readInt();
            let frame = new vscode_debugadapter_1.StackFrame(i, name, source, line, 1);
            stack.push(frame);
        }
        if (stack.length == 0) {
            stack.push(new vscode_debugadapter_1.StackFrame(0, "No CallStack", this.createSource(""), 1));
        }
        if (this.waitingTraces && this.waitingTraces.length > 0) {
            let response = this.waitingTraces[0];
            this.waitingTraces.splice(0, 1);
            response.body = {
                stackFrames: stack,
                totalFrames: stack.length,
            };
            this.sendResponse(response);
        }
    }
    scopesRequest(response, args) {
        const frameReference = args.frameId;
        const scopes = new Array();
        scopes.push(new vscode_debugadapter_1.Scope("Variables", this._variableHandles.create(frameReference + ":%local%"), false));
        scopes.push(new vscode_debugadapter_1.Scope("this", this._variableHandles.create(frameReference + ":%this%"), false));
        scopes.push(new vscode_debugadapter_1.Scope("Globals", this._variableHandles.create(frameReference + ":%module%"), false));
        response.body = {
            scopes: scopes
        };
        this.sendResponse(response);
    }
    variablesRequest(response, args) {
        const id = this._variableHandles.get(args.variablesReference);
        unreal.sendRequestVariables(id);
        if (!this.waitingVariableRequests)
            this.waitingVariableRequests = new Array();
        this.waitingVariableRequests.push({
            response: response,
            id: id,
        });
    }
    combineExpression(expr, variable) {
        if (variable.startsWith("[") && variable.endsWith("]"))
            return expr + variable;
        return expr + "." + variable;
    }
    receiveVariables(msg) {
        let id = "";
        if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0) {
            id = this.waitingVariableRequests[0].id;
        }
        let variables = new Array();
        let count = msg.readInt();
        for (let i = 0; i < count; ++i) {
            let name = msg.readString();
            let value = msg.readString();
            let type = msg.readString();
            let bHasMembers = msg.readBool();
            let evalName = this.combineExpression(id, name);
            let varRef = 0;
            if (bHasMembers)
                varRef = this._variableHandles.create(evalName);
            let variable = {
                name: name,
                type: type,
                value: value,
                variablesReference: varRef,
                evaluateName: evalName.replace(/^[0-9]+:%.*%./g, ""),
            };
            variables.push(variable);
        }
        if (this.waitingVariableRequests && this.waitingVariableRequests.length > 0) {
            let response = this.waitingVariableRequests[0].response;
            this.waitingVariableRequests.splice(0, 1);
            response.body = {
                variables: variables,
            };
            this.sendResponse(response);
        }
    }
    continueRequest(response, args) {
        unreal.sendContinue();
        this.sendResponse(response);
    }
    receiveContinued() {
        this.sendEvent(new vscode_debugadapter_1.ContinuedEvent(ASDebugSession.THREAD_ID));
    }
    receiveClosed() {
        this.sendEvent(new vscode_debugadapter_1.TerminatedEvent());
    }
    pauseRequest(response, args) {
        unreal.sendPause();
        this.sendResponse(response);
    }
    receiveStopped(msg) {
        let Reason = msg.readString();
        let Description = msg.readString();
        let Text = msg.readString();
        if (Text.length != 0 && Reason == 'exception') {
            this.previousException = Text;
            this.sendEvent(new vscode_debugadapter_1.StoppedEvent(Reason, ASDebugSession.THREAD_ID, Text));
        }
        else {
            this.previousException = null;
            this.sendEvent(new vscode_debugadapter_1.StoppedEvent(Reason, ASDebugSession.THREAD_ID));
        }
    }
    exceptionInfoRequest(response, args) {
        if (!this.previousException) {
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
    nextRequest(response, args) {
        unreal.sendStepOver();
        this.sendResponse(response);
    }
    stepInRequest(response, args) {
        unreal.sendStepIn();
        this.sendResponse(response);
    }
    stepOutRequest(response, args) {
        unreal.sendStepOut();
        this.sendResponse(response);
    }
    restartRequest(response, args) {
        //unreal.sendEngineBreak();
        this.sendResponse(response);
    }
    evaluateRequest(response, args) {
        unreal.sendRequestEvaluate(args.expression, args.frameId);
        if (!this.waitingEvaluateRequests)
            this.waitingEvaluateRequests = new Array();
        this.waitingEvaluateRequests.push({
            expression: args.expression,
            frameId: args.frameId,
            response: response,
        });
    }
    receiveEvaluate(msg) {
        let id = "";
        if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0) {
            id = this.waitingEvaluateRequests[0].expression;
            if (!/^[0-9]+:/.test(id)) {
                id = this.waitingEvaluateRequests[0].frameId + ":" + id;
            }
        }
        let name = msg.readString();
        let value = msg.readString();
        let type = msg.readString();
        let bHasMembers = msg.readBool();
        if (this.waitingEvaluateRequests && this.waitingEvaluateRequests.length > 0) {
            let response = this.waitingEvaluateRequests[0].response;
            this.waitingEvaluateRequests.splice(0, 1);
            if (value.length == 0) {
            }
            else {
                response.body = {
                    result: value,
                    variablesReference: bHasMembers ? this._variableHandles.create(id) : 0,
                };
            }
            this.sendResponse(response);
        }
    }
    //---- helpers
    createSource(filePath) {
        return new vscode_debugadapter_1.Source(path_1.basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'as-adapter-data');
    }
}
// we don't support multiple threads, so we can use a hardcoded ID for the default thread
ASDebugSession.THREAD_ID = 1;
exports.ASDebugSession = ASDebugSession;
//# sourceMappingURL=debug.js.map