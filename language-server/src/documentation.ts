import {
    MarkupContent, MarkupKind,
} from 'vscode-languageserver';

import * as typedb from './database';

/**
 * Create a markdown-formatted documentation string for a function, parsing out some common javadoc-style annotations.
 */
export function FormatFunctionDocumentation(doc : string, dbmethod? : typedb.DBMethod, activeArg? : number, italicize = true) : string
{
    if (!doc)
        return "";

    let lines = doc.split("\n");
    let result = "";

    for (let line of lines)
    {
        // Remove whitespace
        line = line.trimEnd();
        let trimmed = line.trimStart();

        // Check if this is a parameter:
        if (trimmed.startsWith("@param"))
        {
            let match = trimmed.match(/@param\s+([A-Za-z0-9]+)\s+(.*)/);
            if (match)
            {
                let argIndex = -1;
                let refArg = null;
                if (dbmethod.args)
                {
                    for (let i = 0, count = dbmethod.args.length; i < count; ++i)
                    {
                        if (dbmethod.args[i].name == match[1])
                        {
                            argIndex = i;
                            refArg = dbmethod.args[i];
                            break;
                        }
                    }
                }

                if (argIndex >= 0 && activeArg !== null && activeArg == argIndex)
                    result += "* **`"+match[1]+"` - "+match[2]+"**\n\n";
                else if (italicize)
                    result += "* `"+match[1]+"` - *"+match[2]+"*\n\n";
                else
                    result += "* `"+match[1]+"` - "+match[2]+"\n\n";
                continue;
            }
        }

        // Check if it's the return value
        if (trimmed.startsWith("@return"))
        {
            if (italicize)
                result += "**Return:** *"+trimmed.substring(7).trim()+"*\n\n";
            else
                result += "**Return:** "+trimmed.substring(7).trim()+"\n\n";
            continue;
        }

        // Check if it's a note
        if (trimmed.startsWith("@note"))
        {
            if (italicize)
                result += "️**Note:** *"+trimmed.substring(5).trim()+"*\n\n";
            else
                result += "ℹ**Note:** "+trimmed.substring(5).trim()+"\n\n";
            continue;
        }

        // Check if it's a note
        if (trimmed.startsWith("@see"))
        {
            if (italicize)
                result += "️**See:** *"+trimmed.substring(4).trim()+"*\n\n";
            else
                result += "ℹ**See:** "+trimmed.substring(4).trim()+"\n\n";
            continue;
        }

        // Otherwise, it's just a documentation line that should be in italics
        if (line.length != 0)
        {
            if (italicize)
            {
                if (trimmed.length < line.length)
                    result += "  *"+trimmed+"*\n\n";
                else
                    result += "*"+trimmed+"*\n\n";
            }
            else
            {
                if (trimmed.length < line.length)
                    result += "  "+trimmed+"\n\n";
                else
                    result += trimmed+"\n\n";
            }
        }
        else
            result += "\n\n";
    }

    return result;
}

/**
 * Create a markdown-formatted documentation string for a property, parsing out some common javadoc-style annotations.
 */
export function FormatPropertyDocumentation(doc : string, italicize = true) : string
{
    if (!doc)
        return "";

    let lines = doc.split("\n");
    let result = "";

    for (let line of lines)
    {
        // Remove whitespace
        line = line.trimEnd();
        let trimmed = line.trimStart();

        // Check if it's a note
        if (trimmed.startsWith("@note"))
        {
            if (italicize)
                result += "️**Note:** *"+trimmed.substring(5).trim()+"*\n\n";
            else
                result += "ℹ**Note:** "+trimmed.substring(5).trim()+"\n\n";
            continue;
        }

        // Check if it's a note
        if (trimmed.startsWith("@see"))
        {
            if (italicize)
                result += "️**See:** *"+trimmed.substring(4).trim()+"*\n\n";
            else
                result += "ℹ**See:** "+trimmed.substring(4).trim()+"\n\n";
            continue;
        }

        // Otherwise, it's just a documentation line that should be in italics
        if (line.length != 0)
        {
            if (italicize)
            {
                if (trimmed.length < line.length)
                    result += "  *"+trimmed+"*\n\n";
                else
                    result += "*"+trimmed+"*\n\n";
            }
            else
            {
                if (trimmed.length < line.length)
                    result += "  "+trimmed+"\n\n";
                else
                    result += trimmed+"\n\n";
            }
        }
        else
            result += "\n\n";
    }

    return result;
}