# HII Rhino Agent

`HIIAgent` is a thin Rhino command-line launcher for HII. HII remains the agent,
authority, receipt, and model boundary. The plug-in captures the active document
and selected object IDs, starts a workspace-bounded HII run, then returns control
to Rhino so the run can interact through RhinoCode.

The selected tool can be `Codex`, `Inspect`, or `Grasshopper`. Runs may create or
edit `.gh` and `.py` files within the active document directory. Termite is not
used.

Build on Windows:

```powershell
dotnet build .\HiiRhinoAgent.csproj -c Release
```

Load the resulting `HiiRhinoAgent.rhp` once through Rhino Plug-in Manager, then
type `HIIAgent` in Rhino's command line.

The same contract is available in a terminal:

```powershell
hii rhino agent --tool codex "create a Grasshopper definition for the selected geometry"
```
