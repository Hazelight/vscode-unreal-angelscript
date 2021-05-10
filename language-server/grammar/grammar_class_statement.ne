@include "angelscript.ne"

main -> _ class_statement _ {%
    function (d) { return d[1]; }
%}
main -> _ {%
    function (d) { return null; }
%}