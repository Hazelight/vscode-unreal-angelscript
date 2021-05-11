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
            cast_token: "Cast",
            ufunction: 'UFUNCTION',
            uproperty: 'UPROPERTY',
            uclass: 'UCLASS',
            ustruct: 'USTRUCT',
        })
    },
    number: /[0-9]+/,
});

function Compound(d, node_type, children)
{
    let start = -1;
    let end = -1;

    for (let part of d)
    {
        if (!part)
            continue;
        if (start == -1)
            start = part.start;
        end = part.end;
    }

    return {
        type: node_type:
        start: start,
        end: end,
        chlidren: children,
    };
}

function Identifier(node_type, start, end)
{
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
    function (d) { return [n.Assignment, d[0], d[4][0]]; }
%}
assignment -> lvalue _ %compound_assignment _ (expression | assignment) {%
    function (d) { return [n.CompoundAssignment, d[0], d[2], d[4][0]]; }
%}

expression_or_assignment -> expression {% id %}
expression_or_assignment -> assignment {% id %}

statement -> %if_token _ %lparen _ expression_or_assignment _ %rparen optional_statement {%
    function (d) { return [n.IfStatement, d[4], d[7]]; }
%}

statement -> %return_token _ expression_or_assignment {%
    function (d) { return [n.ReturnStatement, d[2]]; }
%}

statement -> %else_token _ statement {%
    function (d) { return [n.ElseStatement, d[2]]; }
%}

statement -> %case_token _ case_label _ %colon optional_statement {%
    function (d) { return [n.CaseStatement, d[2], d[5]]; }
%}

statement -> %default_token %colon optional_statement {%
    function (d) { return [n.CaseStatement, d[0], d[2]]; }
%}

statement -> %for_token _ %lparen (_ for_declaration):? _ %semicolon optional_expression _ %semicolon for_comma_expression_list _ %rparen optional_statement {%
    function (d) { return [n.ForLoop, d[3] ? d[3][1] : null, d[6], d[9], d[12]]; }
%}
for_declaration -> var_decl | expression | assignment {% id %}
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
        return [n.CommaExpression, exprs];
    }
%}
for_comma_expression -> expression {% id %}
for_comma_expression -> assignment {% id %}

statement -> %for_token _ %lparen _ typename _ %identifier _ %colon _ expression _ %rparen optional_statement {%
    function (d) { return [n.ForEachLoop, d[4], d[6], d[10], d[13]]; }
%}

statement -> %while_token _ %lparen _ expression _ %rparen optional_statement {%
    function (d) { return [n.WhileLoop, d[4], d[7]]; }
%}

global_statement -> %import_token _ %identifier (%dot %identifier):* {%
    function (d) {
        let modulename = d[2].value;
        for (let part of d[3])
            modulename += "."+part[1].value;
        return [n.ImportStatement, modulename];
    }
%}
global_statement -> %import_token _ function_signature _ "from" _ (%dqstring | %sqstring) {%
    function (d) {
        return [n.ImportFunctionStatement, d[6], d[2][0]];
    }
%}

global_statement -> ufunction_macro:? function_signature {%
    function (d) { return [n.FunctionDecl, {
        ...d[1],
        macro: d[0],
    }]; }
%}
global_statement -> delegate_decl {% id %}
global_statement -> event_decl {% id %}
global_statement -> var_decl {% id %}
global_statement -> ustruct_macro:? %struct_token _ %identifier {%
    function (d) { return [n.StructDefinition, {
        name: d[4],
        macro: d[0]
    }]; }
%}
global_statement -> uclass_macro:? %class_token _ %identifier ( _ %colon _ %identifier ):? {%
    function (d) { return [n.ClassDefinition, {
        name: d[4],
        macro: d[0],
        superclass: d[9],
    }]; }
%}
global_statement -> %enum_token _ %identifier {%
    function (d) { return [n.EnumDefinition, {
        name: d[2]
    }]; }
%}

global_statement -> "asset" _ %identifier _ "of" _ %identifier {%
    function (d) { return [n.AssetDefinition, d[2], d[6]]; }
%}

global_statement -> "settings" _ %identifier _ "for" _ %identifier {%
    function (d) { return [n.AssetDefinition, d[2], d[6]]; }
%}

class_statement -> uproperty_macro:? (access_specifier _):? var_decl {%
    function (d) {
        return [ d[2][0], { ...d[2][1], access: d[1] ? d[1][0] : null, macro: d[0] } ];
    }
%}

class_statement -> ufunction_macro:? (access_specifier _):? function_signature {%
    function (d) { return [n.FunctionDecl, {
        ...d[2],
        macro: d[0],
        access: d[1] ? d[1][0] : null,
    }]; }
%}

