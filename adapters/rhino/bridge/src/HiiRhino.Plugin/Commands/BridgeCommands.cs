using Rhino;
using Rhino.Commands;

namespace HiiRhino.Plugin.Commands;

/// <summary>
/// Starts the HII Rhino bridge.
/// </summary>
/// <remarks>
/// Because the plug-in loads on demand, running this command is also what loads
/// HII Rhino into Rhino in the first place. Explicit in both senses: nothing
/// opens a pipe until somebody asks for it.
/// </remarks>
public sealed class HiiCommand : Command
{
    public override string EnglishName => "Hii";

    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        HiiRhinoPlugIn? plugin = HiiRhinoPlugIn.Instance;
        if (plugin is null)
        {
            RhinoApp.WriteLine("HII Rhino: the plug-in is not loaded.");
            return Result.Failure;
        }

        // Starting twice is a no-op inside the plug-in, not a second server.
        return plugin.StartBridge() ? Result.Success : Result.Failure;
    }
}

/// <summary>
/// Stops the HII Rhino bridge: no more connections, existing ones dropped,
/// advertisement removed.
/// </summary>
/// <remarks>
/// The bridge can be started again afterwards. Stopping does not unload the
/// plug-in and does not require restarting Rhino.
/// </remarks>
public sealed class HiiStopCommand : Command
{
    public override string EnglishName => "HiiStop";

    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
        HiiRhinoPlugIn? plugin = HiiRhinoPlugIn.Instance;
        if (plugin is null)
        {
            RhinoApp.WriteLine("HII Rhino: the plug-in is not loaded.");
            return Result.Failure;
        }

        plugin.StopBridge();
        RhinoApp.WriteLine("HII Rhino: the bridge is stopped.");
        return Result.Success;
    }
}
