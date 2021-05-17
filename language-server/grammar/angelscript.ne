@{%

const moo = require("moo");
const n = require("./node_types");

const lexer = moo.compile({
    line_comment: { match: /\/\/.*$/ },
    preprocessor_statement: { match: /#.*$/ },
    block_comment: { match: /\/\*[^]*\*\//, lineBreaks: true },
    WS:      { match: /[ \t\r\n]+/, lineBreaks: true },
    lparen:  '(',
    rparen:  ')',
    lsqbracket:  '[',
    rsqbracket:  ']',
    dot: ".",
    semicolon: ";",
    ns: "::",
    colon: ":",
    comma: ",",
    postfix_operator: ["++", "--"],
    compound_assignment: ["+=", "-=", "/=", "*=", "~=", "^=", "|=", "&=", "%="],
    op_binary_logic: ['&&', '||'],
    op_binary_sum: ['+', '-'],
    op_binary_product: ['*', '/', '%'],
    op_binary_compare: ["==", "!=", "<=", ">=", ">>", "<", "<<" ,">", ">>"],
    op_binary_bitwise: ["|", "&", "^"],
    op_assignment: "=",
    op_unary: ["!", "~"],
    ternary: "?",
    dqstring:  /"(?:\\["\\A-Za-z0-9]|[^\n"\\])*"/,
    sqstring:  /'(?:\\['\\A-Za-z0-9]|[^\n'\\])*'/,
    hex_number: /0x[0-9A-Fa-f]+/,
    identifier: { match: /[A-Za-z_][A-Za-z0-9_]*/, 
        type: moo.keywords({
            if_token: "if",
            enum_token: "enum",
            return_token: "return",
            continue_token: "continue",
            break_token: "break",
            import_token: "import",
            class_token: "class",
            struct_token: "struct",
            default_token: "default",
            void_token: "void",
            const_token: "const",
            delegate_token: "delegate",
            event_token: "event",
            else_token: "else",
            while_token: "while",
            for_token: "for",
            case_token: "case",
            switch_token: "switch",
            cast_token: "Cast",
            namespace_token: "namespace",
            ufunction: 'UFUNCTION',
            uproperty: 'UPROPERTY',
            uclass: 'UCLASS',
            ustruct: 'USTRUCT',
            bool_token: ['true', 'false'],
            nullptr_token: 'nullptr',
            this_token: 'this',

            // This is a hack to help disambiguate syntax.
            // A statement of `TArray<int> Var` might be parsed as
            // ((TArray < int) > Var) as well, so we hardcode the template types
            // we know to avoid this in most situations.
            template_basetype: ['TArray', 'TMap', 'TSet', 'TSubclassOf', 'TSoftObjectPtr', 'TSoftClassPtr', 'TInstigated', 'TPerPlayer'],
        })
    },
    number: /[0-9]+/,
});

// A compound node containing multiple child nodes
function Compound(d, node_type, children)
{
    let node = {
        type: node_type,
        start: -1,
        end: -1,
        children: children,
    };
    ComputeStartAndEnd(node, d);
    return node;
}

// Extend the range of the compound to the new item
function ExtendedCompound(d, node)
{
    ComputeStartAndEnd(node, d);
    return node;
}

// An identifier based off a single lexer token
function Identifier(token)
{
    return {
        type: n.Identifier,
        start: token.offset,
        end: token.offset + token.text.length,
        value: token.value,
    };
}

// An literal based off a single lexer token
function Literal(node_type, token)
{
    return {
        type: node_type,
        start: token.offset,
        end: token.offset + token.text.length,
        value: token.value,
    };
}

// An identifier taken from a quoted string
function IdentifierFromString(token)
{
    return {
        type: n.Identifier,
        start: token.offset + 1,
        end: token.offset + token.text.length - 1,
        value: token.value.substring(1, token.value.length-1),
    };
}

// An identifier based on multiple lexer tokens or child nodes together
function CompoundIdentifier(tokens, children)
{
    return CompoundLiteral(n.Identifier, tokens, children);
}

// A literal based on multiple lexer tokens or child nodes together
function CompoundLiteral(node_type, tokens, children)
{
    let node = {
        type: node_type,
        start: -1,
        end: -1,
        value: "",
        children: children,
    };

    MergeValue(node, tokens);
    return node;
}

function MergeValue(node, d)
{
    for (let part of d)
    {
        if (!part)
            continue;

        if (Array.isArray(part))
        {
            MergeValue(node, part);
        }
        else if (part.hasOwnProperty("offset"))
        {
            // This is a token
            if (node.start == -1)
                node.start = part.offset;
            node.end = part.offset + part.text.length;
            node.value += part.value;
        }
        else if (part.start)
        {
            // This is a node
            if (node.start == -1)
                node.start = part.start;
            node.end = part.end;
            node.value += part.value;
        }
    }
}

function ComputeStartAndEnd(node, d)
{
    for (let part of d)
    {
        if (!part)
            continue;

        if (Array.isArray(part))
        {
            ComputeStartAndEnd(node, part);
        }
        else if (part.hasOwnProperty("offset"))
        {
            // This is a token
            if (node.start == -1)
                node.start = part.offset;
            node.end = part.offset + part.text.length;
        }
        else if (part.start)
        {
            // This is a node
            if (node.start == -1)
                node.start = part.start;
            node.end = part.end;
        }
    }
}

// Operator type node
function Operator(token)
{
    return token.value;
}

%}

@lexer lexer

optional_statement -> null {%
    function (d) { return null; }
%}
optional_statement -> _ statement {%
    function (d) { return d[1]; }
%}

optional_expression -> null {%
    function (d) { return null; }
%}
optional_expression -> _ expression {%
    function (d) { return d[1]; }
%}

statement -> expression {% id %}
statement -> assignment {% id %}
statement -> var_decl {% id %}

assignment -> lvalue _ "=" _ expression_or_assignment {%
    function (d) { return Compound(d, n.Assignment, [d[0], d[4]]); }
%}
assignment -> lvalue _ %compound_assignment _ expression_or_assignment {%
    function (d) { return {
        ...Compound(d, n.CompoundAssignment, [d[0], d[4]]),
        operator: Operator(d[2]),
    }; }
%}

expression_or_assignment -> expression {% id %}
expression_or_assignment -> assignment {% id %}

statement -> %if_token _ %lparen _ expression_or_assignment _ %rparen optional_statement {%
    function (d) { return Compound(d, n.IfStatement, [d[4], d[7]]); }
%}

statement -> %return_token _ expression_or_assignment {%
    function (d) { return Compound(d, n.ReturnStatement, [d[2]]); }
%}

statement -> %return_token {%
    function (d) { return Compound(d, n.ReturnStatement, []); }
%}

statement -> %else_token optional_statement {%
    function (d) { return Compound(d, n.ElseStatement, [d[1]]); }
%}

statement -> %switch_token _ %lparen optional_expression _ %rparen {%
    function (d) { return Compound(d, n.SwitchStatement, [d[3]]); }
%}

statement -> %case_token _ case_label _ %colon optional_statement {%
    function (d) { return Compound(d, n.CaseStatement, [d[2], d[5]]); }
%}

statement -> %default_token %colon optional_statement {%
    function (d) { return Compound(d, n.DefaultCaseStatement, [d[2]]); }
%}

statement -> %continue_token {%
    function (d) { return Literal(n.ContinueStatement, d[0]); }
%}

statement -> %break_token {%
    function (d) { return Literal(n.BreakStatement, d[0]); }
%}

statement -> %for_token _ %lparen (_ for_declaration):? _ %semicolon optional_expression (_ %semicolon for_comma_expression_list):? _ %rparen optional_statement {%
    function (d) {
        return Compound(d, n.ForLoop, [d[3] ? d[3][1] : null, d[6], d[7] ? d[7][2] : null, d[10]]);
    }
%}

for_declaration -> var_decl {% id %}
for_declaration -> expression {% id %}
for_declaration -> assignment {% id %}

for_comma_expression_list -> null {%
    function (d) { return null; }
%}
for_comma_expression_list -> _ for_comma_expression {%
    function (d) { return d[1]; }
%}
for_comma_expression_list -> _ for_comma_expression (_ "," _ for_comma_expression):+ {%
    function (d) {
        exprs = [d[1]];
        for (let part of d[2])
            exprs.push(part[3]);
        return Compound(d, n.CommaExpression, exprs);
    }
%}
for_comma_expression -> expression {% id %}
for_comma_expression -> assignment {% id %}

statement -> %for_token _ %lparen _ typename _ %identifier _ %colon _ expression _ %rparen optional_statement {%
    function (d) { return Compound(d, n.ForEachLoop, [d[4], Identifier(d[6]), d[10], d[13]]); }
%}

statement -> %while_token _ %lparen _ expression _ %rparen optional_statement {%
    function (d) { return Compound(d, n.WhileLoop, [d[4], d[7]]); }
%}

global_statement -> %import_token _ %identifier (%dot %identifier):* {%
    function (d) {
        let tokens = [d[2]];
        for (let part of d[3])
        {
            tokens.push(part[0]);
            tokens.push(part[1]);
        }
        return Compound(d, n.ImportStatement, [CompoundIdentifier(tokens, null)]);
    }
%}
global_statement -> %import_token _ function_signature _ "from" _ (%dqstring | %sqstring) {%
    function (d) {
        return Compound(d, n.ImportFunctionStatement, [d[2], IdentifierFromString(d[6][0])]);
    }
%}

global_declaration -> ufunction_macro:? function_signature {%
    function (d) {
        return ExtendedCompound(d, {
            ...d[1],
            macro: d[0],
        });
    }
%}
global_declaration -> delegate_decl {% id %}
global_declaration-> event_decl {% id %}
global_declaration -> var_decl {% id %}
global_declaration -> ustruct_macro:? %struct_token _ %identifier {%
    function (d) { return {
        ...Compound(d, n.StructDefinition, null),
        name: Identifier(d[3]),
        macro: d[0],
    }}
%}
global_declaration -> uclass_macro:? %class_token _ %identifier ( _ %colon _ %identifier ):? {%
    function (d) { return {
        ...Compound(d, n.ClassDefinition, null),
        name: Identifier(d[3]),
        macro: d[0],
        superclass: d[4] ? Identifier(d[4][3]) : null,
    }}
%}
global_declaration -> %enum_token _ %identifier {%
    function (d) { return {
        ...Compound(d, n.EnumDefinition, null),
        name: Identifier(d[2]),
    }}
%}

global_declaration -> "asset" _ %identifier _ "of" _ typename {%
    function (d) { return {
        ...Compound(d, n.AssetDefinition, null),
        name: Identifier(d[2]),
        typename: d[6],
    }; }
%}

global_declaration -> "settings" _ %identifier _ "for" _ typename {%
    function (d) { return {
        ...Compound(d, n.AssetDefinition, null),
        name: Identifier(d[2]),
        typename: d[6],
    }; }
%}

global_declaration -> %namespace_token _ %identifier {%
    function (d) { return {
        ...Compound(d, n.NamespaceDefinition, null),
        name: Identifier(d[2]),
    }; }
%}

class_declaration -> uproperty_macro:? (access_specifier _):? var_decl {%
    function (d) {
        return ExtendedCompound(d, {
            ...d[2],
            access: d[1] ? d[1][0].value : null,
            macro: d[0],
        });
    }
%}

class_declaration -> ufunction_macro:? (access_specifier _):? function_signature {%
    function (d) {
        return ExtendedCompound(d, {
            ...d[2],
            access: d[1] ? d[1][0].value : null,
            macro: d[0],
        });
    }
%}

class_declaration -> access_specifier _ ufunction_macro function_signature {%
    function (d) {
        return ExtendedCompound(d, {
            ...d[3],
            access: d[0].value,
            macro: d[2],
        });
    }
%}

class_declaration -> constructor_decl {% id %}
class_declaration -> destructor_decl {% id %}

class_statement -> %default_token _ expression {%
    function (d) { return Compound(d, n.DefaultStatement, [d[2]]); }
%}
class_statement -> %default_token _ assignment {%
    function (d) { return Compound(d, n.DefaultStatement, [d[2]]); }
%}

var_decl -> typename _ %identifier {%
    function (d) { return {
        ...Compound(d, n.VariableDecl, null),
        name: Identifier(d[2]),
        typename: d[0],
    }; }
%}
var_decl -> typename _ %identifier _ "=" (_ expression):? {%
    function (d) { return {
        ...Compound(d, n.VariableDecl, null),
        name: Identifier(d[2]),
        typename: d[0],
        expression: d[5] ? d[5][1] : null,
        inline_assignment: d[5] ? true : false,
    }; }
%}
var_decl -> typename _ %identifier _ %lparen _ argumentlist _ %rparen {%
    function (d) { return {
        ...Compound(d, n.VariableDecl, null),
        name: Identifier(d[2]),
        typename: d[0],
        expression: d[6],
        inline_constructor: true,
    }; }
%}

var_decl -> typename _ var_decl_multi_part (_ %comma _ var_decl_multi_part):+ {%
    function (d) {
        let vars = [d[2]];
        vars[0].typename = d[0];
        if (d[3])
        {
            for (let part of d[3])
            {
                part[3].typename = d[0];
                vars.push(part[3]);
            }
        }

        return Compound(d, n.VariableDeclMulti, vars);
    }
%}

var_decl_multi_part -> %identifier (_ "=" _ expression):? {%
    function (d) {
        if (d[2])
            return {
                ...Compound(d, n.VariableDecl, null),
                name: Identifier(d[0]),
                expression: d[1][2],
                inline_assignment: true
            };
        else
            return {
                ...Compound(d, n.VariableDecl, null),
                name: Identifier(d[0]),
                expression: null,
            };
    }
%}

delegate_decl -> "delegate" _ function_signature {%
    function (d) { return Compound(d, n.DelegateDecl, [d[2]]); }
%}
event_decl -> "event" _ function_signature {%
    function (d) { return Compound(d, n.EventDecl, [d[2]]); }
%}
constructor_decl -> %identifier _ %lparen _ parameter_list _ %rparen {%
    function (d) { return {
        ...Compound(d, n.ConstructorDecl, null),
        name: Identifier(d[0]),
        parameters: d[4],
    }; }
%}
destructor_decl -> "~" %identifier _ %lparen _ %rparen {%
    function (d) { return {
        ...Compound(d, n.DestructorDecl, null),
        name: CompoundIdentifier([d[0], d[1]]),
    }; }
%}

function_signature -> function_return _ %identifier _ %lparen _ parameter_list _ %rparen func_qualifiers {%
    function (d) { return {
        ...Compound(d, n.FunctionDecl, null),
        name: Identifier(d[2]),
        returntype: d[0],
        parameters: d[6],
        qualifiers: d[9],
    }; }
%}
function_return -> typename {% id %}
function_return -> %void_token {%
    function (d) { return null; }
%}

ufunction_macro -> %ufunction _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return Compound(d, n.Macro, d[4]); }
%}
uproperty_macro -> %uproperty _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return Compound(d, n.Macro, d[4]); }
%}
uclass_macro -> %uclass _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return Compound(d, n.Macro, d[4]); }
%}
ustruct_macro -> %ustruct _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return Compound(d, n.Macro, d[4]); }
%}

