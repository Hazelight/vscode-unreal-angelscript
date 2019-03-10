"use strict";
/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
class ASDebugRuntime extends events_1.EventEmitter {
    constructor() {
        super();
    }
    start(program, stopOnEntry) {
        this.sendEvent("output", "START", "file", 1, 0);
        this.sendEvent("stopOnBreakpoint");
    }
    continue(reverse = false) {
        this.sendEvent("output", "CONTINUE", "file", 1, 0);
    }
    step(reverse = false, event = 'stopOnStep') {
        this.sendEvent("output", "STEP", "file", 1, 0);
    }
    /**
     * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
     */
    stack(startFrame, endFrame) {
        const frames = new Array();
        frames.push({
            index: 0,
            name: "Test Frame",
            file: "file",
            line: 10
        });
        /*for (let i = startFrame; i < Math.min(endFrame, words.length); i++)
        {
            const name = words[i];	// use a word of the line as the stackframe name
            frames.push({
                index: i,
                name: `${name}(${i})`,
                file: this._sourceFile,
                line: this._currentLine
            });
        }*/
        return {
            frames: frames,
            count: 1
        };
    }
    setBreakPoint(path, line) {
        const bp = {};
        return bp;
    }
    clearBreakPoint(path, line) {
        return undefined;
    }
    clearASBreakpoints(path) {
    }
    /**
    private run(reverse = false, stepEvent?: string)
    {
        if (reverse) {
            for (let ln = this._currentLine-1; ln >= 0; ln--) {
                if (this.fireEventsForLine(ln, stepEvent)) {
                    this._currentLine = ln;
                    return;
                }
            }
            // no more lines: stop at first line
            this._currentLine = 0;
            this.sendEvent('stopOnEntry');
        } else {
            for (let ln = this._currentLine+1; ln < this._sourceLines.length; ln++) {
                if (this.fireEventsForLine(ln, stepEvent)) {
                    this._currentLine = ln;
                    return true;
                }
            }
            // no more lines: run to end
            this.sendEvent('end');
        }
    }*/
    /**
     * Fire events if line has a breakpoint or the word 'exception' is found.
     * Returns true is execution needs to stop.
     */
    /*private fireEventsForLine(ln: number, stepEvent?: string): boolean {

        const line = this._sourceLines[ln].trim();

        // if 'log(...)' found in source -> send argument to debug console
        const matches = /log\((.*)\)/.exec(line);
        if (matches && matches.length === 2) {
            this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
        }

        // if word 'exception' found in source -> throw exception
        if (line.indexOf('exception') >= 0) {
            this.sendEvent('stopOnException');
            return true;
        }

        // is there a breakpoint?
        const breakpoints = this._breakPoints.get(this._sourceFile);
        if (breakpoints) {
            const bps = breakpoints.filter(bp => bp.line === ln);
            if (bps.length > 0) {

                // send 'stopped' event
                this.sendEvent('stopOnASBreakpoint');

                // the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
                // if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
                if (!bps[0].verified) {
                    bps[0].verified = true;
                    this.sendEvent('breakpointValidated', bps[0]);
                }
                return true;
            }
        }

        // non-empty line
        if (stepEvent && line.length > 0) {
            this.sendEvent(stepEvent);
            return true;
        }

        // nothing interesting found -> continue
        return false;
    }*/
    sendEvent(event, ...args) {
        setImmediate(_ => {
            this.emit(event, ...args);
        });
    }
}
exports.ASDebugRuntime = ASDebugRuntime;
//# sourceMappingURL=debugRuntime.js.map