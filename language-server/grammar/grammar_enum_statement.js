// Generated automatically by nearley, version 2.20.1
// http://github.com/Hardmath123/nearley
(function () {
function id(x) { return x[0]; }


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

var grammar = {
    Lexer: lexer,
    ParserRules: [
    {"name": "optional_statement", "symbols": [], "postprocess": 
        function (d) { return null; }
        },
    {"name": "optional_statement", "symbols": ["_", "statement"], "postprocess": 
        function (d) { return d[1]; }
        },
    {"name": "optional_expression", "symbols": [], "postprocess": 
        function (d) { return null; }
        },
    {"name": "optional_expression", "symbols": ["_", "expression"], "postprocess": 
        function (d) { return d[1]; }
        },
    {"name": "statement", "symbols": ["expression"], "postprocess": id},
    {"name": "statement", "symbols": ["assignment"], "postprocess": id},
    {"name": "statement", "symbols": ["var_decl"], "postprocess": id},
    {"name": "assignment", "symbols": ["lvalue", "_", {"literal":"="}, "_", "expression_or_assignment"], "postprocess": 
        function (d) { return [n.Assignment, d[0], d[4][0]]; }
        },
    {"name": "assignment$subexpression$1", "symbols": ["expression"]},
    {"name": "assignment$subexpression$1", "symbols": ["assignment"]},
    {"name": "assignment", "symbols": ["lvalue", "_", (lexer.has("compound_assignment") ? {type: "compound_assignment"} : compound_assignment), "_", "assignment$subexpression$1"], "postprocess": 
        function (d) { return [n.CompoundAssignment, d[0], d[2], d[4][0]]; }
        },
    {"name": "expression_or_assignment", "symbols": ["expression"], "postprocess": id},
    {"name": "expression_or_assignment", "symbols": ["assignment"], "postprocess": id},
    {"name": "statement", "symbols": [(lexer.has("if_token") ? {type: "if_token"} : if_token), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "expression_or_assignment", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "optional_statement"], "postprocess": 
        function (d) { return [n.IfStatement, d[4], d[7]]; }
        },
    {"name": "statement", "symbols": [(lexer.has("return_token") ? {type: "return_token"} : return_token), "_", "expression_or_assignment"], "postprocess": 
        function (d) { return [n.ReturnStatement, d[2]]; }
        },
    {"name": "statement", "symbols": [(lexer.has("else_token") ? {type: "else_token"} : else_token), "_", "statement"], "postprocess": 
        function (d) { return [n.ElseStatement, d[2]]; }
        },
    {"name": "statement", "symbols": [(lexer.has("case_token") ? {type: "case_token"} : case_token), "_", "case_label", "_", (lexer.has("colon") ? {type: "colon"} : colon), "optional_statement"], "postprocess": 
        function (d) { return [n.CaseStatement, d[2], d[5]]; }
        },
    {"name": "statement", "symbols": [(lexer.has("default_token") ? {type: "default_token"} : default_token), (lexer.has("colon") ? {type: "colon"} : colon), "optional_statement"], "postprocess": 
        function (d) { return [n.CaseStatement, d[0], d[2]]; }
        },
    {"name": "statement$ebnf$1$subexpression$1", "symbols": ["_", "for_declaration"]},
    {"name": "statement$ebnf$1", "symbols": ["statement$ebnf$1$subexpression$1"], "postprocess": id},
    {"name": "statement$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "statement", "symbols": [(lexer.has("for_token") ? {type: "for_token"} : for_token), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "statement$ebnf$1", "_", (lexer.has("semicolon") ? {type: "semicolon"} : semicolon), "optional_expression", "_", (lexer.has("semicolon") ? {type: "semicolon"} : semicolon), "for_comma_expression_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "optional_statement"], "postprocess": 
        function (d) { return [n.ForLoop, d[3] ? d[3][1] : null, d[6], d[9], d[12]]; }
        },
    {"name": "for_declaration", "symbols": ["var_decl"]},
    {"name": "for_declaration", "symbols": ["expression"]},
    {"name": "for_declaration", "symbols": ["assignment"], "postprocess": id},
    {"name": "for_comma_expression_list", "symbols": [], "postprocess": 
        function (d) { return null; }
        },
    {"name": "for_comma_expression_list", "symbols": ["_", "for_comma_expression"], "postprocess": 
        function (d) { return d[1]; }
        },
    {"name": "for_comma_expression_list$ebnf$1$subexpression$1", "symbols": ["_", {"literal":","}, "_", "for_comma_expression"]},
    {"name": "for_comma_expression_list$ebnf$1", "symbols": ["for_comma_expression_list$ebnf$1$subexpression$1"]},
    {"name": "for_comma_expression_list$ebnf$1$subexpression$2", "symbols": ["_", {"literal":","}, "_", "for_comma_expression"]},
    {"name": "for_comma_expression_list$ebnf$1", "symbols": ["for_comma_expression_list$ebnf$1", "for_comma_expression_list$ebnf$1$subexpression$2"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "for_comma_expression_list", "symbols": ["_", "for_comma_expression", "for_comma_expression_list$ebnf$1"], "postprocess": 
        function (d) {
            exprs = [d[1]];
            for (let part of d[2])
                exprs.push(part[3]);
            return [n.CommaExpression, exprs];
        }
        },
    {"name": "for_comma_expression", "symbols": ["expression"], "postprocess": id},
    {"name": "for_comma_expression", "symbols": ["assignment"], "postprocess": id},
    {"name": "statement", "symbols": [(lexer.has("for_token") ? {type: "for_token"} : for_token), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("colon") ? {type: "colon"} : colon), "_", "expression", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "optional_statement"], "postprocess": 
        function (d) { return [n.ForEachLoop, d[4], d[6], d[10], d[13]]; }
        },
    {"name": "statement", "symbols": [(lexer.has("while_token") ? {type: "while_token"} : while_token), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "expression", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "optional_statement"], "postprocess": 
        function (d) { return [n.WhileLoop, d[4], d[7]]; }
        },
    {"name": "global_statement$ebnf$1", "symbols": []},
    {"name": "global_statement$ebnf$1$subexpression$1", "symbols": [(lexer.has("dot") ? {type: "dot"} : dot), (lexer.has("identifier") ? {type: "identifier"} : identifier)]},
    {"name": "global_statement$ebnf$1", "symbols": ["global_statement$ebnf$1", "global_statement$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "global_statement", "symbols": [(lexer.has("import_token") ? {type: "import_token"} : import_token), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "global_statement$ebnf$1"], "postprocess": 
        function (d) {
            let modulename = d[2].value;
            for (let part of d[3])
                modulename += "."+part[1].value;
            return [n.ImportStatement, modulename];
        }
        },
    {"name": "global_statement$subexpression$1", "symbols": [(lexer.has("dqstring") ? {type: "dqstring"} : dqstring)]},
    {"name": "global_statement$subexpression$1", "symbols": [(lexer.has("sqstring") ? {type: "sqstring"} : sqstring)]},
    {"name": "global_statement", "symbols": [(lexer.has("import_token") ? {type: "import_token"} : import_token), "_", "function_signature", "_", {"literal":"from"}, "_", "global_statement$subexpression$1"], "postprocess": 
        function (d) {
            return [n.ImportFunctionStatement, d[6], d[2][0]];
        }
        },
    {"name": "global_statement$ebnf$2", "symbols": ["ufunction_macro"], "postprocess": id},
    {"name": "global_statement$ebnf$2", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "global_statement", "symbols": ["global_statement$ebnf$2", "function_signature"], "postprocess": 
        function (d) { return [n.FunctionDecl, {
            ...d[1],
            macro: d[0],
        }]; }
        },
    {"name": "global_statement", "symbols": ["delegate_decl"], "postprocess": id},
    {"name": "global_statement", "symbols": ["event_decl"], "postprocess": id},
    {"name": "global_statement", "symbols": ["var_decl"], "postprocess": id},
    {"name": "global_statement$ebnf$3", "symbols": ["ustruct_macro"], "postprocess": id},
    {"name": "global_statement$ebnf$3", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "global_statement", "symbols": ["global_statement$ebnf$3", (lexer.has("struct_token") ? {type: "struct_token"} : struct_token), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.StructDefinition, {
            name: d[4],
            macro: d[0]
        }]; }
        },
    {"name": "global_statement$ebnf$4", "symbols": ["uclass_macro"], "postprocess": id},
    {"name": "global_statement$ebnf$4", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "global_statement$ebnf$5$subexpression$1", "symbols": ["_", (lexer.has("colon") ? {type: "colon"} : colon), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)]},
    {"name": "global_statement$ebnf$5", "symbols": ["global_statement$ebnf$5$subexpression$1"], "postprocess": id},
    {"name": "global_statement$ebnf$5", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "global_statement", "symbols": ["global_statement$ebnf$4", (lexer.has("class_token") ? {type: "class_token"} : class_token), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "global_statement$ebnf$5"], "postprocess": 
        function (d) { return [n.ClassDefinition, {
            name: d[4],
            macro: d[0],
            superclass: d[9],
        }]; }
        },
    {"name": "global_statement", "symbols": [(lexer.has("enum_token") ? {type: "enum_token"} : enum_token), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.EnumDefinition, {
            name: d[2]
        }]; }
        },
    {"name": "global_statement", "symbols": [{"literal":"asset"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"of"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.AssetDefinition, d[2], d[6]]; }
        },
    {"name": "global_statement", "symbols": [{"literal":"settings"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"for"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.AssetDefinition, d[2], d[6]]; }
        },
    {"name": "class_statement$ebnf$1", "symbols": ["uproperty_macro"], "postprocess": id},
    {"name": "class_statement$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "class_statement$ebnf$2$subexpression$1", "symbols": ["access_specifier", "_"]},
    {"name": "class_statement$ebnf$2", "symbols": ["class_statement$ebnf$2$subexpression$1"], "postprocess": id},
    {"name": "class_statement$ebnf$2", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "class_statement", "symbols": ["class_statement$ebnf$1", "class_statement$ebnf$2", "var_decl"], "postprocess": 
        function (d) {
            return [ d[2][0], { ...d[2][1], access: d[1] ? d[1][0] : null, macro: d[0] } ];
        }
        },
    {"name": "class_statement$ebnf$3", "symbols": ["ufunction_macro"], "postprocess": id},
    {"name": "class_statement$ebnf$3", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "class_statement$ebnf$4$subexpression$1", "symbols": ["access_specifier", "_"]},
    {"name": "class_statement$ebnf$4", "symbols": ["class_statement$ebnf$4$subexpression$1"], "postprocess": id},
    {"name": "class_statement$ebnf$4", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "class_statement", "symbols": ["class_statement$ebnf$3", "class_statement$ebnf$4", "function_signature"], "postprocess": 
        function (d) { return [n.FunctionDecl, {
            ...d[2],
            macro: d[0],
            access: d[1] ? d[1][0] : null,
        }]; }
        },
    {"name": "class_statement", "symbols": ["access_specifier", "_", "ufunction_macro", "function_signature"], "postprocess": 
        function (d) { return [n.FunctionDecl, {
            ...d[4],
            macro: d[2],
            access: d[0],
        }]; }
        },
    {"name": "class_statement", "symbols": ["constructor_decl"], "postprocess": id},
    {"name": "class_statement", "symbols": ["destructor_decl"], "postprocess": id},
    {"name": "class_statement", "symbols": [(lexer.has("default_token") ? {type: "default_token"} : default_token), "_", "expression"], "postprocess": 
        function (d) { return [n.DefaultStatement, d[2]]; }
        },
    {"name": "class_statement", "symbols": [(lexer.has("default_token") ? {type: "default_token"} : default_token), "_", "assignment"], "postprocess": 
        function (d) { return [n.DefaultStatement, d[2]]; }
        },
    {"name": "var_decl", "symbols": ["typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.VariableDecl, {
            name: d[2],
            typename: d[0],
            expression: null,
        }]; }
        },
    {"name": "var_decl", "symbols": ["typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"="}, "_", "expression"], "postprocess": 
        function (d) { return [n.VariableDecl, {
            name: d[2],
            typename: d[0],
            expression: d[6],
            inline_assignment: true,
        }]; }
        },
    {"name": "var_decl", "symbols": ["typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "argumentlist", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": 
        function (d) { return [n.VariableDecl, {
            name: d[2],
            typename: d[0],
            expression: d[6],
            inline_constructor: true,
        }]; }
        },
    {"name": "var_decl$ebnf$1$subexpression$1", "symbols": ["_", (lexer.has("comma") ? {type: "comma"} : comma), "_", "var_decl_multi_part"]},
    {"name": "var_decl$ebnf$1", "symbols": ["var_decl$ebnf$1$subexpression$1"]},
    {"name": "var_decl$ebnf$1$subexpression$2", "symbols": ["_", (lexer.has("comma") ? {type: "comma"} : comma), "_", "var_decl_multi_part"]},
    {"name": "var_decl$ebnf$1", "symbols": ["var_decl$ebnf$1", "var_decl$ebnf$1$subexpression$2"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "var_decl", "symbols": ["typename", "_", "var_decl_multi_part", "var_decl$ebnf$1"], "postprocess": 
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
        },
    {"name": "var_decl_multi_part$ebnf$1$subexpression$1", "symbols": ["_", {"literal":"="}, "_", "expression"]},
    {"name": "var_decl_multi_part$ebnf$1", "symbols": ["var_decl_multi_part$ebnf$1$subexpression$1"], "postprocess": id},
    {"name": "var_decl_multi_part$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "var_decl_multi_part", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "var_decl_multi_part$ebnf$1"], "postprocess": 
        function (d) {
            if (d[2])
                return { name: d[0], expression: d[2][2], inline_assignment: true };
            else
                return { name: d[0] };
        }
        },
    {"name": "delegate_decl", "symbols": [{"literal":"delegate"}, "_", "function_signature"], "postprocess": 
        function (d) { return [n.DelegateDecl, {
            ...d[2]
        }]; }
        },
    {"name": "event_decl", "symbols": [{"literal":"event"}, "_", "function_signature"], "postprocess": 
        function (d) { return [n.EventDecl, {
            ...d[2],
            macro: d[0],
        }]; }
        },
    {"name": "constructor_decl", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "parameter_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": 
        function (d) { return [n.ConstructorDecl, {
            name: d[0],
            parameters: d[4],
        }]; }
        },
    {"name": "destructor_decl", "symbols": [{"literal":"~"}, (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "parameter_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": 
        function (d) { return [n.DestructorDecl, d[1]]; }
        },
    {"name": "function_signature", "symbols": ["function_return", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "parameter_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "func_qualifiers"], "postprocess": 
        function (d) { return {
            name: d[2],
            returntype: d[0],
            parameters: d[6],
            qualifiers: d[9],
        }; }
        },
    {"name": "function_return", "symbols": ["typename"]},
    {"name": "function_return", "symbols": [(lexer.has("void_token") ? {type: "void_token"} : void_token)], "postprocess": id},
    {"name": "ufunction_macro", "symbols": [(lexer.has("ufunction") ? {type: "ufunction"} : ufunction), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "macro_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "_"], "postprocess": 
        function (d) { return d[4]; }
        },
    {"name": "uproperty_macro", "symbols": [(lexer.has("uproperty") ? {type: "uproperty"} : uproperty), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "macro_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "_"], "postprocess": 
        function (d) { return d[4]; }
        },
    {"name": "uclass_macro", "symbols": [(lexer.has("uclass") ? {type: "uclass"} : uclass), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "macro_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "_"], "postprocess": 
        function (d) { return d[4]; }
        },
    {"name": "ustruct_macro", "symbols": [(lexer.has("ustruct") ? {type: "ustruct"} : ustruct), "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "macro_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen), "_"], "postprocess": 
        function (d) { return d[4]; }
        },
    {"name": "parameter_list", "symbols": [], "postprocess": 
        function(d) { return []; }
        },
    {"name": "parameter_list$ebnf$1", "symbols": []},
    {"name": "parameter_list$ebnf$1$subexpression$1", "symbols": ["_", {"literal":","}, "_", "parameter"]},
    {"name": "parameter_list$ebnf$1", "symbols": ["parameter_list$ebnf$1", "parameter_list$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "parameter_list", "symbols": ["parameter", "parameter_list$ebnf$1"], "postprocess": 
        function(d) {
            let params = [d[0]];
            if (d[1])
            {
                for (let part of d[1])
                    params.push(part[3]);
            }
            return params;
        }
        },
    {"name": "parameter", "symbols": ["typename"], "postprocess": 
        function (d) { return [d[0], null, null]; }
        },
    {"name": "parameter", "symbols": ["typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [d[0], d[2], null]; }
        },
    {"name": "parameter", "symbols": ["typename", "_", (lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"="}, "_", "expression"], "postprocess": 
        function (d) { return [d[0], d[2], d[6]]; }
        },
    {"name": "macro_list", "symbols": [], "postprocess": 
        function(d) { return []; }
        },
    {"name": "macro_list$ebnf$1", "symbols": []},
    {"name": "macro_list$ebnf$1$subexpression$1", "symbols": ["_", {"literal":","}, "_", "macro_argument"]},
    {"name": "macro_list$ebnf$1", "symbols": ["macro_list$ebnf$1", "macro_list$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "macro_list", "symbols": ["macro_argument", "macro_list$ebnf$1"], "postprocess": 
        function(d) {
            let args = [d[0]];
            if (d[1])
            {
                for (let part of d[1])
                    args.push(part[3]);
            }
            return args;
        }
        },
    {"name": "macro_argument", "symbols": ["macro_identifier"], "postprocess":  
        function (d) { return [d[0], null]; }
        },
    {"name": "macro_argument", "symbols": ["macro_identifier", "_", {"literal":"="}, "_", "macro_value"], "postprocess": 
        function (d) { return [d[0], d[4]]; }
        },
    {"name": "macro_argument", "symbols": ["macro_identifier", "_", {"literal":"="}, "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "macro_list", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": 
        function (d) { return [d[0], d[6]]; }
        },
    {"name": "macro_identifier", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.Identifier, d[0]]; }
        },
    {"name": "macro_identifier", "symbols": [(lexer.has("dqstring") ? {type: "dqstring"} : dqstring)], "postprocess": 
        function (d) { return [n.ConstString, d[0]]; }
        },
    {"name": "macro_identifier", "symbols": [(lexer.has("sqstring") ? {type: "sqstring"} : sqstring)], "postprocess": 
        function (d) { return [n.ConstString, d[0]]; }
        },
    {"name": "macro_value", "symbols": ["macro_identifier"], "postprocess": id},
    {"name": "macro_value$ebnf$1$subexpression$1", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"|"}, "_"]},
    {"name": "macro_value$ebnf$1", "symbols": ["macro_value$ebnf$1$subexpression$1"]},
    {"name": "macro_value$ebnf$1$subexpression$2", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"|"}, "_"]},
    {"name": "macro_value$ebnf$1", "symbols": ["macro_value$ebnf$1", "macro_value$ebnf$1$subexpression$2"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "macro_value", "symbols": ["macro_value$ebnf$1", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
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
        },
    {"name": "macro_value$ebnf$2$subexpression$1", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"::"}, "_"]},
    {"name": "macro_value$ebnf$2", "symbols": ["macro_value$ebnf$2$subexpression$1"]},
    {"name": "macro_value$ebnf$2$subexpression$2", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"::"}, "_"]},
    {"name": "macro_value$ebnf$2", "symbols": ["macro_value$ebnf$2", "macro_value$ebnf$2$subexpression$2"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "macro_value", "symbols": ["macro_value$ebnf$2", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
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
        },
    {"name": "macro_value$ebnf$3$subexpression$1", "symbols": [{"literal":"-"}, "_"]},
    {"name": "macro_value$ebnf$3", "symbols": ["macro_value$ebnf$3$subexpression$1"], "postprocess": id},
    {"name": "macro_value$ebnf$3", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "macro_value", "symbols": ["macro_value$ebnf$3", "const_number"], "postprocess": 
        function (d) {
            let value = d[1];
            if (d[0])
            {
                value[1].value = d[0][0].value + d[1][1].value;
                value[1].offset = d[0][0].offset;
            }
            return value;
        }
        },
    {"name": "expression", "symbols": ["expr_ternary"], "postprocess": id},
    {"name": "expr_ternary", "symbols": ["expr_binary_logic", "_", (lexer.has("ternary") ? {type: "ternary"} : ternary), "_", "expr_ternary", "_", (lexer.has("colon") ? {type: "colon"} : colon), "_", "expr_ternary"], "postprocess": 
        function (d) { return [n.TernaryOperation, d[0], d[4], d[8]]; }
        },
    {"name": "expr_ternary", "symbols": ["expr_binary_logic"], "postprocess": id},
    {"name": "expr_binary_logic", "symbols": ["expr_binary_logic", "_", (lexer.has("op_binary_logic") ? {type: "op_binary_logic"} : op_binary_logic), "_", "expr_binary_bitwise"], "postprocess": 
        function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
        },
    {"name": "expr_binary_logic", "symbols": ["expr_binary_bitwise"], "postprocess": id},
    {"name": "expr_binary_bitwise", "symbols": ["expr_binary_bitwise", "_", (lexer.has("op_binary_bitwise") ? {type: "op_binary_bitwise"} : op_binary_bitwise), "_", "expr_binary_compare"], "postprocess": 
        function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
        },
    {"name": "expr_binary_bitwise", "symbols": ["expr_binary_compare"], "postprocess": id},
    {"name": "expr_binary_compare", "symbols": ["expr_binary_compare", "_", (lexer.has("op_binary_compare") ? {type: "op_binary_compare"} : op_binary_compare), "_", "expr_binary_sum"], "postprocess": 
        function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
        },
    {"name": "expr_binary_compare", "symbols": ["expr_binary_sum"], "postprocess": id},
    {"name": "expr_binary_sum", "symbols": ["expr_binary_sum", "_", (lexer.has("op_binary_sum") ? {type: "op_binary_sum"} : op_binary_sum), "_", "expr_binary_product"], "postprocess": 
        function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
        },
    {"name": "expr_binary_sum", "symbols": ["expr_binary_product"], "postprocess": id},
    {"name": "expr_binary_product", "symbols": ["expr_binary_product", "_", (lexer.has("op_binary_product") ? {type: "op_binary_product"} : op_binary_product), "_", "expr_unary"], "postprocess": 
        function (d) { return [n.BinaryOperation, d[2], d[0], d[4]]; }
        },
    {"name": "expr_binary_product", "symbols": ["expr_unary"], "postprocess": id},
    {"name": "expr_unary", "symbols": ["unary_operator", "_", "expr_unary"], "postprocess": 
        function (d) { return [n.UnaryOperation, d[0], d[2]]; }
        },
    {"name": "expr_unary", "symbols": ["expr_postfix"], "postprocess": id},
    {"name": "expr_postfix", "symbols": ["expr_postfix", "_", (lexer.has("postfix_operator") ? {type: "postfix_operator"} : postfix_operator)], "postprocess": 
        function (d) { return [n.PostfixOperation, d[2], d[0]]; }
        },
    {"name": "expr_postfix", "symbols": ["expr_leaf"], "postprocess": id},
    {"name": "expr_leaf", "symbols": ["lvalue"], "postprocess": id},
    {"name": "expr_leaf", "symbols": ["constant"], "postprocess": id},
    {"name": "lvalue", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function(d, l) { return [n.Identifier, d[0]] }
        },
    {"name": "lvalue", "symbols": ["lvalue", "_", {"literal":"."}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.MemberAccess, d[0], d[4]]; }
        },
    {"name": "lvalue", "symbols": [{"literal":"("}, "_", "expression", "_", {"literal":")"}], "postprocess": 
        function (d) { return d[2]; }
        },
    {"name": "lvalue", "symbols": ["lvalue", "_", {"literal":"("}, "_", "argumentlist", "_", {"literal":")"}], "postprocess": 
        function (d) { return [n.FunctionCall, d[0], d[4]]; }
        },
    {"name": "lvalue", "symbols": ["lvalue", "_", {"literal":"["}, "_", "expression", "_", {"literal":"]"}], "postprocess": 
        function (d) { return [n.IndexOperator, d[0], d[4]]; }
        },
    {"name": "lvalue", "symbols": ["template_typename", "_", {"literal":"("}, "_", "argumentlist", "_", {"literal":")"}], "postprocess": 
        function (d) { return [n.ConstructorCall, d[0], d[4]]; }
        },
    {"name": "lvalue", "symbols": [(lexer.has("cast_token") ? {type: "cast_token"} : cast_token), "_", {"literal":"<"}, "_", "typename", "_", {"literal":">"}, "_", (lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "expression", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess": 
        function (d) { return [n.CastOperation, d[4], d[10]]; }
        },
    {"name": "lvalue", "symbols": ["namespace_access"], "postprocess": id},
    {"name": "namespace_access", "symbols": ["namespace_access", "_", {"literal":"::"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.NamespaceAccess, d[0], d[4]]; }
        },
    {"name": "namespace_access", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"::"}, "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
        function (d) { return [n.NamespaceAccess, d[0], d[4]]; }
        },
    {"name": "argumentlist", "symbols": [], "postprocess": 
        function(d) { return []; }
        },
    {"name": "argumentlist", "symbols": ["argument"], "postprocess": 
        function(d) { return [d[0]]; }
        },
    {"name": "argumentlist", "symbols": ["argument", "_", {"literal":","}, "_", "argumentlist"], "postprocess": 
        function(d) { return [d[0]].concat(d[4]); }
        },
    {"name": "argument", "symbols": ["expression"], "postprocess": id},
    {"name": "argument", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"="}, "_", "expression"], "postprocess": 
        function (d) { return [n.NamedArgument, d[0], d[4]]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("number") ? {type: "number"} : number)], "postprocess": 
        function(d) { return [n.ConstInteger, d[0] ]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("hex_number") ? {type: "hex_number"} : hex_number)], "postprocess": 
        function(d) { return [n.ConstHexInteger, d[0] ]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("number") ? {type: "number"} : number), {"literal":"."}, (lexer.has("number") ? {type: "number"} : number), {"literal":"f"}], "postprocess": 
        function(d) { return [n.ConstFloat, d[0].value+"."+d[2].value+"f"]; }
        },
    {"name": "const_number", "symbols": [{"literal":"."}, (lexer.has("number") ? {type: "number"} : number), {"literal":"f"}], "postprocess": 
        function(d) { return [n.ConstFloat, "0."+d[1].value+"f"]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("number") ? {type: "number"} : number), {"literal":"."}, {"literal":"f"}], "postprocess": 
        function(d) { return [n.ConstFloat, d[0].value+".f"]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("number") ? {type: "number"} : number), {"literal":"."}, (lexer.has("number") ? {type: "number"} : number)], "postprocess": 
        function(d) { return [n.ConstDouble, d[0].value+"."+d[2].value]; }
        },
    {"name": "const_number", "symbols": [{"literal":"."}, (lexer.has("number") ? {type: "number"} : number)], "postprocess": 
        function(d) { return [n.ConstDouble, "0."+d[1].value]; }
        },
    {"name": "const_number", "symbols": [(lexer.has("number") ? {type: "number"} : number), {"literal":"."}], "postprocess": 
        function(d) { return [n.ConstDouble, d[0].value+".0"]; }
        },
    {"name": "constant", "symbols": [(lexer.has("dqstring") ? {type: "dqstring"} : dqstring)], "postprocess": 
        function(d) { return [n.ConstString, d[0]]; }
        },
    {"name": "constant", "symbols": [(lexer.has("sqstring") ? {type: "sqstring"} : sqstring)], "postprocess": 
        function(d) { return [n.ConstString, d[0]]; }
        },
    {"name": "constant", "symbols": [{"literal":"n"}, (lexer.has("dqstring") ? {type: "dqstring"} : dqstring)], "postprocess": 
        function(d) { return [n.ConstName, d[1]]; }
        },
    {"name": "constant", "symbols": ["const_number"], "postprocess": id},
    {"name": "unary_operator", "symbols": [(lexer.has("op_binary_sum") ? {type: "op_binary_sum"} : op_binary_sum)]},
    {"name": "unary_operator", "symbols": [(lexer.has("op_unary") ? {type: "op_unary"} : op_unary)]},
    {"name": "unary_operator", "symbols": [(lexer.has("postfix_operator") ? {type: "postfix_operator"} : postfix_operator)], "postprocess": id},
    {"name": "typename$ebnf$1", "symbols": ["const_qualifier"], "postprocess": id},
    {"name": "typename$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "typename$ebnf$2", "symbols": ["ref_qualifiers"], "postprocess": id},
    {"name": "typename$ebnf$2", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "typename", "symbols": ["typename$ebnf$1", "unqualified_typename", "typename$ebnf$2"], "postprocess": 
        function (d) { return {
            ...d[1],
            const_qualifier: d[0],
            ref_qualifier: d[2],
        }}
        },
    {"name": "unqualified_typename", "symbols": ["typename_identifier"], "postprocess": 
        function (d) { return {
            name: d[0].value,
            token: d[0],
        }}
        },
    {"name": "unqualified_typename", "symbols": ["template_typename"], "postprocess": id},
    {"name": "template_typename", "symbols": ["typename_identifier", "_", {"literal":"<"}, "_", "template_subtypes", "_", {"literal":">"}], "postprocess": 
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
        }},
    {"name": "template_typename", "symbols": ["typename_identifier", "_", {"literal":"<"}, "_", "template_subtypes_unterminated", "_", {"literal":">>"}], "postprocess": 
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
        }},
    {"name": "typename_unterminated$ebnf$1", "symbols": ["const_qualifier"], "postprocess": id},
    {"name": "typename_unterminated$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "typename_unterminated", "symbols": ["typename_unterminated$ebnf$1", "typename_identifier", "_", {"literal":"<"}, "_", "template_subtypes", "_"], "postprocess": 
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
        }},
    {"name": "template_subtypes$ebnf$1", "symbols": []},
    {"name": "template_subtypes$ebnf$1$subexpression$1", "symbols": ["_", {"literal":","}, "_", "typename"]},
    {"name": "template_subtypes$ebnf$1", "symbols": ["template_subtypes$ebnf$1", "template_subtypes$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "template_subtypes", "symbols": ["typename", "template_subtypes$ebnf$1"], "postprocess": 
        function (d) {
            let subtypes = [d[0]];
            if (d[1])
            {
                for (let part of d[1])
                    subtypes.push(part[3]);
            }
            return subtypes;
        }
        },
    {"name": "template_subtypes_unterminated$ebnf$1", "symbols": []},
    {"name": "template_subtypes_unterminated$ebnf$1$subexpression$1", "symbols": ["typename", "_", {"literal":","}, "_"]},
    {"name": "template_subtypes_unterminated$ebnf$1", "symbols": ["template_subtypes_unterminated$ebnf$1", "template_subtypes_unterminated$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "template_subtypes_unterminated", "symbols": ["template_subtypes_unterminated$ebnf$1", "typename_unterminated"], "postprocess": 
        function (d) {
            let subtypes = [d[1]];
            if (d[0])
            {
                for (let part of d[0])
                    subtypes.push(part[0]);
            }
            return subtypes;
        }
        },
    {"name": "typename_identifier$ebnf$1", "symbols": []},
    {"name": "typename_identifier$ebnf$1$subexpression$1", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", (lexer.has("ns") ? {type: "ns"} : ns), "_"]},
    {"name": "typename_identifier$ebnf$1", "symbols": ["typename_identifier$ebnf$1", "typename_identifier$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "typename_identifier", "symbols": ["typename_identifier$ebnf$1", (lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": 
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
        },
    {"name": "const_qualifier", "symbols": [(lexer.has("const_token") ? {type: "const_token"} : const_token), "_"], "postprocess": 
        function (d) { return d[0].value; }
        },
    {"name": "ref_qualifiers$ebnf$1$subexpression$1", "symbols": [{"literal":"in"}]},
    {"name": "ref_qualifiers$ebnf$1$subexpression$1", "symbols": [{"literal":"out"}]},
    {"name": "ref_qualifiers$ebnf$1$subexpression$1", "symbols": [{"literal":"inout"}]},
    {"name": "ref_qualifiers$ebnf$1", "symbols": ["ref_qualifiers$ebnf$1$subexpression$1"], "postprocess": id},
    {"name": "ref_qualifiers$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "ref_qualifiers", "symbols": ["_", {"literal":"&"}, "ref_qualifiers$ebnf$1"], "postprocess": 
        function (d) { return d[2] ? d[1].value+d[2].value : d[1].value; }
        },
    {"name": "func_qualifiers", "symbols": [], "postprocess": 
        function(d) { return []; }
        },
    {"name": "func_qualifiers$ebnf$1", "symbols": []},
    {"name": "func_qualifiers$ebnf$1$subexpression$1", "symbols": ["func_qualifier", "__"]},
    {"name": "func_qualifiers$ebnf$1", "symbols": ["func_qualifiers$ebnf$1", "func_qualifiers$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "func_qualifiers", "symbols": ["_", "func_qualifiers$ebnf$1", "func_qualifier"], "postprocess": 
        function(d) {
            let quals = [d[2]];
            if (d[1])
            {
                for (let part of d[1])
                    quals.push(part[1]);
            }
            return quals;
        }
        },
    {"name": "func_qualifier", "symbols": [{"literal":"const"}]},
    {"name": "func_qualifier", "symbols": [{"literal":"final"}]},
    {"name": "func_qualifier", "symbols": [{"literal":"override"}]},
    {"name": "func_qualifier", "symbols": [{"literal":"property"}], "postprocess": id},
    {"name": "access_specifier", "symbols": [{"literal":"private"}]},
    {"name": "access_specifier", "symbols": [{"literal":"protected"}]},
    {"name": "access_specifier", "symbols": [{"literal":"public"}], "postprocess": id},
    {"name": "_$ebnf$1", "symbols": []},
    {"name": "_$ebnf$1$subexpression$1", "symbols": [(lexer.has("WS") ? {type: "WS"} : WS)]},
    {"name": "_$ebnf$1$subexpression$1", "symbols": [(lexer.has("line_comment") ? {type: "line_comment"} : line_comment)]},
    {"name": "_$ebnf$1$subexpression$1", "symbols": [(lexer.has("block_comment") ? {type: "block_comment"} : block_comment)]},
    {"name": "_$ebnf$1$subexpression$1", "symbols": [(lexer.has("preprocessor_statement") ? {type: "preprocessor_statement"} : preprocessor_statement)]},
    {"name": "_$ebnf$1", "symbols": ["_$ebnf$1", "_$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "_", "symbols": ["_$ebnf$1"], "postprocess": 
        function (d) { return null; }
        },
    {"name": "__", "symbols": [(lexer.has("WS") ? {type: "WS"} : WS)], "postprocess": 
        function (d) { return null; }
        },
    {"name": "__", "symbols": ["_", (lexer.has("block_comment") ? {type: "block_comment"} : block_comment), "_"], "postprocess": 
        function (d) { return null; }
        },
    {"name": "__", "symbols": ["_", (lexer.has("line_comment") ? {type: "line_comment"} : line_comment), "_"], "postprocess": 
        function (d) { return null; }
        },
    {"name": "__", "symbols": ["_", (lexer.has("prepocessor_statement") ? {type: "prepocessor_statement"} : prepocessor_statement), "_"], "postprocess": 
        function (d) { return null; }
        },
    {"name": "case_label", "symbols": [(lexer.has("lparen") ? {type: "lparen"} : lparen), "_", "case_label", "_", (lexer.has("rparen") ? {type: "rparen"} : rparen)], "postprocess":  
        function (d) { return d[2]; }
        },
    {"name": "case_label$ebnf$1$subexpression$1", "symbols": [{"literal":"-"}, "_"]},
    {"name": "case_label$ebnf$1", "symbols": ["case_label$ebnf$1$subexpression$1"], "postprocess": id},
    {"name": "case_label$ebnf$1", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "case_label", "symbols": ["case_label$ebnf$1", (lexer.has("number") ? {type: "number"} : number)], "postprocess": 
        function (d) {
            let value = d[1];
            if (d[0])
            {
                value.value = d[0][0].value + value.value;
                value.offset = d[0][0].offset;
            }
            return value;
        }
        },
    {"name": "case_label$ebnf$2", "symbols": []},
    {"name": "case_label$ebnf$2$subexpression$1", "symbols": ["_", (lexer.has("ns") ? {type: "ns"} : ns), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)]},
    {"name": "case_label$ebnf$2", "symbols": ["case_label$ebnf$2", "case_label$ebnf$2$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "case_label", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "case_label$ebnf$2"], "postprocess": 
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
        },
    {"name": "enum_statement", "symbols": ["_"], "postprocess": 
        function (d) { return []; }
        },
    {"name": "enum_statement$ebnf$1", "symbols": []},
    {"name": "enum_statement$ebnf$1$subexpression$1", "symbols": ["_", {"literal":","}, "_", "enum_decl"]},
    {"name": "enum_statement$ebnf$1", "symbols": ["enum_statement$ebnf$1", "enum_statement$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "enum_statement", "symbols": ["enum_decl", "enum_statement$ebnf$1"], "postprocess": 
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
        },
    {"name": "enum_decl", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier)], "postprocess": id},
    {"name": "enum_decl", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "_", {"literal":"="}, "_", "enum_value"], "postprocess": 
        function (d) { return [d[0], d[4]]; }
        },
    {"name": "enum_value$ebnf$1", "symbols": []},
    {"name": "enum_value$ebnf$1$subexpression$1", "symbols": ["_", (lexer.has("ns") ? {type: "ns"} : ns), "_", (lexer.has("identifier") ? {type: "identifier"} : identifier)]},
    {"name": "enum_value$ebnf$1", "symbols": ["enum_value$ebnf$1", "enum_value$ebnf$1$subexpression$1"], "postprocess": function arrpush(d) {return d[0].concat([d[1]]);}},
    {"name": "enum_value", "symbols": [(lexer.has("identifier") ? {type: "identifier"} : identifier), "enum_value$ebnf$1"], "postprocess": 
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
        },
    {"name": "enum_value$ebnf$2$subexpression$1", "symbols": [{"literal":"-"}, "_"]},
    {"name": "enum_value$ebnf$2", "symbols": ["enum_value$ebnf$2$subexpression$1"], "postprocess": id},
    {"name": "enum_value$ebnf$2", "symbols": [], "postprocess": function(d) {return null;}},
    {"name": "enum_value", "symbols": ["enum_value$ebnf$2", (lexer.has("number") ? {type: "number"} : number)], "postprocess": 
        function (d) {
            let value = d[1];
            if (d[0])
            {
                value.value = d[0][0].value + value.value;
                value.offset = d[0][0].offset;
            }
            return value;
        }
        },
    {"name": "main", "symbols": ["_", "enum_statement", "_"], "postprocess": 
        function (d) { return d[1]; }
        },
    {"name": "main", "symbols": ["_"], "postprocess": 
        function (d) { return null; }
        }
]
  , ParserStart: "main"
}
if (typeof module !== 'undefined'&& typeof module.exports !== 'undefined') {
   module.exports = grammar;
} else {
   window.grammar = grammar;
}
})();
