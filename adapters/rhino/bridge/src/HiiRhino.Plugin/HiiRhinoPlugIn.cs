using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Transport;
using Rhino;
using Rhino.PlugIns;

namespace HiiRhino.Plugin;

/// <summary>
/// HII Rhino: the native execution end of the HII Rhino capability.
/// </summary>
/// <remarks>
/// <para>
/// This plug-in is deliberately small and deliberately stupid. HII owns
/// intelligence, planning and orchestration; nothing here decides anything. No
/// agent, no prompts, no model, no semantic commands — this is a typed
/// execution surface for RhinoCommon and nothing more.
/// </para>
/// <para>
/// As of checkpoint E the plug-in loads, identifies the running Rhino, starts
/// and stops a named-pipe bridge, runs work on Rhino's UI thread through one
/// dispatcher, answers read-only questions about open documents, and publishes
/// what it observes. It still changes nothing: every operation is a read.
/// </para>
/// </remarks>
public sealed class HiiRhinoPlugIn : PlugIn
{
    private readonly object _gate = new();
    private BridgeServer? _bridge;
    private RhinoEventBridge? _events;

    public HiiRhinoPlugIn()
    {
        Instance = this;
    }

    public static HiiRhinoPlugIn? Instance { get; private set; }

    /// <summary>
    /// Identity of this Rhino, captured once while the plug-in loads.
    /// </summary>
    /// <remarks>
    /// Captured here, on Rhino's own thread, and then immutable. The pipe
    /// threads answer handshakes from this snapshot rather than calling into
    /// RhinoCommon, so a handshake never has to wait on the UI thread and can
    /// still be answered while Rhino is busy.
    /// </remarks>
    public BridgeIdentity? Identity { get; private set; }

    public bool IsBridgeRunning
    {
        get
        {
            lock (_gate)
            {
                return _bridge?.IsRunning == true;
            }
        }
    }

    protected override LoadReturnCode OnLoad(ref string errorMessage)
    {
        try
        {
            Identity = CaptureIdentity();
        }
        catch (Exception error)
        {
            errorMessage = $"HII Rhino could not identify this Rhino instance: {error.Message}";
            return LoadReturnCode.ErrorShowDialog;
        }

        // The bridge is not started here. Starting it is an explicit act:
        // StartHiiRhinoBridge. A plug-in that opens a pipe merely because it was
        // loaded is a plug-in the user did not agree to run.
        return LoadReturnCode.Success;
    }

    protected override void OnShutdown()
    {
        // Rhino is closing. Same cleanup as StopHiiRhinoBridge, and bounded for
        // the same reason: whatever state the bridge is in, it does not get to
        // hold Rhino open.
        StopBridge();
        base.OnShutdown();
    }

    /// <summary>
    /// Start the bridge, or report that it is already running.
    /// </summary>
    /// <returns>True when a bridge is running once this returns.</returns>
    public bool StartBridge()
    {
        lock (_gate)
        {
            if (Identity is null)
            {
                RhinoApp.WriteLine("HII Rhino: this Rhino instance was never identified; the bridge cannot start.");
                return false;
            }

            if (_bridge is not null && _bridge.IsRunning)
            {
                RhinoApp.WriteLine($"HII Rhino: the bridge is already running on {_bridge.PipeName}.");
                return true;
            }

            var log = new RhinoBridgeLog();

            // Requests reach Rhino's UI thread through the one dispatcher.
            // Alongside the read operations are the dispatcher diagnostics,
            // which touch no document — they exist to prove dispatch works and
            // must never be offered to a model as tools.
            INativeDispatcher dispatcher = RhinoNativeDispatcher.Create();
            var operations = new List<INativeOperation>();
            operations.AddRange(DiagnosticOperations.All(() => !RhinoApp.InvokeRequired));
            operations.AddRange(Operations.ReadOperations.All(Identity));
            operations.AddRange(Operations.MutationOperations.All(Identity));

            var handler = new DispatchingRequestHandler(operations, dispatcher, log);
            var bridge = new BridgeServer(Identity, handler, log);
            try
            {
                bridge.Start();
            }
            catch (Exception error)
            {
                bridge.Dispose();
                RhinoApp.WriteLine($"HII Rhino: the bridge could not start: {error.Message}");
                return false;
            }

            // Subscribed after the server is listening, so an observation can
            // never be raised against a server that is not there yet. This runs
            // on the UI thread, which is where Rhino requires handlers to be
            // attached.
            var events = new RhinoEventBridge(bridge, Identity, log);
            events.Subscribe();

            _events = events;
            _bridge = bridge;
            RhinoApp.WriteLine(
                $"HII Rhino: bridge listening on {bridge.PipeName} (instance {Identity.InstanceId:D}).");
            RhinoApp.WriteLine($"HII Rhino: advertised at {bridge.AdvertisementPath}");
            RhinoApp.WriteLine(
                $"HII Rhino: operations available: {string.Join(", ", handler.OperationNames)}");
            return true;
        }
    }

    /// <summary>Stop the bridge if it is running. Safe to call at any time.</summary>
    public void StopBridge()
    {
        BridgeServer? bridge;
        RhinoEventBridge? events;
        lock (_gate)
        {
            bridge = _bridge;
            events = _events;
            _bridge = null;
            _events = null;
        }

        // Handlers come off first. They are static events on RhinoDoc, so one
        // left attached outlives the bridge, keeps it alive, and goes on
        // publishing into a stopped server for as long as Rhino runs.
        events?.Dispose();

        if (bridge is null)
        {
            return;
        }

        bridge.Dispose();
    }

    private static BridgeIdentity CaptureIdentity()
    {
        using Process process = Process.GetCurrentProcess();

        return new BridgeIdentity(
            // Fresh per plug-in lifetime. Windows reuses process ids, so a
            // facade holding a reference into a Rhino that has since restarted
            // must be told the instance is gone rather than quietly retargeted
            // at a different document.
            instanceId: Guid.NewGuid(),
            processId: (uint)process.Id,
            sessionId: (uint)process.SessionId,
            applicationVersion: RhinoApp.Version.ToString(),
            adapterVersion: AdapterVersion(),
            // Only what is actually implemented. A flag here is what the
            // facade turns into a tool the model can call, so advertising one
            // without the operation behind it puts an unusable tool in front of
            // a model.
            features: Features());
    }

    /// <summary>What this build can actually do.</summary>
    /// <remarks>
    /// Assembled from the operation sets that are registered, so a flag cannot
    /// outlive the operations behind it. The facade turns these into the tools a
    /// model may call, and a tool that cannot execute must never be offered.
    /// </remarks>
    private static IReadOnlyList<string> Features()
    {
        var features = new List<string>();
        features.AddRange(Operations.ReadOperations.Features);
        features.AddRange(Operations.MutationOperations.Features);
        return features;
    }

    private static string AdapterVersion()
    {
        Assembly assembly = typeof(HiiRhinoPlugIn).Assembly;
        return assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? assembly.GetName().Version?.ToString()
            ?? "0.0.0";
    }
}

/// <summary>Routes bridge logging to Rhino's command line.</summary>
internal sealed class RhinoBridgeLog : IBridgeLog
{
    public void Info(string message) => RhinoApp.WriteLine($"HII Rhino: {message}");

    public void Warn(string message, Exception? error = null) => RhinoApp.WriteLine(
        error is null
            ? $"HII Rhino: {message}"
            : $"HII Rhino: {message} ({error.GetType().Name}: {error.Message})");
}
