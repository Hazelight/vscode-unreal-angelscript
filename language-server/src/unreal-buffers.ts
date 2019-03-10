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

    Disconnect
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

let pendingMessage : Message = null;

export function readMessages(buffer : Buffer) : Array<Message>
{
    let list : Array<Message> = [];
    let offset = 0;

    if (pendingMessage != null)
    {
        let wantSize = pendingMessage.remainingSize;
        pendingMessage.buffer = Buffer.concat([pendingMessage.buffer, buffer]);

        if (wantSize > buffer.length)
        {
            pendingMessage.remainingSize -= buffer.length;
            return list;
        }
        else
        {
            pendingMessage.remainingSize = 0;
            offset += wantSize;

            list.push(pendingMessage);
            pendingMessage = null;
        }
    }

    while (offset < buffer.length)
    {
        let msglen = buffer.readUIntLE(offset, 4);
        offset += 4;
        let msgtype = buffer.readInt8(offset);
        offset += 1;

        if (msglen <= buffer.length - offset)
        {
            list.push(new Message(msgtype, offset, msglen, buffer));
            offset += msglen;
        }
        else
        {
            pendingMessage = new Message(msgtype, offset, msglen, buffer);
            pendingMessage.remainingSize = msglen - (buffer.length - offset);
            return list;
        }
    }
    return list;
}

function writeString(str : string) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length+1, 0);
    return Buffer.concat([newBuffer, new Buffer(str+"\0", "binary")]);
}

export function buildGoTo(typename : string, symbolname : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.GoToDefinition, 4);

    let msg = Buffer.concat([
        head, writeString(typename), writeString(symbolname)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}

export function buildDisconnect() : Buffer
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);

    return msg;
}
