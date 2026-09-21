import Rhino

name = "HIIAgent"
available = Rhino.Commands.Command.IsCommand(name)
Rhino.RhinoApp.WriteLine("HII_AGENT_COMMAND_AVAILABLE=" + str(available))
if not available:
    raise RuntimeError(name + " is not registered")