class_statement -> access_specifier _ ufunction_macro function_signature {%
    function (d) { return [n.FunctionDecl, {
        ...d[4],
        macro: d[2],
        access: d[0],
    }]; }
%}

class_statement -> constructor_decl {% id %}
class_statement -> destructor_decl {% id %}
class_statement -> %default_token _ expression {%
    function (d) { return [n.DefaultStatement, d[2]]; }
%}
class_statement -> %default_token _ assignment {%
    function (d) { return [n.DefaultStatement, d[2]]; }
%}

var_decl -> typename _ %identifier {%
    function (d) { return [n.VariableDecl, {
        name: d[2],
        typename: d[0],
        expression: null,
    }]; }
%}
var_decl -> typename _ %identifier _ "=" _ expression {%
    function (d) { return [n.VariableDecl, {
        name: d[2],
        typename: d[0],
        expression: d[6],
        inline_assignment: true,
    }]; }
%}
var_decl -> typename _ %identifier _ %lparen _ argumentlist _ %rparen {%
    function (d) { return [n.VariableDecl, {
        name: d[2],
        typename: d[0],
        expression: d[6],
        inline_constructor: true,
    }]; }
%}

var_decl -> typename _ var_decl_multi_part (_ %comma _ var_decl_multi_part):+ {%
    function (d) {
        let vars = [d[2]];
        if (d[3])
        {
            for (let part of d[3])
                vars.push(part[2]);
        }
        
        return [n.VariableDeclMulti, {
            typename: d[0],
            variables: vars,
        }]; }
%}

var_decl_multi_part -> %identifier (_ "=" _ expression):? {%
    function (d) {
        if (d[2])
            return { name: d[0], expression: d[2][2], inline_assignment: true };
        else
            return { name: d[0] };
    }
%}

delegate_decl -> "delegate" _ function_signature {%
    function (d) { return [n.DelegateDecl, {
        ...d[2]
    }]; }
%}
event_decl -> "event" _ function_signature {%
    function (d) { return [n.EventDecl, {
        ...d[2],
        macro: d[0],
    }]; }
%}
constructor_decl -> %identifier _ %lparen _ parameter_list _ %rparen {%
    function (d) { return [n.ConstructorDecl, {
        name: d[0],
        parameters: d[4],
    }]; }
%}
destructor_decl -> "~" %identifier _ %lparen _ parameter_list _ %rparen {%
    function (d) { return [n.DestructorDecl, d[1]]; }
%}

function_signature -> function_return _ %identifier _ %lparen _ parameter_list _ %rparen func_qualifiers {%
    function (d) { return {
        name: d[2],
        returntype: d[0],
        parameters: d[6],
        qualifiers: d[9],
    }; }
%}
function_return -> typename | %void_token {% id %}

ufunction_macro -> %ufunction _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return d[4]; }
%}
uproperty_macro -> %uproperty _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return d[4]; }
%}
uclass_macro -> %uclass _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return d[4]; }
%}
ustruct_macro -> %ustruct _ %lparen _ macro_list _ %rparen _ {%
    function (d) { return d[4]; }
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
    function (d) { return [d[0], null, null]; }
%}

parameter -> typename _ %identifier {%
    function (d) { return [d[0], d[2], null]; }
%}

parameter -> typename _ %identifier _ "=" _ expression {%
    function (d) { return [d[0], d[2], d[6]]; }
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
    function (d) { return [d[0], null]; }
%}
macro_argument -> macro_identifier _ "=" _ macro_value {%
    function (d) { return [d[0], d[4]]; }
%}
macro_argument -> macro_identifier _ "=" _ %lparen _ macro_list _ %rparen {%
    function (d) { return [d[0], d[6]]; }
%}

macro_identifier -> %identifier {%
    function (d) { return [n.Identifier, d[0]]; }
%}
macro_identifier -> %dqstring {%
    function (d) { return [n.ConstString, d[0]]; }
%}
macro_identifier -> %sqstring {%
    function (d) { return [n.ConstString, d[0]]; }
%}

macro_value -> macro_identifier {% id %}
macro_value -> (%identifier _ "|" _):+ %identifier {%
    function (d) {
        let value = d[1];
        if (d[0])
        {
            let strValue = "";
            for (let part of d[0])
            {
                if (part[0].offset < value.offset)
                    value.offset = part[0].offset;
                strValue += part[0].value;
                strValue += "|";
            }
            strValue += d[1].value;
            value.value = strValue;
        }
        return [n.Identifier, value];
    }
%}

macro_value -> (%identifier _ "::" _):+ %identifier {%
    function (d) {
        let value = d[1];
        if (d[0])
        {
            let strValue = "";
            for (let part of d[0])
            {
                if (part[0].offset < value.offset)
                    value.offset = part[0].offset;
                strValue += part[0].value;
                strValue += "::";
            }
            strValue += d[1].value;
            value.value = strValue;
        }
        return [n.Identifier, value];
    }
%}