parameter_list -> null {%
    function(d) { return []; }
%}
parameter_list -> parameter (_ "," _ parameter):* {%
    function(d) {
        let params = [d[0]];
        if (d[1])
        {
            for (let part of d[1])
                params.push(part[3]);
        }
        return params;
    }
%}

parameter -> typename {%
    function (d) { return {
        ...Compound(d, n.Parameter, null),
        typename: d[0],
    }; }
%}

parameter -> typename _ %identifier {%
    function (d) { return {
        ...Compound(d, n.Parameter, null),
        typename: d[0],
        name: Identifier(d[2]),
    }; }
%}

parameter -> typename _ %identifier _ "=" _ expression {%
    function (d) { return {
        ...Compound(d, n.Parameter, null),
        typename: d[0],
        name: Identifier(d[2]),
        expression: d[6],
    }; }
%}

macro_list -> null {%
    function(d) { return []; }
%}
macro_list -> macro_argument (_ "," _ macro_argument):* {%
    function(d) {
        let args = [d[0]];
        if (d[1])
        {
            for (let part of d[1])
                args.push(part[3]);
        }
        return args;
    }
%}

macro_argument -> macro_identifier {% 
    function (d) { return {
        ...Compound(d, n.MacroArgument, null),
        name: d[0],
    }; }
%}
macro_argument -> macro_identifier _ "=" _ macro_value {%
    function (d) { return {
        ...Compound(d, n.MacroArgument, null),
        name: d[0],
        value: d[4],
    }; }
%}
macro_argument -> macro_identifier _ "=" _ %lparen _ macro_list _ %rparen {%
    function (d) { return {
        ...Compound(d, n.MacroArgument, d[6]),
        name: d[0],
    }; }
%}

