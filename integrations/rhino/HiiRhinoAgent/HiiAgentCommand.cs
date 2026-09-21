using System.Diagnostics;
using System.Text;
using Rhino;
using Rhino.Commands;
using Rhino.Input.Custom;

namespace HiiRhinoAgent;

public sealed class HiiAgentCommand : Command
{
    public override string EnglishName => "HIIAgent";

    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        var toolInput = new GetOption();
        toolInput.SetCommandPrompt("Select HII agent tool");
        var codex = toolInput.AddOption("Codex");
        var inspect = toolInput.AddOption("Inspect");
        var grasshopper = toolInput.AddOption("Grasshopper");
        toolInput.AcceptNothing(true);
        var toolResult = toolInput.Get();
        if (toolResult == Rhino.Input.GetResult.Cancel) return Result.Cancel;

        var tool = toolInput.OptionIndex() switch
        {
            var index when index == inspect => "Inspect",
            var index when index == grasshopper => "Grasshopper",
            _ => "Codex"
        };

        var requestInput = new GetString();
        requestInput.SetCommandPrompt($"HII {tool} request");
        requestInput.AcceptNothing(false);
        var requestResult = requestInput.Get();
        if (requestResult != Rhino.Input.GetResult.String) return Result.Cancel;
        var request = requestInput.StringResult()?.Trim();
        if (string.IsNullOrWhiteSpace(request)) return Result.Nothing;

        var documentPath = doc.Path;
        var workspace = string.IsNullOrWhiteSpace(documentPath)
            ? Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)
            : Path.GetDirectoryName(documentPath)!;
        var selected = doc.Objects.GetSelectedObjects(false, false)
            .Select(item => item.Id.ToString())
            .ToArray();

        var context = new StringBuilder()
            .AppendLine("HII Rhino agent request")
            .AppendLine($"Selected tool: {tool}")
            .AppendLine($"Active Rhino document: {documentPath}")
            .AppendLine($"Active Rhino document runtime serial: {doc.RuntimeSerialNumber}")
            .AppendLine($"Selected Rhino object IDs: {(selected.Length == 0 ? "none" : string.Join(",", selected))}")
            .AppendLine("Use HII Rhino/RhinoCode for live document interaction. You may create or edit .gh and .py files inside the bounded workspace. Do not use Termite. Verify live mutations and write a receipt.")
            .AppendLine($"User request: {request}")
            .ToString();

        try
        {
            var start = BuildStartInfo(workspace, context, tool);
            var process = Process.Start(start);
            if (process is null)
            {
                RhinoApp.WriteLine("HIIAgent could not start HII.");
                return Result.Failure;
            }
            RhinoApp.WriteLine($"HIIAgent started {tool} run in PID {process.Id}. Rhino remains available for RhinoCode callbacks.");
            return Result.Success;
        }
        catch (Exception error)
        {
            RhinoApp.WriteLine($"HIIAgent failed: {error.Message}");
            return Result.Failure;
        }
    }

    private static ProcessStartInfo BuildStartInfo(string workspace, string context, string tool)
    {
        if (OperatingSystem.IsWindows())
        {
            var launcher = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
                "npm",
                "hii.ps1");
            var info = new ProcessStartInfo("powershell.exe")
            {
                UseShellExecute = true,
                WorkingDirectory = workspace,
                WindowStyle = ProcessWindowStyle.Normal
            };
            info.ArgumentList.Add("-NoExit");
            info.ArgumentList.Add("-NoProfile");
            info.ArgumentList.Add("-File");
            info.ArgumentList.Add(launcher);
            AddHiiArguments(info, workspace, context, tool);
            return info;
        }

        var shell = Environment.GetEnvironmentVariable("SHELL") ?? "/bin/zsh";
        var command = new StringBuilder("hii run --cwd ")
            .Append(ShellQuote(workspace))
            .Append(" --authority workspace --stream --context-source rhino-command-line ")
            .Append(ShellQuote(context));
        return new ProcessStartInfo("open")
        {
            UseShellExecute = false,
            ArgumentList = { "-a", "Terminal", shell, "-lc", command.ToString() }
        };
    }

    private static void AddHiiArguments(ProcessStartInfo info, string workspace, string context, string tool)
    {
        foreach (var argument in new[]
        {
            "run", "--cwd", workspace, "--authority", "workspace", "--stream",
            "--context-source", $"rhino-command-line:{tool.ToLowerInvariant()}", context
        }) info.ArgumentList.Add(argument);
    }

    private static string ShellQuote(string value) => "'" + value.Replace("'", "'\\''") + "'";
}
