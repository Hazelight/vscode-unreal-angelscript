@include "angelscript.ne"

main -> enum_statement _ {%
    function (d) { return d[0]; }
%}

main -> _ {%
    function (d) { return null; }
%}