macro_identifier -> %identifier {%
    function (d) { return Identifier(d[0]); }
%}
macro_identifier -> %dqstring {%
    function (d) { return IdentifierFromString(d[0]); }
%}
macro_identifier -> %sqstring {%
    function (d) { return IdentifierFromString(d[0]); }
%}

macro_value -> macro_identifier {% id %}
macro_value -> (%identifier _ "|" _):+ %identifier {%
    function (d) {
        return CompoundIdentifier(d, null);
    }
%}

macro_value -> (%identifier _ "::" _):+ %identifier {%
    function (d) {
        return CompoundIdentifier(d, null);
    }
%}

macro_value -> ("-" _):? const_number {%
    function (d) {
        if (!d[0])
            return d[1];
        return CompoundLiteral(
            d[1].type,
            d,
            null
        );
    }
%}

expression -> expr_ternary {% id %}

expr_ternary -> expr_binary_logic _ %ternary _ expr_ternary _ %colon _ expr_ternary {%
    function (d) { return Compound(d, n.TernaryOperation, [d[0], d[4], d[8]]); }
%}
expr_ternary -> expr_binary_logic {% id %}

expr_binary_logic -> expr_binary_logic _ %op_binary_logic _ expr_binary_bitwise {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], d[4]]),
        operator: Operator(d[2]),
    };}