macro_value -> ("-" _):? const_number {%
    function (d) {
        let value = d[1];
        if (d[0])
        {
            value[1].value = d[0][0].value + d[1][1].value;
            value[1].offset = d[0][0].offset;
        }
        return value;
    }
%}

expression -> expr_ternary {% id %}

expr_ternary -> expr_binary_logic _ %ternary _ expr_ternary _ %colon _ expr_ternary {%
    function (d) { return [n.TernaryOperation, d[0], d[4], d[8]]; }
%}
expr_ternary -> expr_binary_logic {% id %}

expr_binary_logic -> expr_binary_logic _ %op_binary_logic _ expr_binary_bitwise {%
    function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
%}
expr_binary_logic -> expr_binary_bitwise {% id %}

expr_binary_bitwise -> expr_binary_bitwise _ %op_binary_bitwise _ expr_binary_compare {%
    function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
%}
expr_binary_bitwise -> expr_binary_compare {% id %}

expr_binary_compare -> expr_binary_compare _ %op_binary_compare _ expr_binary_sum {%
    function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
%}
expr_binary_compare -> expr_binary_sum {% id %}

expr_binary_sum -> expr_binary_sum _ %op_binary_sum _ expr_binary_product {%
    function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
%}
expr_binary_sum -> expr_binary_product {% id %}

expr_binary_product -> expr_binary_product _ %op_binary_product _ expr_unary {%
    function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
%}
expr_binary_product -> expr_unary {% id %}

expr_unary -> unary_operator _ expr_unary {%
    function (d) { return [n.UnaryOperation, d[0], d[2]]; }
%}
expr_unary -> expr_postfix {% id %}

expr_postfix -> expr_postfix _ %postfix_operator {%
    function (d) { return [n.PostfixOperation, d[2], d[0]]; }
%}
expr_postfix -> expr_leaf {% id %}

expr_leaf -> lvalue {% id %}
expr_leaf -> constant {% id %}

lvalue -> %identifier {%
    function(d, l) { return [n.Identifier, d[0]] }
%}

lvalue -> lvalue _ "." _ %identifier {%
    function (d) { return [n.MemberAccess, d[0], d[4]]; }
%}
lvalue -> "(" _ expression _ ")" {%
    function (d) { return d[2]; }
%}
lvalue -> lvalue _ "(" _ argumentlist _ ")" {%
    function (d) { return [n.FunctionCall, d[0], d[4]]; }
%}
lvalue -> lvalue _ "[" _ expression _ "]" {%
    function (d) { return [n.IndexOperator, d[0], d[4]]; }
%}
lvalue -> template_typename _ "(" _ argumentlist _ ")" {%
    function (d) { return [n.ConstructorCall, d[0], d[4]]; }
%}

lvalue -> %cast_token _ "<" _ typename _ ">" _ %lparen _ expression _ %rparen {%
    function (d) { return [n.CastOperation, d[4], d[10]]; }
%}

lvalue -> namespace_access {% id %}
namespace_access -> namespace_access _ "::" _ %identifier {%
    function (d) { return [n.NamespaceAccess, d[0], d[4]]; }
%}
namespace_access -> %identifier _ "::" _ %identifier {%
    function (d) { return [n.NamespaceAccess, d[0], d[4]]; }
%}

argumentlist -> null {%
    function(d) { return []; }
%}
argumentlist -> argument {%
    function(d) { return [d[0]]; }
%}
argumentlist -> argument _ "," _ argumentlist {%
    function(d) { return [d[0]].concat(d[4]); }
%}

argument -> expression {% id %}
argument -> %identifier _ "=" _ expression {%
    function (d) { return [n.NamedArgument, d[0], d[4]]; }
%}

const_number -> %number {%
    function(d) { return [n.ConstInteger, d[0] ]; }
%}

const_number -> %hex_number {%
    function(d) { return [n.ConstHexInteger, d[0] ]; }
%}

const_number -> %number "." %number "f" {%
    function(d) { return [n.ConstFloat, d[0].value+"."+d[2].value+"f"]; }
%}

const_number -> "." %number "f" {%
    function(d) { return [n.ConstFloat, "0."+d[1].value+"f"]; }
%}

const_number -> %number "." "f" {%
    function(d) { return [n.ConstFloat, d[0].value+".f"]; }
%}

const_number -> %number "." %number {%
    function(d) { return [n.ConstDouble, d[0].value+"."+d[2].value]; }
%}

const_number -> "." %number {%
    function(d) { return [n.ConstDouble, "0."+d[1].value]; }
%}

const_number -> %number "." {%
    function(d) { return [n.ConstDouble, d[0].value+".0"]; }
%}

constant -> %dqstring {%
    function(d) { return [n.ConstString, d[0]]; }
%}

