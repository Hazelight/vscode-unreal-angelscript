import { TextDocument, } from "vscode-languageserver-textdocument";
import { Range, Position, CodeLensResolveRequest, } from "vscode-languageserver";
import * as fs from 'fs';
import * as glob from 'glob';

import * as nearley from 'nearley';
import { performance } from "perf_hooks";

let grammar_statement = require("../grammar/grammar_statement.js");
let grammar_class_statement = require("../grammar/grammar_class_statement.js");
let grammar_global_statement = require("../grammar/grammar_global_statement.js");
let grammar_enum_statement = require("../grammar/grammar_enum_statement.js");
let node_types = require("../grammar/node_types.js");

enum ASScopeType
{
    Global,
    Class,
    Function,
    Enum,
    Other,
    Namespace
}

class ASModule
{
    textDocument : TextDocument;
    modulename : string;
    filename : string;
    uri : string;

    rootscope : ASScope;
};

class ASElement
{
    previous : ASElement = null;
    next : ASElement = null;
};

class ASScope extends ASElement
{
    module : ASModule;
    range : Range;

    parsed : boolean = false;
    statements : ASStatement[] = [];
    scopes : ASScope[] = [];

    scopetype : ASScopeType = null;
    parentscope : ASScope = null;
};

class ASStatement extends ASElement
{
    content : string;
    range : Range;
    ast : any = null;
    parsed : boolean = false;
}

function CreateModule(modulename : string, filename : string, textDocument : TextDocument) : ASModule
{
    let module = new ASModule;
    module.textDocument = textDocument;
    module.uri = textDocument.uri;
    module.filename = filename;
    module.modulename = modulename;

    module.rootscope = new ASScope;
    module.rootscope.module = module;
    module.rootscope.range = Range.create(
        Position.create(0, 0),
        textDocument.positionAt(textDocument.getText().length)
    );

    return module;
}