%}
expr_binary_logic -> expr_binary_bitwise {% id %}

expr_binary_bitwise -> expr_binary_bitwise _ %op_binary_bitwise _ expr_binary_compare {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], d[4]]),
        operator: Operator(d[2]),
    };}
%}
expr_binary_bitwise -> expr_binary_compare {% id %}

expr_binary_compare -> expr_binary_compare _ %op_binary_compare _ expr_binary_sum {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], d[4]]),
        operator: Operator(d[2]),
    };}
%}
expr_binary_compare -> expr_binary_sum {% id %}

expr_binary_sum -> expr_binary_sum _ %op_binary_sum _ expr_binary_product {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], d[4]]),
        operator: Operator(d[2]),
    };}
%}
expr_binary_sum -> expr_binary_product {% id %}

expr_binary_product -> expr_binary_product _ %op_binary_product _ expr_unary {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], d[4]]),
        operator: Operator(d[2]),
    };}
%}
expr_binary_product -> expr_unary {% id %}

expr_unary -> unary_operator _ expr_unary {%
    function (d) { return {
        ...Compound(d, n.UnaryOperation, [d[2]]),
        operator: Operator(d[0]),
    };}
%}
expr_unary -> expr_postfix {% id %}

expr_postfix -> expr_postfix _ %postfix_operator {%
    function (d) { return {
        ...Compound(d, n.PostfixOperation, [d[0]]),
        operator: Operator(d[2]),
    };}
%}
expr_postfix -> expr_leaf {% id %}

