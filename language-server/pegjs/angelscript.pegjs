{{

const n = require("../grammar/node_types");

function Literal(range, node_type, value)
{
    range.type = node_type;
    range.value = value;
    return range;
}

function Identifier(range, value)
{
    range.type = n.Identifier;
    range.value = value;
    return range;
}

function Compound(range, node_type, children)
{
    range.type = node_type;
    range.children = children;
    return range;
}

function InnerCompound(range, node_type, children)
{
    range.type = node_type;
    range.children = children;
    if (children && children.length != 0)
    {
        let firstindex = 0;
        while (!children[firstindex] && firstindex < children.length)
            firstindex += 1;
        if (firstindex < children.length)
            range.start = children[firstindex].start;

        let lastindex = children.length - 1;
        while (!children[lastindex] && lastindex > 0)
            lastindex -= 1;
        if (lastindex >= 0)
            range.end = children[lastindex].end;
    }
    return range;
}

function CompoundOperator(range, node_type, operator, children)
{
    let node = Compound(range, node_type, children);
    node.operator = operator;
    return node;
}

function InnerCompoundOperator(range, node_type, operator, children)
{
    let node = InnerCompound(range, node_type, children);
    node.operator = operator;
    return node;
}

function ExtendedCompound(range, compound)
{
    compound.start = range.start;
    compound.end = range.end;
    return compound;
}

}}

start = _ @statement _
    / _ { return null; }

start_global
     = _ @global_statement _
     / comment:comment_documentation decl:global_declaration _
     {
        if (comment)
            decl.documentation = comment;
        return decl;
     }
    / _ { return null; }

start_class
    = _ @class_default_statement _
     / comment:comment_documentation decl:class_declaration _
     {
        if (comment)
            decl.documentation = comment;
        return decl;
     }
    / _ @incomplete_access_specifier _
    / _ { return null; }

start_enum
    = @enum_statement _
    / _ { return null; }

comment
    = "/" "*" (!("*" "/") .)* "*" "/"
    / "/" "/" [^\r\n]*
    / "#" [^\r\n]*
