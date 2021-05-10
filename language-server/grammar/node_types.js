(function () {

let i = 0;
let fast = false;

module.exports = {
    Identifier: fast ? i++ : "Identifier",
    BinaryOperation: fast ? i++ : "BinaryOperation",
    UnaryOperation: fast ? i++ : "UnaryOperation",
    PostfixOperation: fast ? i++ : "PostfixOperation",
    TernaryOperation: fast ? i++ : "TernaryOperation",
    CastOperation: fast ? i++ : "CastOperation",
    Assignment: fast ? i++ : "Assignment",
    CompoundAssignment: fast ? i++ : "CompoundAssignment",
    MemberAccess: fast ? i++ : "MemberAccess",
    NamespaceAccess: fast ? i++ : "NamespaceAccess",
    FunctionCall: fast ? i++ : "FunctionCall",
    ConstructorCall: fast ? i++ : "ConstructorCall",
    NamedArgument: fast ? i++ : "NamedArgument",
    IndexOperator: fast ? i++ : "IndexOperator",
    CommaExpression: fast ? i++ : "CommaExpression",

    ConstInteger: fast ? i++ : "ConstInteger",
    ConstHexInteger: fast ? i++ : "ConstHexInteger",
    ConstFloat: fast ? i++ : "ConstFloat",
    ConstDouble: fast ? i++ : "ConstDouble",
    ConstString: fast ? i++ : "ConstString",
    ConstName: fast ? i++ : "ConstName",

    IfStatement: fast ? i++ : "IfStatement",
    ElseStatement: fast ? i++ : "ElseStatement",
    ReturnStatement: fast ? i++ : "ReturnStatement",
    ImportStatement: fast ? i++ : "ImportStatement",
    ImportFunctionStatement: fast ? i++ : "ImportFunctionStatement",
    DefaultStatement: fast ? i++ : "DefaultStatement",
    CaseStatement: fast ? i++ : "CaseStatement",

    StructDefinition: fast ? i++ : "StructDefinition",
    ClassDefinition: fast ? i++ : "ClassDefinition",
    EnumDefinition: fast ? i++ : "EnumDefinition",
    AssetDefinition: fast ? i++ : "AssetDefinition",

    VariableDecl: fast ? i++ : "VariableDecl",
    VariableDeclMulti: fast ? i++ : "VariableDeclMulti",
    FunctionDecl: fast ? i++ : "FunctionDecl",
    DelegateDecl: fast ? i++ : "DelegateDecl",
    EventDecl: fast ? i++ : "EventDecl",
    ConstructorDecl: fast ? i++ : "ConstructorDecl",
    DestructorDecl: fast ? i++ : "ConstructorDecl",

    ForLoop: fast ? i++ : "ForLoop",
    ForEachLoop: fast ? i++ : "ForEachLoop",
    WhileLoop: fast ? i++ : "WhileLoop",
}

})();