expr_leaf -> lvalue {% id %}
expr_leaf -> constant {% id %}

lvalue -> %identifier {%
    function(d, l) { return Identifier(d[0]); }
%}

lvalue -> %this_token {% 
    function (d) { return Literal(n.This, d[0]); }
%}

lvalue -> lvalue _ %dot _ %identifier {%
    function (d) { return Compound(d, n.MemberAccess, [d[0], Identifier(d[4])]); }
%}
lvalue -> %lparen _ expression _ %rparen {%
    function (d) { return d[2]; }
%}
lvalue -> lvalue _ %lparen _ argumentlist _ %rparen {%
    function (d) { return Compound(d, n.FunctionCall, [d[0], d[4]]); }
%}
lvalue -> lvalue _ "[" _ expression _ "]" {%
    function (d) { return Compound(d, n.IndexOperator, [d[0], d[4]]); }
%}
lvalue -> template_typename _ %lparen _ argumentlist _ %rparen {%
    function (d) { return Compound(d, n.ConstructorCall, [d[0], d[4]]); }
%}

lvalue -> %cast_token _ "<" _ typename _ ">" _ %lparen _ optional_expression _ %rparen {%
    function (d) { return Compound(d, n.CastOperation, [d[4], d[10]]); }
%}
# INCOMPLETE: Attempts to parse an incomplete cast while the user is typing
expression -> %cast_token _ "<" {%
    function (d) { return Compound(d, n.CastOperation, [null, null]); }
%}
expression -> %cast_token _ "<" _ typename _ ">" {%
    function (d) { return Compound(d, n.CastOperation, [d[4], null]); }
%}

