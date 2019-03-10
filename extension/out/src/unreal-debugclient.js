'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const net_1 = require("net");
const events_1 = require("events");
var MessageType;
(function (MessageType) {
    MessageType[MessageType["Diagnostics"] = 0] = "Diagnostics";
    MessageType[MessageType["RequestDebugDatabase"] = 1] = "RequestDebugDatabase";
    MessageType[MessageType["DebugDatabase"] = 2] = "DebugDatabase";
    MessageType[MessageType["StartDebugging"] = 3] = "StartDebugging";
    MessageType[MessageType["StopDebugging"] = 4] = "StopDebugging";
    MessageType[MessageType["Pause"] = 5] = "Pause";
    MessageType[MessageType["Continue"] = 6] = "Continue";
    MessageType[MessageType["RequestCallStack"] = 7] = "RequestCallStack";
    MessageType[MessageType["CallStack"] = 8] = "CallStack";
    MessageType[MessageType["ClearBreakpoints"] = 9] = "ClearBreakpoints";
    MessageType[MessageType["SetBreakpoint"] = 10] = "SetBreakpoint";
    MessageType[MessageType["HasStopped"] = 11] = "HasStopped";
    MessageType[MessageType["HasContinued"] = 12] = "HasContinued";
    MessageType[MessageType["StepOver"] = 13] = "StepOver";
    MessageType[MessageType["StepIn"] = 14] = "StepIn";
    MessageType[MessageType["StepOut"] = 15] = "StepOut";
    MessageType[MessageType["EngineBreak"] = 16] = "EngineBreak";
    MessageType[MessageType["RequestVariables"] = 17] = "RequestVariables";
    MessageType[MessageType["Variables"] = 18] = "Variables";
    MessageType[MessageType["RequestEvaluate"] = 19] = "RequestEvaluate";
    MessageType[MessageType["Evaluate"] = 20] = "Evaluate";
    MessageType[MessageType["GoToDefinition"] = 21] = "GoToDefinition";
    MessageType[MessageType["BreakOptions"] = 22] = "BreakOptions";
    MessageType[MessageType["RequestBreakFilters"] = 23] = "RequestBreakFilters";
    MessageType[MessageType["BreakFilters"] = 24] = "BreakFilters";
    MessageType[MessageType["Disconnect"] = 25] = "Disconnect";
})(MessageType = exports.MessageType || (exports.MessageType = {}));
class Message {
    constructor(type, offset, size, buffer) {
        this.type = type;
        this.offset = offset;
        this.buffer = buffer;
        this.size = size;
    }
    readInt() {
        let value = this.buffer.readIntLE(this.offset, 4);
        this.offset += 4;
        return value;
    }
    readByte() {
        let value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        return value;
    }
    readBool() {
        return this.readInt() != 0;
    }
    readString() {
        let num = this.readInt();
        let ucs2 = num < 0;
        if (ucs2) {
            num = -num;
        }
        if (ucs2) {
            let str = this.buffer.toString("utf16le", this.offset, this.offset + num * 2);
            this.offset += num * 2;
            if (str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
        else {
            let str = this.buffer.toString("utf8", this.offset, this.offset + num);
            this.offset += num;
            if (str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            return str;
        }
    }
}
exports.Message = Message;
function writeInt(value) {
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(value, 0);
    return newBuffer;
}
function writeString(str) {
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length + 1, 0);
    return Buffer.concat([newBuffer, new Buffer(str + "\0", "binary")]);
}
let pendingMessage = null;
function readMessages(buffer) {
    let list = [];
    let offset = 0;
    if (pendingMessage != null) {
        let wantSize = pendingMessage.remainingSize;
        pendingMessage.buffer = Buffer.concat([pendingMessage.buffer, buffer]);
        if (wantSize > buffer.length) {
            pendingMessage.remainingSize -= buffer.length;
            return list;
        }
        else {
            pendingMessage.remainingSize = 0;
            offset += wantSize;
            list.push(pendingMessage);
            pendingMessage = null;
        }
    }
    while (offset < buffer.length) {
        let msglen = buffer.readUIntLE(offset, 4);
        offset += 4;
        let msgtype = buffer.readInt8(offset);
        offset += 1;
        if (msglen <= buffer.length - offset) {
            list.push(new Message(msgtype, offset, msglen, buffer));
            offset += msglen;
        }
        else {
            pendingMessage = new Message(msgtype, offset, msglen, buffer);
            pendingMessage.remainingSize = msglen - (buffer.length - offset);
            return list;
        }
    }
    return list;
}
exports.readMessages = readMessages;
// Create a connection to unreal
let unreal = null;
exports.connected = false;
exports.events = new events_1.EventEmitter();
function connect() {
    if (unreal != null) {
        sendDisconnect();
        unreal.destroy();
    }
    unreal = new net_1.Socket;
    exports.connected = true;
    //connection.console.log('Connecting to unreal editor...');
    unreal.connect(27099, "localhost", function () {
        //connection.console.log('Connection to unreal editor established.');
    });
    unreal.on("data", function (data) {
        let messages = readMessages(data);
        for (let msg of messages) {
            if (msg.type == MessageType.CallStack) {
                exports.events.emit("CallStack", msg);
            }
            else if (msg.type == MessageType.HasStopped) {
                exports.events.emit("Stopped", msg);
            }
            else if (msg.type == MessageType.HasContinued) {
                exports.events.emit("Continued", msg);
            }
            else if (msg.type == MessageType.Variables) {
                exports.events.emit("Variables", msg);
            }
            else if (msg.type == MessageType.Evaluate) {
                exports.events.emit("Evaluate", msg);
            }
            else if (msg.type == MessageType.BreakFilters) {
                exports.events.emit("BreakFilters", msg);
            }
        }
    });
    unreal.on("error", function () {
        if (unreal != null) {
            unreal.destroy();
            unreal = null;
            exports.events.emit("Closed");
        }
    });
    unreal.on("close", function () {
        if (unreal != null) {
            unreal.destroy();
            unreal = null;
            exports.events.emit("Closed");
        }
    });
}
exports.connect = connect;
function disconnect() {
    sendDisconnect();
    unreal.destroy();
    unreal = null;
    exports.connected = false;
}
exports.disconnect = disconnect;
function sendPause() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Pause, 4);
    unreal.write(msg);
}
exports.sendPause = sendPause;
function sendContinue() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Continue, 4);
    unreal.write(msg);
}
exports.sendContinue = sendContinue;
function sendRequestBreakFilters() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestBreakFilters, 4);
    unreal.write(msg);
}
exports.sendRequestBreakFilters = sendRequestBreakFilters;
function sendRequestCallStack() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestCallStack, 4);
    unreal.write(msg);
}
exports.sendRequestCallStack = sendRequestCallStack;
function sendDisconnect() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);
    unreal.write(msg);
}
exports.sendDisconnect = sendDisconnect;
function sendStartDebugging() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StartDebugging, 4);
    unreal.write(msg);
}
exports.sendStartDebugging = sendStartDebugging;
function sendStopDebugging() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StopDebugging, 4);
    unreal.write(msg);
}
exports.sendStopDebugging = sendStopDebugging;
function clearBreakpoints(pathname) {
    let msg = Buffer.alloc(5);
    msg.writeUInt8(MessageType.ClearBreakpoints, 4);
    msg = Buffer.concat([msg, writeString(pathname)]);
    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}
