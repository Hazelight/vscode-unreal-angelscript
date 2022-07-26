import * as typedb from './database';
import * as scriptfiles from './as_parser';

import { Range, Position, Location, SemanticTokens, SemanticTokensBuilder, SemanticTokensDelta } from "vscode-languageserver";

export let SemanticTypes : any = {};
export let SemanticTypeList : Array<string> = [
    "namespace", "template_base_type", "parameter",
    "local_variable", "member_variable", "member_accessor", "global_variable",
    "global_accessor", "member_function", "global_function", "unknown_error",
    "typename", "typename_actor", "typename_component", "typename_struct", "typename_event",
    "typename_delegate", "typename_primitive", "unimported_symbol", "access_specifier"
];

for (let i = 0, Count = SemanticTypeList.length; i < Count; ++i)
    SemanticTypes[SemanticTypeList[i]] = i;

let PrevTokens : SemanticTokens = null;
export function HighlightSymbols(asmodule : scriptfiles.ASModule) : SemanticTokens
{
    let builder = new SemanticTokensBuilder();
    BuildSymbols(asmodule, builder);

    let tokens = builder.build();
    PrevTokens = tokens;
    return tokens;
}

export function HighlightSymbolsDelta(asmodule : scriptfiles.ASModule, previousId : string = null) : SemanticTokens | SemanticTokensDelta
{
    let builder = new SemanticTokensBuilder();
    BuildSymbols(asmodule, builder);
    let newTokens = builder.build();
    return newTokens;

    // If the new tokens are identical to the previous ones, don't bother sending them
    if (previousId && PrevTokens.resultId == previousId)
    {
        let identicalToPrevious = true;
        if (PrevTokens.data.length != newTokens.data.length)
        {
            identicalToPrevious = false;
        }
        else
        {
            for (let i = 0; i < newTokens.data.length; ++i)
            {
                if (PrevTokens.data[i] != newTokens.data[i])
                {
                    identicalToPrevious = false;
                    break;
                }
            }
        }

        if (identicalToPrevious)
        {
            return <SemanticTokensDelta> {
                edits: [],
                resultId: newTokens.resultId,
            };
        }
    }

    PrevTokens = newTokens;
    return newTokens;
}

function BuildSymbols(asmodule : scriptfiles.ASModule, builder : SemanticTokensBuilder)
{
    for (let symbol of asmodule.semanticSymbols)
    {
        if (symbol.noColor)
            continue;

        let pos = asmodule.getPosition(symbol.start);
        let length = symbol.end - symbol.start;

        let type = -1;
        if (symbol.isUnimported)
        {
            type = SemanticTypes.unimported_symbol;
        }
        else if (symbol.type == scriptfiles.ASSymbolType.Typename
            || symbol.type == scriptfiles.ASSymbolType.Namespace)
        {
            let symName = symbol.symbol_name;
            if (symbol.type == scriptfiles.ASSymbolType.Namespace)
                symName = symbol.symbol_name.substr(2);
            
            let classification = typedb.DBTypeClassification.Other;

            if (symbol.type == scriptfiles.ASSymbolType.Typename)
            {
                let dbtype = typedb.GetTypeByName(symbol.symbol_name);
                if (dbtype)
                    classification = dbtype.getTypeClassification();
            }
            else if (symbol.type == scriptfiles.ASSymbolType.Namespace)
            {
                let namespace = typedb.LookupNamespace(null, symbol.symbol_name);
                if (namespace)
                {
                    let dbtype = namespace.getShadowedType();
                    if (dbtype)
                        classification = dbtype.getTypeClassification();
                }
            }
            else if (symbol.symbol_name == "auto")
            {
                classification = typedb.DBTypeClassification.Primitive;
            }

            switch (classification)
            {
                case typedb.DBTypeClassification.Component:
                    type = SemanticTypes.typename_component;
                break;
                case typedb.DBTypeClassification.Actor:
                    type = SemanticTypes.typename_actor;
                break;
                case typedb.DBTypeClassification.Struct:
                    type = SemanticTypes.typename_struct;
                break;
                case typedb.DBTypeClassification.Event:
                    type = SemanticTypes.typename_event;
                break;
                case typedb.DBTypeClassification.Delegate:
                    type = SemanticTypes.typename_delegate;
                break;
                case typedb.DBTypeClassification.Primitive:
                    type = SemanticTypes.typename_primitive;
                break;
                case typedb.DBTypeClassification.Other:
                default:
                    if (symbol.type == scriptfiles.ASSymbolType.Namespace)
                        type = SemanticTypes.namespace;
                    else
                        type = SemanticTypes.typename;
                break;
            }
        }
        else switch (symbol.type)
        {
            case scriptfiles.ASSymbolType.UnknownError:
                type = SemanticTypes.unknown_error;
            break;
            case scriptfiles.ASSymbolType.TemplateBaseType:
                type = SemanticTypes.templae_base_type;
            break;
            case scriptfiles.ASSymbolType.Parameter:
                type = SemanticTypes.parameter;
            break;
            case scriptfiles.ASSymbolType.LocalVariable:
                type = SemanticTypes.local_variable;
            break;
            case scriptfiles.ASSymbolType.MemberVariable:
                type = SemanticTypes.member_variable;
            break;
            case scriptfiles.ASSymbolType.MemberAccessor:
                type = SemanticTypes.member_accessor;
            break;
            case scriptfiles.ASSymbolType.GlobalVariable:
                type = SemanticTypes.global_variable;
            break;
            case scriptfiles.ASSymbolType.GlobalAccessor:
                type = SemanticTypes.global_accessor;
            break;
            case scriptfiles.ASSymbolType.MemberFunction:
                type = SemanticTypes.member_function;
            break;
            case scriptfiles.ASSymbolType.GlobalFunction:
                type = SemanticTypes.global_function;
            break;
            case scriptfiles.ASSymbolType.AccessSpecifier:
                type = SemanticTypes.access_specifier;
            break;
        }

        if (type == -1)
            continue;

        let modifiers = 0;
        builder.push(pos.line, pos.character, length, type, modifiers);
    }
}