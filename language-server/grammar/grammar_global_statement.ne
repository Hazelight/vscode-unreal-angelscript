@include "angelscript.ne"

main -> _ global_statement _ {%
    function (d) { return d[1]; }
%}
main -> _ {%
    function (d) { return null; }
%}