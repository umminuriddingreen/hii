using Rhino.PlugIns;

namespace HiiRhinoAgent;

public sealed class HiiRhinoAgentPlugin : PlugIn
{
    public HiiRhinoAgentPlugin() => Instance = this;

    public static HiiRhinoAgentPlugin? Instance { get; private set; }
}
