/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { readFileSync } from 'fs';
import { EventEmitter } from 'events';

export interface ASBreakpoint {
}

export class ASDebugRuntime extends EventEmitter
{
	constructor() {
		super();
	}

    public start(program: string, stopOnEntry: boolean)
    {
		this.sendEvent("output", "START", "file", 1, 0);
		this.sendEvent("stopOnBreakpoint");
	}

    public continue(reverse = false)
    {
		this.sendEvent("output", "CONTINUE", "file", 1, 0);
	}

    public step(reverse = false, event = 'stopOnStep')
    {
		this.sendEvent("output", "STEP", "file", 1, 0);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
    public stack(startFrame: number, endFrame: number): any
    {
        const frames = new Array<any>();
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

    public setBreakPoint(path: string, line: number) : ASBreakpoint
    {
		const bp = <ASBreakpoint> {};
		return bp;
	}

    public clearBreakPoint(path: string, line: number) : ASBreakpoint | undefined
    {
		return undefined;
	}

    public clearASBreakpoints(path: string) : void
    {
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

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}