function ParseScopeIntoStatements(scope : ASScope)
{
    let module = scope.module;
    let content = module.textDocument.getText(scope.range);
    let length = content.length;

    scope.parsed = true;

    let linenum = scope.range.start.line;
    let charnum = scope.range.start.character;

    let depth_brace = 0;
    let depth_paren = 0;
    let scope_start : Position = null;

    let statement_start : Position = Position.create(linenum, charnum);
    let log_start = statement_start;

    let in_preprocessor_directive = false;
    let in_line_comment = false;
    let in_block_comment = false;
    let in_dq_string = false;
    let in_sq_string = false;
    let in_escape_sequence = false;

    let cur_element : ASElement = null;
    function finishElement(element : ASElement)
    {
        element.previous = cur_element;
        if (cur_element)
            cur_element.next = element;
        cur_element = element;
    }

    function debugLog(text : string)
    {
        return;
        console.log(module.textDocument.getText(Range.create(
            log_start,
            Position.create(linenum, charnum+1)
        )));
        console.log("== "+text);

        log_start = Position.create(linenum, charnum);
    }

    function finishStatement()
    {
        if (statement_start == null)
            return;

        if (statement_start.line != linenum || statement_start.character != charnum)
        {
            let range = Range.create(
                statement_start,
                Position.create(linenum, charnum)
            );
            let content = module.textDocument.getText(range);
            //debugLog("statement");

            if (content.length != 0 && !/^[ \t\r\n]*$/.test(content))
            {
                let statement = new ASStatement;
                statement.content = content;
                statement.range = range;

                scope.statements.push(statement);
                finishElement(statement);
            }
        }

        statement_start = Position.create(linenum, charnum+1);
    }

    function restartStatement()
    {
        statement_start = Position.create(linenum, charnum+1);
    }

    for (let offset = 0; offset < length; ++offset, ++charnum)
    {
        let curchar = content[offset];

        // Start the next line
        if (curchar == '\n')
        {
            if (in_preprocessor_directive)
                in_preprocessor_directive = false;

            if (in_line_comment)
                in_line_comment = false;

            linenum += 1;
            charnum = -1;
            continue;
        }

        if (in_line_comment)
            continue;

        if (in_block_comment)
        {
            if (curchar == '/' && content[offset-1] == '*')
            {
                in_block_comment = false;
                //debugLog("stop_block_comment");
            }
            continue;
        }

        if (in_sq_string)
        {
            if (!in_escape_sequence && curchar == '\'')
            {
                //debugLog("stop_sq_string");
                in_sq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = true;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_dq_string)
        {
            if (!in_escape_sequence && curchar == '"')
            {
                debugLog("start_sq_string");
                in_dq_string = false;
            }

            if (curchar == '\\')
                in_escape_sequence = true;
            else
                in_escape_sequence = false;
            continue;
        }

        if (in_preprocessor_directive)
            continue;

        // String Literals
        if (curchar == '"')
        {
            in_dq_string = true;
            //debugLog("start_dq_string");
            continue;
        }

        if (curchar == '\'')
        {
            in_sq_string = true;
            //debugLog("start_sq_string");
            continue;
        }

        // Comments
        if (curchar == '/' && offset+1 < length && content[offset+1] == '/')
        {
            //debugLog("start_line_comment");
            in_line_comment = true;
            continue;
        }

        if (curchar == '/' && offset+1 < length && content[offset+1] == '*')
        {
            //debugLog("start_block_comment");
            in_block_comment = true;
            continue;
        }

        // Preprocessor directives
        if (curchar == '#' && depth_brace == 0)
        {
            //debugLog("start_directive");
            in_preprocessor_directive = true;
            continue;
        }

        // We could be starting a scope
        if (curchar == '{')
        {
            if (depth_brace == 0)
            {
                finishStatement();
                scope_start = Position.create(linenum, charnum+1);
            }

            depth_brace += 1;
            //debugLog("start_depth: "+depth_brace);
        }
        else if (curchar == '}')
        {
            //debugLog("stop_depth: "+depth_brace);
            if (depth_brace == 0)
            {
                // This is a brace mismatch error, we should actually ignore it
                continue;
            }

            depth_brace -= 1;
            if (depth_brace == 0)
            {
                // Create a subscope for this content
                let subscope = new ASScope;
                subscope.parentscope = scope;
                subscope.module = scope.module;
                subscope.range = Range.create(
                    scope_start, Position.create(linenum, charnum)
                );

                scope.scopes.push(subscope);
                finishElement(subscope);
                scope_start = null;

                restartStatement();
            }
        }

        // Skip character if we're in a subscope
        if (depth_brace != 0)
            continue;

        // Keep track of parentheses
        if (curchar == '(')
        {
            depth_paren += 1;
            //debugLog("start_paren_depth: "+depth_paren)
        }
        else if (curchar == ')')
        {
            //debugLog("stop_paren_depth: "+depth_paren)
            depth_paren -= 1;

            // Ignore mismatched closing parens for this, can happen
            if (depth_paren < 0)
                depth_paren = 0;
        }

        // Detect semicolons to delimit statements
        if (curchar == ';' && depth_paren == 0)
            finishStatement();
    }

    finishStatement();

    // Also parse any subscopes we detected
    for (let subscope of scope.scopes)
        ParseScopeIntoStatements(subscope);
}

function DetermineScopeType(scope : ASScope)
{
    // Determine what the type of this scope is based on the previous statement
    if (scope.parentscope)
        scope.scopetype = scope.parentscope.scopetype;
    else
        scope.scopetype = ASScopeType.Global;

    if (scope.previous && scope.previous instanceof ASStatement)
    {
        if (scope.previous.ast)
        {
            let ast_type = scope.previous.ast[0];
            if (ast_type == node_types.AccessSpecifier)
                ast_type = scope.previous.ast[2][0];

            if (ast_type == node_types.ClassDefinition)
            {
                scope.scopetype = ASScopeType.Class;
            }
            else if (ast_type == node_types.StructDefinition)
            {
                scope.scopetype = ASScopeType.Class;
            }
            else if (ast_type == node_types.EnumDefinition)
            {
                scope.scopetype = ASScopeType.Enum;
            }
            else if (ast_type == node_types.FunctionDecl)
            {
                scope.scopetype = ASScopeType.Function;
            }
            else if (ast_type == node_types.ConstructorDecl)
            {
                scope.scopetype = ASScopeType.Function;
            }
            else if (ast_type == node_types.AssetDefinition)
            {
                scope.scopetype = ASScopeType.Function;
            }
        }
    }
}

function ParseAllStatements(scope : ASScope)
{
    // Determine what the type of this scope is based on the previous statement
    DetermineScopeType(scope);

    // Statements we detected should be parsed
    for (let statement of scope.statements)
        ParseStatement(scope.scopetype, statement);

    // Also parse any subscopes we detected
    for (let subscope of scope.scopes)
        ParseAllStatements(subscope)
}

function DisambiguateStatement(ast : any) : any
{
    // We always prefer a function declaration parse over a variable declaration one.
    // This can happen in class bodies because "FVector Test()" can be either a function or a variable with a constructor.
    if (ast[0][0] == node_types.VariableDecl && ast[1][0] == node_types.FunctionDecl)
        return ast[1];
    if (ast[1][0] == node_types.VariableDecl && ast[0][0] == node_types.FunctionDecl)
        return ast[0];

    // We prefer a variable declaration parse over a binary operation parse
    // This can happen when declaring variables of template types
    // eg "TArray<int> A" can be parsed as "(TArray < int) > A"
    if (ast[0][0] == node_types.VariableDecl && ast[1][0] == node_types.BinaryOperation)
        return ast[0];
    if (ast[1][0] == node_types.VariableDecl && ast[0][0] == node_types.BinaryOperation)
        return ast[1];

    return null;
}

function ParseStatement(scopetype : ASScopeType, statement : ASStatement)
{
    statement.parsed = true;
    statement.ast = null;

    let grammar : any = null;
    switch (scopetype)
    {
        default:
        case ASScopeType.Global:
        case ASScopeType.Namespace:
            grammar = grammar_global_statement;
        break;
        case ASScopeType.Class:
            grammar = grammar_class_statement;
        break;
        case ASScopeType.Enum:
            grammar = grammar_enum_statement;
        break;
        case ASScopeType.Function:
            grammar = grammar_statement;
        break;
    }

    let parser = new nearley.Parser(nearley.Grammar.fromCompiled(grammar));
    let parseError = false;

    try
    {
        parser.feed(statement.content);
    }
    catch (error)
    {
        console.log("statement: ");
        console.log(statement.content);
        console.log(error);
        parseError = true;
        throw "ParseError";
    }

    if (!parseError)
    {
        if (parser.results.length == 0)
        {
            statement.ast = null;
        }
        else if (parser.results.length == 1)
        {
            // Unambiguous, take the first one
            statement.ast = parser.results[0];
        }
        else
        {
            // We have some simple disambiguation rules to apply first
            statement.ast = DisambiguateStatement(parser.results);

            // If the disambiguation failed, take the first one anyway
            if (!statement.ast)
            {
                statement.ast = parser.results[0];

                // DEBUG
                console.log("statement: ");
                console.log(statement.content);
                console.dir(parser.results, {depth:null});
                throw "Ambiguous!";
            }
        }
    }

    //console.dir(statement.ast, {depth: null});
}


//let folder = "D:\\Split\\Split\\Script";
let folder = "D:\\Nuts\\Nuts\\Script";

let modules : ASModule[] = [];
glob(folder+"/**/*.as", null, function(err : any, files : any)
{
    for (let filename of files)
    //let filename = "D:\\Split\\Split\\Script\\Core\\Interaction\\InteractionComponent.as";
    //let filename = "D:\\Nuts\\Nuts\\Script\\Cake\\Environment\\Sky.as";
    {
        let content = fs.readFileSync(filename, 'utf8');
        let doc = TextDocument.create("file:///"+filename, "angelscript", 1, content)
        let asmodule = CreateModule("Test", filename, doc);
        modules.push(asmodule);
    }

    let startTime = performance.now()
    for (let asmodule of modules)
    {
        ParseScopeIntoStatements(asmodule.rootscope);
        /*for (let statement of asmodule.rootscope.scopes[4].scopes[5].statements)
            console.dir(statement, {depth: 0});
        return;*/
    }

    console.log("ParseScopeIntoStatements took " + (performance.now() - startTime) + " ms")

    startTime = performance.now()
    for (let asmodule of modules)
    {
        //console.log("module: "+asmodule.filename);
        ParseAllStatements(asmodule.rootscope);
    }
    console.log("Nearley parse " + (performance.now() - startTime) + " ms")
});