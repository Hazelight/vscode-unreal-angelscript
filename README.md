Language Server and Debug Adapter for use with the UnrealEngine-Angelscript plugin from https://angelscript.hazelight.se

## Getting Started
After building or downloading the Unreal Editor version with Angelscript
enabled from the github page linked above, start the editor and use visual
studio code to open the 'Script' folder created in your project directory.
Your 'Script' folder must be set as the root/opened folder for the extension to
function.

## Features
### Editor Connection
The unreal-angelscript extension automatically makes a connection to the
running Unreal Editor instance for most of its functionality. If the editor
is not running, certain features will not be available.

### Code Completion
The extension will try to complete your angelscript code as you type it
using normal visual studio code language server features.

### Error Display
When saving a file the unreal editor automatically compiles and reloads it,
sending any errors to the visual code extension. Errors will be highlighted
in the code display and in the problems window.

### Debugging
You can start debugging from the Debug sidebar or by pressing F5. While
debug mode is active, breakpoints can be set in angelscript files and
the unreal editor will automatically break and stop execution when
they are reached.

Hitting 'Stop' on the debug toolbar will not close the unreal editor,
it merely stops the debug connection, causing breakpoints to be ignored.

When the debug connection is active, any exceptions that occur during
angelscript execution will automatically cause the editor and visual
studio code to pause execution and show the exception.

### Go to Symbol
The default visual studio code 'Go to Definition' (F12) is implemented for
angelscript symbols. A separate command is added to the right click menu
(default shortcut: Alt+G), named 'Go to Symbol'. This command functions
identically to 'Go to Definition' for angelscript symbols.

If you have the Unreal Editor open as well as Visual Studio proper showing
the C++ source code for unreal, the extension will try to use its
unreal editor connection to browse your Visual Studio to the right place,
similar to double clicking a C++ class or function in blueprints.

This uses the standard unreal source navigation system, which is only
implemented for classes and functions.

### Add Import To
The 'Add Import To' (default shortcut: Shift+Alt+I) command from the
right click menu will try to automatically add an import statement
to the top of the file to import the type that the command was run on.

## Known Issues
* There is a rare bug causing the language server to crash, breaking
  code completion until visual studio code is reloaded. If you have
  reproduction steps for this, please open an Issue on the github.
* While the extension is quite functional as a whole, I wrote it over a 
  short span of time with zero prior knowledge of typescript, visual studio code,
  or any of the Node.js ecosystem. A lot of the code is ugly and due for a refactor.
