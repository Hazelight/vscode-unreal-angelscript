"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
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
function writeString(str) {
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length + 1, 0);
    return Buffer.concat([newBuffer, new Buffer(str + "\0", "binary")]);
}
function buildGoTo(typename, symbolname) {
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.GoToDefinition, 4);
    let msg = Buffer.concat([
        head, writeString(typename), writeString(symbolname)
    ]);
    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}
exports.buildGoTo = buildGoTo;
function buildDisconnect() {
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);
    return msg;
}
exports.buildDisconnect = buildDisconnect;
//# sourceMappingURL=unreal-buffers.js.map