lvalue -> namespace_access {% id %}
namespace_access -> namespace_access _ "::" _ %identifier {%
    function (d) { return Compound(d, n.NamespaceAccess, [d[0], Identifier(d[4])]); }
%}
namespace_access -> %identifier _ "::" _ %identifier {%
    function (d) { return Compound(d, n.NamespaceAccess, [Identifier(d[0]), Identifier(d[4])]); }
%}

# INCOMPLETE: Attempts to parse an incomplete namespace access while the user is typing
lvalue -> %identifier _ "::" {%
    function (d) { return Compound(d, n.NamespaceAccess, [Identifier(d[0]), null]); }
%}
# INCOMPLETE: Attempts to parse an incomplete namespace access while the user is typing
lvalue -> %identifier _ ":" {%
    function (d) { return Compound(d, n.NamespaceAccess, [Identifier(d[0]), null]); }
%}
# INCOMPLETE: Attempts to parse an incomplete member access while the user is typing
lvalue -> lvalue _ %dot {%
    function (d) { return Compound(d, n.MemberAccess, [d[0], null]); }
%}
# INCOMPLETE: Attempts to parse an incomplete bracketed expression
lvalue -> %lparen _ %rparen {%
    function (d) { return null; }
%}
# INCOMPLETE: Attempts to parse an incomplete member access while the user is typing
expression -> expression _ (%op_binary_product | %op_binary_sum | %op_binary_bitwise | %op_binary_compare | %op_binary_logic | %lparen | %lsqbracket) {%
    function (d) { return {
        ...Compound(d, n.BinaryOperation, [d[0], null]),
        operator: Operator(d[2][0]),
    };}
%}
# INCOMPLETE: Attempts to parse an incomplete assignment while the user is typing
assignment -> lvalue _ "=" {%
    function (d) { return Compound(d, n.Assignment, [d[0], null]); }
%}
assignment -> lvalue _ %compound_assignment {%
    function (d) { return {
        ...Compound(d, n.CompoundAssignment, [d[0], null]),
        operator: Operator(d[2]),
    }; }
%}


