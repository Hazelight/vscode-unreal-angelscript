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
    CreateBlueprint,

    ReplaceAssetDefinition,
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

export function buildOpenAssets(assets : Array<string>, className : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.FindAssets, 4);

    let parts = [head, writeInt(1), writeInt(assets.length)];
    for (let asset of assets)
        parts.push(writeString(asset));
    parts.push(writeString(className));
    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}

export function buildCreateBlueprint(className : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.CreateBlueprint, 4);

    let parts = [head, writeString(className)];
    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}