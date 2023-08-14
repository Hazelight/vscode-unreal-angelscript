'use strict';

import { Socket } from 'net';
import { EventEmitter } from 'events';

export enum MessageType
{
    Diagnostics = 0,
    RequestDebugDatabase,
    DebugDatabase,

    StartDebugging,
    StopDebugging,
    Pause,
    Continue,

    RequestCallStack,
    CallStack,

    ClearBreakpoints,
    SetBreakpoint,

    HasStopped,
    HasContinued,

    StepOver,
    StepIn,
    StepOut,

    EngineBreak,

    RequestVariables,
    Variables,

    RequestEvaluate,
    Evaluate,
    GoToDefinition,

    BreakOptions,
    RequestBreakFilters,
    BreakFilters,

    Disconnect,

    DebugDatabaseFinished,
    AssetDatabaseInit,
    AssetDatabase,
    AssetDatabaseFinished,
    FindAssets,
    DebugDatabaseSettings,

    PingAlive,

    DebugServerVersion,
}

export class Message
{
    type : number;
    offset : number;
    buffer : Buffer;
    size : number;
    remainingSize : number;

    constructor(type : number, offset : number, size : number, buffer : Buffer)
    {
        this.type = type;
        this.offset = offset;
        this.buffer = buffer;
        this.size = size;
    }

    readInt() : number
    {
        let value = this.buffer.readIntLE(this.offset, 4);
        this.offset += 4;
        return value;
    }

    readByte() : number
    {
        let value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
    }

    readBool() : boolean
    {
        return this.readInt() != 0;
    }

    readString() : string
    {
        let num = this.readInt();
        let ucs2 = num < 0;
        if(ucs2)
        {
            num = -num;
        }

        if(ucs2)
        {
            let str = this.buffer.toString("utf16le", this.offset, this.offset + num * 2);
            this.offset += num * 2;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
        else
        {
            let str = this.buffer.toString("utf8", this.offset, this.offset + num);
            this.offset += num;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
    }
}

function writeInt(value : number) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(value, 0);
    return newBuffer;
}

function writeString(str : string) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length+1, 0);
    return Buffer.concat([newBuffer, Buffer.from(str+"\0", "binary")]);
}

let pendingBuffer : Buffer = Buffer.alloc(0);

export function readMessages(buffer : Buffer) : Array<Message>
{
    let list : Array<Message> = [];
    let offset = 0;

    pendingBuffer = Buffer.concat([pendingBuffer, buffer])

    while (pendingBuffer.length >= 5)
    {
        let offset = 0;
        let msglen = pendingBuffer.readUIntLE(offset, 4);
        offset += 4;
        let msgtype = pendingBuffer.readInt8(offset);
        offset += 1;

        if (msglen <= pendingBuffer.length - offset)
        {
            list.push(new Message(msgtype, offset, msglen, pendingBuffer));
            pendingBuffer = pendingBuffer.slice(offset + msglen);
        }
        else
        {
            return list;
        }
    }

    return list;
}

// Create a connection to unreal
let unreal : Socket | null = null;
export let connected = false;
export let events = new EventEmitter();

export function connect(hostname: string, port : number)
{
    if (unreal != null)
    {
        sendDisconnect();
        unreal.destroy();
    }
    unreal = new Socket;
    connected = true;

	//connection.console.log('Connecting to unreal editor...');
	unreal.connect(port, hostname, function()
	{
		//connection.console.log('Connection to unreal editor established.');
	});

	unreal.on("data", function(data : Buffer) {
		let messages : Array<Message> = readMessages(data);
		for (let msg of messages)
		{
            if (msg.type == MessageType.CallStack)
            {
                events.emit("CallStack", msg);
            }
            else if (msg.type == MessageType.HasStopped)
            {
                events.emit("Stopped", msg);
            }
            else if (msg.type == MessageType.HasContinued)
            {
                events.emit("Continued", msg);
            }
            else if (msg.type == MessageType.Variables)
            {
                events.emit("Variables", msg);
            }
            else if (msg.type == MessageType.Evaluate)
            {
                events.emit("Evaluate", msg);
            }
            else if (msg.type == MessageType.BreakFilters)
            {
                events.emit("BreakFilters", msg);
            }
            else if (msg.type == MessageType.SetBreakpoint)
            {
                events.emit("SetBreakpoint", msg);
            }
            else if (msg.type == MessageType.DebugServerVersion)
            {
                events.emit("DebugServerVersion", msg);
            }
		}
	});

	unreal.on("error", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;

            events.emit("Closed");
		}
	});

	unreal.on("close", function() {
		if (unreal != null)
		{
			unreal.destroy();
			unreal = null;

            events.emit("Closed");
		}
	});
}

export function disconnect()
{
    sendDisconnect();
    unreal.destroy();
    unreal = null;
    connected = false;
}

export function sendPause()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Pause, 4);

    unreal.write(msg);
}

export function sendContinue()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Continue, 4);

    unreal.write(msg);
}

export function sendRequestBreakFilters()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestBreakFilters, 4);

    unreal.write(msg);
}

export function sendRequestCallStack()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestCallStack, 4);

    unreal.write(msg);
}

export function sendDisconnect()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);

    unreal.write(msg);
}

export function sendStartDebugging(version: number)
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StartDebugging, 4);
    msg = Buffer.concat([msg, writeInt(version)]);

    msg.writeUInt32LE(msg.length - 4, 0);

    unreal.write(msg);
}

export function sendStopDebugging()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StopDebugging, 4);

    unreal.write(msg);
}

export function clearBreakpoints(pathname : string, moduleName : string)
{
    let msg = Buffer.alloc(5);
    msg.writeUInt8(MessageType.ClearBreakpoints, 4);
    msg = Buffer.concat([msg, writeString(pathname), writeString(moduleName)]);

    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}

export function setBreakpoint(id : number, pathname : string, line : number, moduleName : string)
{
    let head = Buffer.alloc(5);
    head.writeUInt32LE(1, 0);
    head.writeUInt8(MessageType.SetBreakpoint, 4);

    let msg = Buffer.concat([
        head, writeString(pathname), writeInt(line), writeInt(id), writeString(moduleName)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}

export function sendStepIn()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepIn, 4);

    unreal.write(msg);
}

export function sendStepOver()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepOver, 4);

    unreal.write(msg);
}

export function sendStepOut()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepOut, 4);

    unreal.write(msg);
}

export function sendEngineBreak()
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.EngineBreak, 4);

    unreal.write(msg);
}

export function sendRequestVariables(path : string)
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestVariables, 4);

    let msg = Buffer.concat([
        head, writeString(path)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}

export function sendRequestEvaluate(path : string, frameId : number)
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestEvaluate, 4);

    let msg = Buffer.concat([
        head, writeString(path), writeInt(frameId)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}

export function sendBreakOptions(filters : string[])
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.BreakOptions, 4);

    let parts = [head, writeInt(filters.length)];
    for (let filter of filters)
    {
        parts.push(writeString(filter));
    }

    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);

    unreal.write(msg);
}