argumentlist -> null {%
    function(d) { return null; }
%}
argumentlist -> (argument _ "," _ ):* argument ",":? {%
    function(d) { 
        let args = [];
        if (d[0])
        {
            for (let part of d[0])
                args.push(part[0]);
        }
        args.push(d[1]);
        return Compound(d, n.ArgumentList, args);
    }
%}

argument -> expression {% id %}
argument -> %identifier _ "=" optional_expression {%
    function (d) { return Compound(d, n.NamedArgument, [Identifier(d[0]), d[3]]); }
%}

const_number -> %number {%
    function(d) { return Literal(n.ConstInteger, d[0]); }
%}

const_number -> %hex_number {%
    function(d) { return Literal(n.ConstHexInteger, d[0]); }
%}

const_number -> %number "." %number "f" {%
    function(d) { return CompoundLiteral(n.ConstFloat, d, null); }
%}

const_number -> "." %number "f" {%
    function(d) { return CompoundLiteral(n.ConstFloat, d, null); }
%}

const_number -> %number "." "f" {%
    function(d) { return CompoundLiteral(n.ConstFloat, d, null); }
%}

const_number -> %number "." %number {%
    function(d) { return CompoundLiteral(n.ConstDouble, d, null); }
%}

const_number -> "." %number {%
    function(d) { return CompoundLiteral(n.ConstDouble, d, null); }
%}

const_number -> %number "." {%
    function(d) { return CompoundLiteral(n.ConstDouble, d, null); }
%}

constant -> %dqstring {%
    function(d) { return Literal(n.ConstString, d[0]); }
%}

constant -> %sqstring {%
    function(d) { return Literal(n.ConstString, d[0]); }
%}

constant -> "n" %dqstring {%
    function(d) { return CompoundLiteral(n.ConstName, d, null); }
%}

constant -> const_number {% id %}

constant -> %bool_token {% 
    function (d) { return Literal(n.ConstBool, d[0]); }
%}

constant -> %nullptr_token {% 
    function (d) { return Literal(n.ConstNullptr, d[0]); }
%}

unary_operator
    -> %op_binary_sum
     | %op_unary
     | %postfix_operator
{% id %}

typename -> const_qualifier:? unqualified_typename ref_qualifiers:? {%
    function (d) { return ExtendedCompound(d, {
        ...d[1],
        const_qualifier: d[0],
        ref_qualifier: d[2],
    });}
%}

unqualified_typename -> typename_identifier {%
    function (d) { return {
        ...Compound(d, n.Typename, null),
        value: d[0].value,
        name: d[0],
    }}
%}

unqualified_typename -> template_typename {% id %}

template_typename -> typename_identifier _ "<" _ template_subtypes _ ">" {%
    function (d) {
        let typename = d[0].value+"<";
        for (let i = 0; i < d[4].length; ++i)
        {
            if (i != 0) typename += ",";
            typename += d[4][i].value;
        }
        typename += ">";

        return {
            ...Compound(d, n.Typename, null),
            value: typename,
            basetype: d[0],
            subtypes: d[4],
        };
    }
%}

template_typename -> typename_identifier _ "<" _ template_subtypes_unterminated _ ">>" {%
    function (d) {
        let typename = d[0].value+"<";
        for (let i = 0; i < d[4].length; ++i)
        {
            if (i != 0) typename += ",";
            typename += d[4][i].value;
        }
        typename += ">";

        return {
            ...Compound(d, n.Typename, null),
            value: typename,
            basetype: d[0],
            subtypes: d[4],
        };
    }
%}

typename_unterminated -> const_qualifier:? typename_identifier _ "<" _ template_subtypes _ {%
    function (d) {
        let typename = d[1].value+"<";
        for (let i = 0; i < d[5].length; ++i)
        {
            if (i != 0) typename += ",";
            typename += d[5][i].value;
        }
        typename += ">";

        let node = {
            ...Compound(d, n.Typename, null),
            value: typename,
            basetype: d[1],
            subtypes: d[5],
        };
        node.end += 1;
        return node;
    }
%}

