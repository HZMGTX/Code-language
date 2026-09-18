@echo off
rem The `lumen` command, for Windows.
rem
rem A checkout had no launcher at all. `lumen run x.lm` appears throughout the
rem documentation and existed nowhere in the repository, so the first thing
rem anyone tries after cloning did not work — and on Windows there is nothing
rem else to reach for, since the standalone binary needs bun to build.
rem
rem     .\lumen.cmd run app.lm
rem
rem It runs the built CLI out of the tree this file sits in, so it works from
rem any directory and does not care what the current one is.
setlocal
set "LUMEN_ROOT=%~dp0"
set "LUMEN_CLI=%LUMEN_ROOT%packages\cli\dist\index.js"

if not exist "%LUMEN_CLI%" (
  >&2 echo Lumen is not built yet. In this directory, run:
  >&2 echo(
  >&2 echo     npm install
  >&2 echo     npm run build
  exit /b 1
)

node "%LUMEN_CLI%" %*
exit /b %ERRORLEVEL%