exports.clearBreakpoints = clearBreakpoints;
function setBreakpoint(pathname, line) {
    let head = Buffer.alloc(5);
    head.writeUInt32LE(1, 0);
    head.writeUInt8(MessageType.SetBreakpoint, 4);
    let msg = Buffer.concat([
        head, writeString(pathname), writeInt(line)
    ]);
    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}
exports.setBreakpoint = setBreakpoint;
function sendStepIn() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepIn, 4);
    unreal.write(msg);
}
exports.sendStepIn = sendStepIn;
function sendStepOver() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepOver, 4);
    unreal.write(msg);
}
exports.sendStepOver = sendStepOver;
function sendStepOut() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.StepOut, 4);
    unreal.write(msg);
}
exports.sendStepOut = sendStepOut;
function sendEngineBreak() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.EngineBreak, 4);
    unreal.write(msg);
}
exports.sendEngineBreak = sendEngineBreak;
function sendRequestVariables(path) {
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestVariables, 4);
    let msg = Buffer.concat([
        head, writeString(path)
    ]);
    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}
exports.sendRequestVariables = sendRequestVariables;
function sendRequestEvaluate(path, frameId) {
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.RequestEvaluate, 4);
    let msg = Buffer.concat([
        head, writeString(path), writeInt(frameId)
    ]);
    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}
exports.sendRequestEvaluate = sendRequestEvaluate;
function sendBreakOptions(filters) {
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.BreakOptions, 4);
    let parts = [head, writeInt(filters.length)];
    for (let filter of filters) {
        parts.push(writeString(filter));
    }
    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);
    unreal.write(msg);
}
exports.sendBreakOptions = sendBreakOptions;
//# sourceMappingURL=unreal-debugclient.js.map