template_subtypes -> typename (_ "," _ typename):* {%
    function (d) {
        let subtypes = [d[0]];
        if (d[1])
        {
            for (let part of d[1])
                subtypes.push(part[3]);
        }
        return subtypes;
    }
%}

template_subtypes_unterminated -> (typename _ "," _):* typename_unterminated {%
    function (d) {
        let subtypes = [];
        if (d[0])
        {
            for (let part of d[0])
                subtypes.push(part[0]);
        }
        subtypes.push(d[1]);
        return subtypes
    }
%}

typename_identifier -> %template_basetype {%
    function (d) { return Literal(n.Typename, d[0]); }
%}

typename_identifier -> (%identifier _ %ns _ ):* %identifier {%
    function (d) { return CompoundLiteral(n.Typename, d, null); }
%}

const_qualifier -> %const_token _ {%
    function (d) { return d[0].value; }
%}
ref_qualifiers -> _ "&" ("in" | "out" | "inout"):? {%
    function (d) { return d[2] ? d[1].value+d[2].value : d[1].value; }
%}

func_qualifiers -> null {%
    function(d) { return null; }
%}
func_qualifiers -> _ (func_qualifier __ ):* func_qualifier {%
    function(d) {
        let quals = [d[2].value];
        if (d[1])
        {
            for (let part of d[1])
                quals.push(part.value);
        }
        return quals;
    }
%}

func_qualifier -> ("const" | "final" | "override" | "property") {% 
    function (d) { return d[0][0]; }
%}

access_specifier -> ("private" | "protected" | "public") {%
    function (d) { return d[0][0]; }
%}

_ -> (%WS | %line_comment | %block_comment | %preprocessor_statement):* {%
    function (d) { return null; }
%}

__ -> %WS {%
    function (d) { return null; }
%}
__ -> _ %block_comment _ {%
    function (d) { return null; }
%}
__ -> _ %line_comment _ {%
    function (d) { return null; }
%}
__ -> _ %prepocessor_statement _ {%
    function (d) { return null; }
%}

case_label -> %lparen _ case_label _ %rparen {% 
    function (d) { return d[2]; }
%}
case_label -> ("-" _):? %number {%
    function (d) {
        return CompoundLiteral(
            n.ConstInteger,
            d,
            null
        );
    }
%}
case_label -> namespace_access {% id %}

enum_statement -> enum_decl (_ "," enum_decl):* {%
    function (d)
    {
        let result = [d[0]];
        if (d[1])
        {
            for (let sub of d[1])
                result.push(sub[2]);
        }
        return Compound(d, n.EnumValueList, result);
    }
%}

enum_decl -> comment_documentation:? %identifier {%
    function (d) { return {
        ...Compound(d, n.EnumValue, null),
        name: Identifier(d[1]),
        documentation: d[0],
   }; }
%}

enum_decl -> comment_documentation:? %identifier _ "=" _ enum_value {%
    function (d) { return {
        ...Compound(d, n.EnumValue, null),
        name: Identifier(d[1]),
        value: d[5],
        documentation: d[0],
   }; }
%}

enum_value -> %identifier (_ %ns _ %identifier):* {%
    function (d) { return CompoundIdentifier(d, null); }
%}

enum_value -> ("-" _):? %number {%
    function (d) {
        return CompoundLiteral(
            n.ConstInteger,
            d,
            null
        );
    }
%}

comment_documentation -> %WS:* (%block_comment %WS:? | %line_comment %WS:? | %preprocessor_statement %WS:?):* {%
    function (d) {
        if (d[1])
        {
            let comment = null;
            for (let part of d[1])
            {
                if (part[0].type == 'block_comment')
                {
                    if (!comment) comment = "";
                    comment += part[0].value.substring(2, part[0].value.length - 2);
                }
                else if (part[0].type == 'line_comment')
                {
                    if (!comment) comment = "";
                    comment += part[0].value.substring(2, part[0].value.length);
                }

                if (comment && comment.length > 0)
                    comment += "\n";
            }
            return comment;
        }
        return null;
    }
%}