constant -> %sqstring {%
    function(d) { return [n.ConstString, d[0]]; }
%}

constant -> "n" %dqstring {%
    function(d) { return [n.ConstName, d[1]]; }
%}

constant -> const_number {% id %}

unary_operator
    -> %op_binary_sum
     | %op_unary
     | %postfix_operator
{% id %}

typename -> const_qualifier:? unqualified_typename ref_qualifiers:? {%
    function (d) { return {
        ...d[1],
        const_qualifier: d[0],
        ref_qualifier: d[2],
    }}
%}

unqualified_typename -> typename_identifier {%
    function (d) { return {
        name: d[0].value,
        token: d[0],
    }}
%}

unqualified_typename -> template_typename {% id %}

template_typename -> typename_identifier _ "<" _ template_subtypes _ ">" {%
    function (d) {
        let name = d[0].value;
        name += "<";
        for (let i = 0; i < d[4].length; ++i)
        {
            if (i != 0) name += ",";
            name += d[4][i].name;
        }
        name += ">";
        return {
            name: name,
            token: d[0],
            basetype: d[0],
            subtypes: d[4],
        };
}%}

template_typename -> typename_identifier _ "<" _ template_subtypes_unterminated _ ">>" {%
    function (d) {
        let name = d[0].value;
        name += "<";
        for (let i = 0; i < d[4].length; ++i)
        {
            if (i != 0) name += ",";
            name += d[4][i].name;
        }
        name += ">";
        return {
            name: name,
            token: d[0],
            basetype: d[0],
            subtypes: d[4],
        };
}%}

typename_unterminated -> const_qualifier:? typename_identifier _ "<" _ template_subtypes _ {%
    function (d) {
        let name = d[1].value;
        name += "<";
        for (let i = 0; i < d[5].length; ++i)
        {
            if (i != 0) name += ",";
            name += d[5][i].name;
        }
        name += ">";
        return {
            name: name,
            token: d[1],
            const_qualifier: d[0],
            ref_qualifier: null,
            basetype: d[1],
            subtypes: d[5],
        };
}%}

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
        let subtypes = [d[1]];
        if (d[0])
        {
            for (let part of d[0])
                subtypes.push(part[0]);
        }
        return subtypes;
    }
%}

typename_identifier -> (%identifier _ %ns _ ):* %identifier {%
    function (d)
    {
        if (d[0])
        {
            let token = {};
            token.value = "";
            for (let part of d[0])
            {
                if (!token.offset)
                    token.offset = part[0].offset;
                token.value += part[0].value;
                token.value += "::";
            }
            token.value += d[1].value;
            return token;
        }
        else
        {
            return d[1];
        }
    }
%}

const_qualifier -> %const_token _ {%
    function (d) { return d[0].value; }
%}
ref_qualifiers -> _ "&" ("in" | "out" | "inout"):? {%
    function (d) { return d[2] ? d[1].value+d[2].value : d[1].value; }
%}

func_qualifiers -> null {%
    function(d) { return []; }
%}
func_qualifiers -> _ (func_qualifier __ ):* func_qualifier {%
    function(d) {
        let quals = [d[2]];
        if (d[1])
        {
            for (let part of d[1])
                quals.push(part[1]);
        }
        return quals;
    }
%}

func_qualifier -> "const" | "final" | "override" | "property" {% id %}

access_specifier -> "private" | "protected" | "public" {% id %}

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
        let value = d[1];
        if (d[0])
        {
            value.value = d[0][0].value + value.value;
            value.offset = d[0][0].offset;
        }
        return value;
    }
%}
case_label -> %identifier (_ %ns _ %identifier):* {%
    function (d)
    {
        let name = d[0].value;
        if (d[1])
        {
            for (let sub of d[1])
                name += "::"+sub[3].value;
        }
        return [name, d[0]];
    }
%}

enum_statement -> _ {%
    function (d) { return []; }
%}

enum_statement -> enum_decl (_ "," _ enum_decl):* {%
    function (d)
    {
        let result = [d[0]];
        if (d[1])
        {
            for (let sub of d[1])
                result.push(sub[3]);
        }
        return result;
    }
%}

enum_decl -> %identifier {% id %}
enum_decl -> %identifier _ "=" _ enum_value {%
    function (d) { return [d[0], d[4]]; }
%}

enum_value -> %identifier (_ %ns _ %identifier):* {%
    function (d)
    {
        let name = d[0].value;
        if (d[1])
        {
            for (let sub of d[1])
                name += "::"+sub[3].value;
        }
        return [name, d[0]];
    }
%}

enum_value -> ("-" _):? %number {%
    function (d) {
        let value = d[1];
        if (d[0])
        {
            value.value = d[0][0].value + value.value;
            value.offset = d[0][0].offset;
        }
        return value;
    }
%}