# Lumen for Visual Studio Code

Diagnostics, hover, completion, signature help, go to definition, find
references, rename, and formatting — everything `lumen lsp` provides.

## Installing it

There is no marketplace listing: Lumen is not public, so neither is this.
Install it from the checkout instead.

```bash
# macOS, Linux
ln -s "$(pwd)/editors/vscode" ~/.vscode/extensions/lumen

# Windows (PowerShell, as administrator)
New-Item -ItemType SymbolicLink -Path "$HOME\.vscode\extensions\lumen" -Target "$PWD\editors\vscode"
```

Copying the directory works just as well and needs no privileges. Restart VS
Code, and open any `.lm` file.

## Finding the `lumen` command

The extension looks in three places, in order:

1. the `lumen.path` setting, if you have set it;
2. a `lumen` (or `lumen.cmd`) launcher in the workspace or any directory above
   it — so a checkout uses the build you are working on;
3. `lumen` on your PATH.

If none of those finds one, it says so rather than going quiet. Build the
checkout first with `npm install && npm run build`.

## What is in here

Four files and no dependencies, including no `vscode-languageclient`. The whole
client is the framing read backwards plus five providers that forward a request
and translate the answer; everything worth knowing lives in the server, where
`lumen check` can reach it too.

| | |
|---|---|
| `extension.js` | the client: starts `lumen lsp`, speaks LSP over stdio |
| `package.json` | what the extension contributes |
| `language-configuration.json` | comments, brackets, indentation |
| `lumen.tmLanguage.json` | syntax highlighting |

Syntax highlighting is the one thing the server does not provide: VS Code wants
a TextMate grammar, applied before anything has been parsed, so it is a separate
description of the same language. It is deliberately shallow for that reason —
it colours keywords, strings, numbers and comments, and leaves every question
that needs real parsing to the server, which can answer it properly.