__
    = [ \t\r\n]+
    / [ \t\r\n]* (&[/#] comment [ \t\r\n]*)+
_
    = [ \t\r\n]* (&[/#] comment [ \t\r\n]*)*

op_postfix
    = $(
        "+" "+"
        / "-" "-"
    )

op_binary_logic
    = $(
        "&" "&"
        / "|" "|"
    )

op_binary_sum
    = @"+" !("=" / "+")
    / @"-" !("=" / "-")

op_binary_product
    = @"*" !"="
    / @"/" !"="
    / @"%" !"="

op_binary_compare
    = $(
        "=" "="
        / "!" "="
        / "<" "="
        / ">" "="
        / ">" ">"
        / "<" "<"
        / ">"
        / "<"
    )

op_binary_bitwise
    = @"|" !("|" / "=")
    / @"&" !("&" / "=")
    / @"^" !"="

op_assignment
    = @"=" !"="

op_compound_assignment
    = $(
        "+" "="
        / "-" "="
        / "/" "="
        / "*" "="
        / "~" "="
        / "^" "="
        / "|" "="
        / "&" "="
        / "%" "="
    )

op_unary
    = @"!" !"="
    / @"~" !"="

global_statement
    = import_statement
    / import_function_statement

global_declaration
    = delegate_decl
    / event_decl
    / struct_decl
    / class_decl
    / enum_decl
    / namespace_decl
    / asset_decl
    / macro:(@ufunction_macro _)? scope:(@("mixin" / "local") _)? decl:function_signature
    {
        decl.macro = macro;
        decl.scoping = scope;
        return decl;
    }
    / var_decl
    / incomplete_var_decl

class_declaration
    = access_decl
    / constructor_decl
    / destructor_decl
    / class_method_decl
    / class_property_decl

statement
    = if_statement
    / return_statement
    / else_statement
    / switch_statement
    / continue_statement
    / break_statement
    / while_statement
    / for_statement
    / case_statement
    / default_case_statement
    / var_decl
    / assignment
    / incomplete_var_decl

optional_statement = (_ &. @statement)?
optional_expression = (&. @expression)?
optional_assignment = (_ &. @assignment)?

if_statement
    = &"i" "if" _ "(" _ condition:optional_expression ")" body:optional_statement
    {
        return Compound(range(), n.IfStatement, [condition, body]);
    }

return_statement
    = &"r" "return" _ value:optional_expression
    {
        return Compound(range(), n.ReturnStatement, value ? [value] : []);
    }

else_statement
    = &"e" "else" body:optional_statement
    {
        return Compound(range(), n.ElseStatement, [body]);
    }

switch_statement
    = &"s" "switch" _ "(" _ cond:optional_expression ")"
    {
        return Compound(range(), n.SwitchStatement, [cond]);
    }

for_statement
    = &"f" "for" _ "(" inner:(
        init:(_ @for_declaration)?
        loop:(
            _ ";" _ cond:optional_expression
            iter:(
                ";" _ @for_comma_expression_list
            )?
            {
                return [cond, iter];
            }
        )? ")" body:optional_statement
        {
            return Compound(range(), n.ForLoop, loop ? [init, loop[0], loop[1], body] : [init, null, null, body]);
        }
        / type:typename _ iterator:identifier _ ":" _ expr:optional_expression ")" body:optional_statement
        {
            return Compound(range(), n.ForEachLoop, [type, iterator, expr, body]);
        }
    )
    {
        return ExtendedCompound(range(), inner);
    }

for_declaration
    = var_decl
    / expression
    / assignment

for_comma_expression_list
    = head:assignment tail:(_ "," _ @assignment)*
    {
        if (tail.length != 0)
            return Compound(range(), n.CommaExpression, [head].concat(tail));
        else
            return head;
    }

case_statement
    = &"c" "case" _ inner:(
        lbl:case_label stmt:(
            _ ":" _ body:statement
            { return [true, body]; }
            / _ ":" ":"
            { return [false, "::"]; }
            / _ ":"
            { return [false, ":"]; }
        )?
        {
            if (stmt)
            {
                if (stmt[0])
                {
                    let node = Compound(range(), n.CaseStatement, [lbl, stmt[1]]);
                    node.has_statement = true;
                    return node;
                }
                else if (lbl.type == n.Identifier)
                {
                    let inner = Compound(range(), n.NamespaceAccess, [lbl, null]);
                    if (stmt[1] == ":")
                        inner.incomplete_colon = true;
                    return Compound(range(), n.CaseStatement, [inner, null]);
                }
                else
                {
                    let node = Compound(range(), n.CaseStatement, [lbl, null]);
                    node.has_statement = true;
                    return node;
                }
            }
            else
            {
                return Compound(range(), n.CaseStatement, [lbl, null]);
            }
        }
    )
    {
        return ExtendedCompound(range(), inner);
    }

default_case_statement
    = &"d" "default" _ ":" body:optional_statement
    {
        return Compound(range(), n.DefaultCaseStatement, [body]);
    }

case_label
    = "(" _ @case_label _ ")"
    / ("-" _)? [0-9]+ { return Literal(range(), n.ConstInteger, text()); }
    / namespaced_identifier_no_trailing

continue_statement
    = &"c" token:"continue"
    {
        return Literal(range(), n.ContinueStatement, token);
    }

break_statement
    = &"b" token:"break"
    {
        return Literal(range(), n.BreakStatement, token);
    }

while_statement
    = &"w" "while" _ "(" _ cond:optional_expression ")" body:optional_statement
    {
        return Compound(range(), n.WhileLoop, [cond, body]);
    }

assignment
    = head:expression tail:(
        op:(op_assignment / op_compound_assignment) _ right:expression?
        {
            return [op, right];
        }
    )*
    {
        return tail.reduce(function(result, element)
        {
            if (element[0] == "=")
                return Compound(range(), n.Assignment, [result, element[1]]);
            else
                return CompoundOperator(range(), n.CompoundAssignment, element[0], [result, element[1]]);
        }, head);
    }

var_decl
    = type:typename _ head:var_decl_part tail:(
        _ "," _ @var_decl_part
    )*
    {
        head.typename = type;
        if (tail.length != 0)
        {
            let vars = [head];
            for (let part of tail)
            {
                part.typename = type;
                vars.push(part);
            }

            return Compound(range(), n.VariableDeclMulti, vars);
        }
        else
        {
            return ExtendedCompound(range(), head);
        }
    }

var_decl_part
    = name:identifier value:(
        _ "=" expr:(_ @expression)? { return [0, expr]; }
        / _ "(" _ args:argument_list_or_typename? ")" { return [1, args]; }
        / !(_ ("=" / "("))
    )
    {
        let node = Compound(range(), n.VariableDecl, null);
        node.name = name;
        if (value)
        {
            if (value[0] == 0)
                node.inline_assignment = true;
            else if (value[0] == 1)
                node.inline_constructor = true;
            node.expression = value[1];
        }
        return node;
    }

incomplete_var_decl
    = type:typename
    {
        let node = Compound(range(), n.VariableDecl, null);
        node.name = null;
        node.typename = type;
        return node;
    }

typename
     = constq:const_qualifier? name:unqualified_typename refq:ref_qualifiers?
     {
        let node = ExtendedCompound(range(), name);
        node.const_qualifier = constq;
        node.ref_qualifier = refq;
        return node;
     }

const_qualifier
    = &"c" token:"const" _
    {
        return Identifier(range(), token);
    }

ref_qualifiers
    = _ "&" type:(
        _ @(&"i" @("inout" / "in") / &"o" @"out")
        !identifier_char
    )?
    {
        if (type)
            return "&" + type;
        else
            return "&";
    }

template_typename
    = basetype:(
        typename_name !identifier_char
        { return Literal(range(), n.Typename, text()); }
    )
    subtypes:(
        _ "<" types:(
            _ head:typename tail:(
                _ "," _ @typename
            )*
            { return [head].concat(tail); }
        )? (_ ",")? _ ">"
        { return types; }
    )
    {
        if (subtypes)
        {
            let name = basetype.value + "<";
            for (let i = 0; i < subtypes.length; ++i)
            {
                if (i != 0)
                    name += ",";
                name += subtypes[i].value;
            }
            name += ">";

            let node = Literal(range(), n.Typename, name);
            node.basetype = basetype;
            node.subtypes = subtypes;
            return node;
        }
        else
        {
            let node = Literal(range(), n.Typename, basetype.value);
            node.name = basetype;
            return node;
        }
    }

primitive_typename
    = primitive_types
    {
        let node = Literal(range(), n.Typename, text());
        node.name = node;
        return node;
    }

unqualified_typename
    = basetype:(
        identifiers:typename_name|1.., _ ":" ":" _|
        {
            return Literal(range(), n.Typename, text());
        }
    )
    subtypes:(
        _ "<" types:(
            _ head:typename tail:(
                _ "," _ @typename
            )*
            { return [head].concat(tail); }
        )? (_ ",")? _ ">"
        { return types; }
    )?
    {
        if (subtypes)
        {
            let name = basetype.value + "<";
            for (let i = 0; i < subtypes.length; ++i)
            {
                if (i != 0)
                    name += ",";
                name += subtypes[i].value;
            }
            name += ">";

            let node = Literal(range(), n.Typename, name);
            node.basetype = basetype;
            node.subtypes = subtypes;
            return node;
        }
        else
        {
            let node = Literal(range(), n.Typename, basetype.value);
            node.name = basetype;
            return node;
        }
    }

expression
    = expr_ternary
    / keyword !identifier_char _ { return null; }

primary_expression
    = &"t" token:"this" _ { return Literal(range(), n.This, token); }
    / "(" _ @optional_expression ")" _
    / @namespaced_identifier _
        // Avoid parsing a template constructor as an identifier, we want to parse it as a constructor call later
        !("<" _ typename|..,_ "," _| _ ">" _ "(" )
    / @cast_expression _
    / @constructor_call _

namespaced_identifier
    = leading:(":" ":" _ )? ident:identifier namespaces:(_ ":" ":" _ @identifier?)* trailing:":"?
    {
        if (leading)
            ident = InnerCompound(range(), n.NamespaceAccess, [null, ident]);
        if (trailing)
            namespaces.push(null);
        if (namespaces.length != 0)
        {
            let outer = namespaces.reduce(function (result, element)
            {
                return InnerCompound(range(), n.NamespaceAccess, [result, element]);
            }, ident);
            if (trailing)
                outer.incomplete_colon = true;
            return outer;
        }
        else
        {
            return ident;
        }
    }

namespaced_identifier_no_trailing
    = leading:(":" ":" _ )? ident:identifier namespaces:(_ ":" ":" _ @identifier)*
    {
        if (leading)
            ident = InnerCompound(range(), n.NamespaceAccess, [null, ident]);
        if (namespaces.length != 0)
        {
            let outer = namespaces.reduce(function (result, element)
            {
                return InnerCompound(range(), n.NamespaceAccess, [result, element]);
            }, ident);
            return outer;
        }
        else
        {
            return ident;
        }
    }

call_expression
    = head:primary_expression
      tail:(
        "(" _ args:argument_list? ")" _ { return [0, args]; }
        / "[" _ inner:optional_expression "]" _ { return [1, inner]; }
        / "." inner:(_ @identifier)? _ { return [2, inner]; }
      )*
    {
        return tail.reduce(function (result, element) {
            if (element[0] == 0)
            {
                return InnerCompound(
                    range(),
                    n.FunctionCall,
                    [result, element[1]]
                );
            }
            else if (element[0] == 1)
            {
                return InnerCompound(
                    range(),
                    n.IndexOperator,
                    [result, element[1]]
                );
            }
            else if (element[0] == 2)
            {
                return InnerCompound(
                    range(),
                    n.MemberAccess,
                    [result, element[1]]
                );
            }
        }, head);
    }

argument_list
    = head:argument tail:(
       "," _ @argument?
    )*
    {
        return Compound(
            range(),
            n.ArgumentList,
            [head].concat(tail)
        );
    }
    / "," { return null; }

// This is an ambiguous node, which can either be a list of arguments,
// or a single typename due to the user still typing something incomplete
argument_list_or_typename
    = name:typename_name _ &")"
    {
        let ident = Literal(range(), n.Identifier, name);
        ident.maybeTypename = true;
        return Compound(
            range(),
            n.ArgumentList,
            [ident]
        );
    }
    / expr:template_typename _ &")"
    {
        return Compound(
            range(),
            n.ArgumentList,
            [expr]
        );
    }
    / argument_list

argument
    = name:identifier _ op_assignment _ expr:optional_expression
    { return Compound(range(), n.NamedArgument, [name, expr]); }
    / expr:expression trailing:(![,)=] @expression)? // INCOMPLETE: We are typing the argument name in front of an existing expression
    {
        if (trailing && expr.type == n.Identifier)
            return Compound(range(), n.NamedArgument, [expr, trailing]);
        else
            return expr;
    }

expr_ternary
    = condition:expr_binary_compare conseq:(
        "?" _ result:(
            first:expression second:(@(":" _)? @optional_expression)?
            {
                // We might have parsed the ":" as a trailing incomplete namespace,
                // if that happened we need to fix it manually
                if (first.type == n.NamespaceAccess && first.incomplete_colon)
                {
                    if (!second || !second[0])
                        return [first.children[0], second ? second[1] : null]
                }

                return [first, second ? second[1] : null];
            }
        )?
        { return result ? result : [null, null]; }
    )?
    {
        if (conseq)
            return Compound(range(), n.TernaryOperation, [condition, conseq[0], conseq[1]]);
        else
            return condition;
    }

expr_binary_compare
    = head:expr_binary_logic tail:(
        op:op_binary_compare _ expr:expr_binary_logic?
        { return [op, expr]; }
    )*
    {
        return tail.reduce(function (result, element) {
            return InnerCompoundOperator(
                range(),
                n.BinaryOperation,
                element[0],
                [result, element[1]]
            );
        }, head);
    }

expr_binary_logic
    = head:expr_binary_bitwise tail:(
        op:op_binary_logic _ expr:expr_binary_bitwise?
        { return [op, expr]; }
    )*
    {
        return tail.reduce(function (result, element) {
            return InnerCompoundOperator(
                range(),
                n.BinaryOperation,
                element[0],
                [result, element[1]]
            );
        }, head);
    }

expr_binary_bitwise
    = head:expr_binary_sum tail:(
        op:op_binary_bitwise _ expr:expr_binary_sum?
        { return [op, expr]; }
    )*
    {
        return tail.reduce(function (result, element) {
            return InnerCompoundOperator(
                range(),
                n.BinaryOperation,
                element[0],
                [result, element[1]]
            );
        }, head);
    }

expr_binary_sum
    = head:expr_binary_product tail:(
        op:op_binary_sum _ expr:expr_binary_product?
        { return [op, expr]; }
    )*
    {
        return tail.reduce(function (result, element) {
            return InnerCompoundOperator(
                range(),
                n.BinaryOperation,
                element[0],
                [result, element[1]]
            );
        }, head);
    }

expr_binary_product
    = head:expr_unary tail:(
        op:op_binary_product _ expr:expr_unary?
        { return [op, expr]; }
    )*
    {
        return tail.reduce(function (result, element) {
            return InnerCompoundOperator(
                range(),
                n.BinaryOperation,
                element[0],
                [result, element[1]]
            );
        }, head);
    }

expr_unary = op:(op_unary / op_binary_sum / op_postfix) _ expr:expr_unary _
    {
        return CompoundOperator(
            range(),
            n.UnaryOperation,
            op,
            [expr]
        );
    }
    / expr_postfix

expr_postfix
    = expr:expr_leaf op:(@(op_postfix / (@"!" !"=")) _)?
    {
        if (op)
        {
            return CompoundOperator(
                range(),
                n.PostfixOperation,
                op,
                [expr]
            );
        }
        else
        {
            return expr;
        }
    }

expr_leaf
    = @call_expression
    / @constant _
    / op:(op_unary / op_binary_sum / op_postfix) _ // INCOMPLETE: We haven't typed the rest of the unary operation yet
        { return CompoundOperator(range(), n.UnaryOperation, op, []); }

cast_expression
    = &"C" "Cast" _ inner:(
        "<" _ type:typename _ ">" _ "(" _ expr:optional_expression ")"
        { return Compound(range(), n.CastOperation, [type, expr]); }
        / "<" _ type:typename (_ ">")?
        { return Compound(range(), n.CastOperation, [type, null]); }
        / (_ "<")?
        { return Compound(range(), n.CastOperation, [null, null]); }
    )
    {
        return ExtendedCompound(range(), inner);
    }

constructor_call
    = type:(
        template_typename / primitive_typename
    ) _ "(" _ args:argument_list? ")"
    {
        return Compound(range(), n.ConstructorCall, [type, args]);
    }

constant
    = &"t" "true" !identifier_char { return Literal(range(), n.ConstBool, "true"); }
    / &"f" "false" !identifier_char { return Literal(range(), n.ConstBool, "false"); }
    / &"n" "nullptr" !identifier_char { return Literal(range(), n.ConstNullptr, "nullptr"); }
    / !("0" ("x" / "b" / "o")) @decimal_literal
    / name_literal
    / string_literal
    / fstring_literal
    / char_literal
    / hex_literal
    / octal_literal
    / binary_literal

string_literal
    = "\"" "\"" "\"" multiline_string_content* "\"" "\"" "\""
    {
        return Literal(range(), n.ConstString, text());
    }
    / "\"" string_content* "\""
    {
        return Literal(range(), n.ConstString, text());
    }

string_content
    = [^\r\n"\\]+
    / escape_sequence
multiline_string_content
    = !("\\" / "\"\"\"") .
    / escape_sequence
escape_sequence
    = "\\" ([A-Za-z"'\\] / [0-9]+)

fstring_literal
    = "f" "\"" string_content* "\""
    {
        return Literal(range(), n.ConstFormatString, text());
    }

name_literal
    = "n" "\"" string_content* "\""
    {
        return Literal(range(), n.ConstName, text());
    }

char_literal
    = "'" content:char_content* "'"
    {
        return Literal(range(), n.ConstString, text());
    }
char_content
    = [^\r\n'\\]+
    / escape_sequence

decimal_literal
    = head:(
        [0-9]+ (
            "." [0-9]*
            )?
        / "." [0-9]+
    ) exponent:(
        "e" "-"? [0-9]+
    )? suffix:"f"? {
        let value = head[1];
        if (exponent)
            value += exponent;
        if (suffix)
            value += suffix;

        if (suffix)
        {
            return Literal(range(), n.ConstFloat, text());
        }
        else if (exponent || head[0])
        {
            return Literal(range(), n.ConstDouble, text());
        }
        else
        {
            return Literal(range(), n.ConstInteger, text());
        }
    }

signed_decimal_literal
    = sign:("-" _)? num:decimal_literal
    {
        if (sign)
            return Literal(range(), num.type, text());
        return num;
    }

hex_literal = "0" "x" [0-9A-Fa-f]*
    {
        return Literal(range(), n.ConstHexInteger, text());
    }

binary_literal = "0" "b" [01]*
    {
        return Literal(range(), n.ConstBinaryInteger, text());
    }

octal_literal = "0" "o" [0-8]*
    {
        return Literal(range(), n.ConstOctalInteger, text());
    }

keyword
    = &"i" @(
        "if"
    )
    / &"r" @(
        "return"
    )
    / &"b" @(
        "break"
    )
    / &"w" @(
        "while"
    )
    / &"c" @(
        "class"
        / "continue"
        / "case"
        / "const"
    )
    / &"s" @(
        "struct"
        / "switch"
    )
    / &"v" @(
        "void"
    )
    / &"o" @(
        "override"
    )
    / &"d" @(
        "delegate"
        / "default"
    )
    / &"p" @(
        "property"
    )
    / &"e" @(
        "event"
        / "enum"
        / "else"
    )
    / &"m" @(
        "mixin"
    )
    / &"l" @(
        "local"
    )
    / &"C" @(
        "Cast"
    )
    / &"t" @(
        "true"
        / "this"
    )
    / &"f" @(
        "false"
        / "final"
        / "for"
    )
    / &"a" @(
        "access"
    )
    / &"n" @(
        "nullptr"
        / "namespace"
    )
    / &"U" @(
        "UFUNCTION"
        / "UPROPERTY"
        / "UCLASS"
        / "UENUM"
        / "UMETA"
        / "USTRUCT"
    )

standard_template_basetype
    = &"T" @(
        "TSubclassOf"
        / "TArray"
        / "TMap"
        / "TSet"
        / "TOptional"
        / "TWeakObjectPtr"
        / "TSoftObjectPtr"
        / "TSoftClassPtr"
        / "TInstigated"
        / "TPerPlayer"
    )

primitive_types
    = &"f" @("float32" / "float64" / "float")
    / &"i" @("int64" / "int32" / "int16" / "int8" / "int")
    / &"u" @("uint64" / "uint32" / "uint16" / "uint8" / "uint")
    / &"b" @("bool")

identifier
     = !((keyword / standard_template_basetype / primitive_types) !identifier_char) start:identifier_start rest:identifier_rest ! '"' { return Identifier(range(), text()); }

identifier_name
     = $(!((keyword / standard_template_basetype / primitive_types) !identifier_char) start:identifier_start rest:identifier_rest !'"')

typename_name
     = $(!(keyword !identifier_char) start:identifier_start rest:identifier_rest !'"')

identifier_start
    = [A-Za-z_]
identifier_rest
    = [A-Za-z_0-9]*
identifier_char
    = [A-Za-z_0-9]

import_statement
    = &"i" "import" _ head:identifier tail:("." @identifier)*
    {
        let identifier = InnerCompound(range(), n.Identifier, [head].concat(tail));
        identifier.value = head.value;
        for (let child of tail)
            identifier.value += "." + child.value;
        return Compound(range(), n.ImportStatement, [identifier]);
    }

import_function_statement
    = &"i" "import" _ sig:function_signature _ "from" _ str:(
        (string_literal / char_literal)
        { let value = text(); return Identifier(range(), value.substring(1, value.length-1)); }
    )
    {
        return Compound(range(), n.ImportFunctionStatement, [sig, str]);
    }

comment_documentation
    = [ \t\r\n]* docs:(&[/#] @$comment [ \t\r\n]*)*
    {
        if (docs.length == 0)
            return null;

        let result = "";
        for (let comment of docs)
        {
            if (!comment || comment[0] == '#')
                continue;
            else if (comment[0] == '/' && comment[1] == '*')
                result = comment.substring(2, comment.length-2);
            else if (comment[0] == '/' && comment[1] == '/')
                result = comment.substring(2);
        }
        return result;
    }

function_signature
    = ret:function_return name:identifier _ "(" params:parameter_list _ ")" quals:func_qualifiers
    {
        let node = Compound(range(), n.FunctionDecl, null);
        node.name = name;
        node.returntype = ret;
        node.parameters = params;
        node.qualifiers = quals;
        return node;
    }
    / void_type __ name:identifier params:(_ "(" @params:parameter_list_incomplete _ ")")? // INCOMPLETE: Rest of the function signature isn't there yet
    {
        let node = Compound(range(), n.FunctionDecl, null);
        node.name = name;
        node.returntype = null;
        node.parameters = params;
        node.qualifiers = [];
        return node;
    }

function_return
    = @void_type __
    / @typename _
void_type
    = &"v" "void"
    { return null; }
func_qualifiers
    = (_ @("const" / "final" / "override" / "property" / (!"from" @identifier_name)))*

parameter_list
    = params:(
        _ ("," _)? head:parameter tail:(_ "," _ @parameter_incomplete)* (_ ",")?
        {
            let params = [];
            if (head)
                params.push(head);
            for (let p of tail)
            {
                if (p)
                    params.push(p);
            }
            return params;
        }
      )?
    {
        return params ? params : [];
    }

parameter_list_incomplete
    = params:(
        _ ("," _)? head:parameter_incomplete tail:(_ "," _ @parameter_incomplete)* (_ ",")?
        {
            let params = [];
            if (head)
                params.push(head);
            for (let p of tail)
            {
                if (p)
                    params.push(p);
            }
            return params;
        }
      )?
    {
        return params ? params : [];
    }

parameter
    = type:typename _ name:identifier expr:(_ "=" _ @optional_expression)?
    {
        let node = Compound(range(), n.Parameter, null);
        node.typename = type;
        node.name = name;
        node.expression = expr;
        return node;
    }
    / "const" { return null; }
    / standard_template_basetype !identifier_char { return null; }
    / primitive_types !identifier_char { return null; }

parameter_incomplete
    = type:typename decl:(
        _ name:identifier expr:(_ "=" _ @optional_expression)?
        { return [name, expr]; }
    )?
    {
        let node = Compound(range(), n.Parameter, null);
        node.typename = type;
        if (decl)
        {
            node.name = decl[0];
            node.expression = decl[1];
        }
        return node;
    }
    / "const" { return null; }

ufunction_macro
    = &"U" "UFUNCTION" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

uproperty_macro
    = &"U" "UPROPERTY" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

ustruct_macro
    = &"U" "USTRUCT" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

uclass_macro
    = &"U" "UCLASS" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

uenum_macro
    = &"U" "UENUM" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

umeta_macro
    = &"U" "UMETA" _ "(" macros:macro_list _ ")"
    {
        return Compound(range(), n.Macro, macros);
    }

macro_list
    = specifiers:(
        _ ("," _)? head:macro_argument tail:(_ "," _ @macro_argument)* (_ ",")?
        {
            let specifiers = [];
            if (head)
                specifiers.push(head);
            for (let p of tail)
            {
                if (p)
                    specifiers.push(p);
            }
            return specifiers;
        }
      )?
    {
        return specifiers ? specifiers : [];
    }

macro_argument
    = name:macro_identifier value:(
        _ "=" _ @(
            value:macro_value
            { return [0, value]; }
            / "(" list:macro_list _ ")"
            { return[1, list]; }
        )?
    )?
    {
        let node = Compound(range(), n.MacroArgument, null);
        node.name = name;

        if (value)
        {
            if (value[0] == 0)
                node.value = value[1];
            else if (value[0] == 1)
                node.children = value[1];
        }

        return node;
    }

macro_identifier
    = identifier
    / str:(string_literal / char_literal)
    {
        return Identifier(range(), str.value.substring(1, str.value.length-1));
    }

macro_value
    = ("!" _)? identifier_name|1.., _ [|:]+ _|
    {
        return Identifier(range(), text());
    }
    / keyword
    {
        return Identifier(range(), text());
    }
    / signed_decimal_literal
    / macro_identifier

delegate_decl
    = &"d" "delegate" _ sig:function_signature
    {
        return Compound(range(), n.DelegateDecl, [sig]);
    }

event_decl
    = &"e" "event" _ sig:function_signature
    {
        return Compound(range(), n.EventDecl, [sig]);
    }

struct_decl
    = macro:(@ustruct_macro _)? &"s" "struct" _ name:identifier
    {
        let node = Compound(range(), n.StructDefinition, null);
        node.name = name;
        node.macro = macro;
        return node;
    }

class_decl
    = macro:(@uclass_macro _)? &"c" "class" _ name:identifier superclass:(
        _ ":" _ @(
            identifier_name (_ ":" ":" _ identifier_name)*
            {
                return Identifier(range(), text());
            }
        )
    )?
    {
        let node = Compound(range(), n.ClassDefinition, null);
        node.name = name;
        node.macro = macro;
        node.superclass = superclass;
        return node;
    }

enum_decl
    = macro:(@uenum_macro _)? &"e" "enum" _ name:identifier
    {
        let node = Compound(range(), n.EnumDefinition, null);
        node.name = name;
        node.macro = macro;
        return node;
    }

namespace_decl
    = &"n" "namespace" _ name:(
        identifier_name (_ ":" ":" _ identifier_name)*
        {
            return Identifier(range(), text());
        }
    )
    {
        let node = Compound(range(), n.NamespaceDefinition, null);
        node.name = name;
        return node;
    }

asset_decl
    = &"a" "asset" _ name:identifier _ "of" _ type:typename
    {
        let node = Compound(range(), n.AssetDefinition, null);
        node.name = name;
        node.typename = type;
        return node;
    }

class_method_decl
    = pre_access:(@access_specifier _)? macro:(@ufunction_macro _)? post_access:(@access_specifier _)? decl:function_signature
    {
        decl.macro = macro;
        decl.access = pre_access ? pre_access : post_access;
        return decl;
    }

constructor_decl
    = name:identifier _ "(" params:parameter_list _ ")"
    {
        let node = Compound(range(), n.ConstructorDecl, null);
        node.name = name;
        node.parameters = params;
        return node;
    }

destructor_decl
    = name:(
        "~" identifier_name
        { return Identifier(range(), text()); }
    ) _ "(" _ ")"
    {
        let node = Compound(range(), n.DestructorDecl, null);
        node.name = name;
        return node;
    }

class_property_decl
    = pre_access:(@access_specifier _)? macro:(@uproperty_macro _)? post_access:(@access_specifier _)? decl:(var_decl / incomplete_var_decl)
    {
        decl.macro = macro;
        decl.access = pre_access ? pre_access : post_access;
        return decl;
    }

access_specifier
    = &"p" ("private" / "protected" / "public")
    { return Identifier(range(), text()); }
    / &"a" "access" @(_ ":" _ @identifier)?

access_decl
    = &"a" "access" body:(
        _ name:identifier
        list:(_ "=" @(_ @access_list)?)?
        {
            let node = Compound(range(), n.AccessDeclaration, null);
            node.name = name;
            node.classList = list ? list : [];
            return node;
        }
    )? !(_ ":")
    {
        if (!body)
            return null;
        return ExtendedCompound(range(), body);
    }

access_list
    = head:access_class tail:(_ "," _ @access_class)* (_ ",")?
    {
        return [ head ].concat(tail);
    }

access_class
     = name:(identifier / "*" { return Identifier(range(), text()); })
       mods:(_ "(" _ @access_mod_list? _ ")")?
    {
        let node = Compound(range(), n.AccessClass, null);
        node.className = name;
        node.mods = mods;
        return node;
    }

access_mod_list
    = head:identifier tail:(_ "," _ @identifier)* (_ ",")?
    {
        return [ head ].concat(tail);
    }

incomplete_access_specifier
     = &"a" "access" _ ":" name:(_ @identifier)?
     {
        return Compound(range(), n.IncompleteAccessSpecifier, [name]);
     }

class_default_statement
    = &"d" "default" _ expr:assignment
    {
        return Compound(range(), n.DefaultStatement, [expr]);
    }

enum_statement
    = head:enum_value_decl tail:(_ "," @enum_value_decl)* (_ ",")?
    {
        return Compound(range(), n.EnumValueList, [head].concat(tail));
    }

enum_value_decl
    = comment:comment_documentation name:identifier expr:(_ "=" _ @optional_expression)? meta:(_ @umeta_macro)?
    {
        let node = Compound(range(), n.EnumValue, null);
        node.name = name;
        node.documentation = comment;
        node.value = expr;
        node.meta = meta;
        return node;
    }