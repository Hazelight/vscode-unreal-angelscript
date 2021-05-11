@include "angelscript.ne"

main -> _ global_statement _ {%
    function (d) { return d[1]; }
%}
main -> comment_documentation global_declaration _ {%
    function (d) {
        if (d[0])
        {
            return {
                ...d[1],
                documentation: d[0],
            };
        }
        return d[1];
    }
%}
main -> _ {%
    function (d) { return null; }
%}