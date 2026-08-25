using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Hosting;

/// <summary>
/// Everything the bridge knows about the process it is running in, captured
/// once and immutable thereafter.
/// </summary>
/// <remarks>
/// <para>
/// Immutability is the point. The values are read from Rhino on the UI thread
/// while the plug-in loads and then handed to the transport, so the pipe
/// threads never call into RhinoCommon to answer a handshake. That is the
/// entire native-dispatch surface checkpoint C needs.
/// </para>
/// <para>
/// <see cref="InstanceId"/> is a fresh GUID per plug-in lifetime. It is
/// deliberately not derived from the process id, the executable path, the
/// document, or the window title: Windows reuses process ids, and a facade
/// holding references into a Rhino that has since restarted must be told the
/// instance is gone rather than silently retargeted at a different document.
/// </para>
/// </remarks>
public sealed class BridgeIdentity
{
    public BridgeIdentity(
        Guid instanceId,
        uint processId,
        uint sessionId,
        string applicationVersion,
        string adapterVersion,
        IReadOnlyList<string>? features = null)
    {
        InstanceId = instanceId;
        ProcessId = processId;
        SessionId = sessionId;
        ApplicationVersion = applicationVersion;
        AdapterVersion = adapterVersion;
        Features = features ?? Array.Empty<string>();
    }

    public Guid InstanceId { get; }
    public uint ProcessId { get; }

    /// <summary>The Windows logon session, which the pipe name is built from.</summary>
    public uint SessionId { get; }

    /// <summary>The host application version, for example Rhino 8.32.26160.13001.</summary>
    public string ApplicationVersion { get; }

    /// <summary>This bridge's own version, which moves independently of Rhino.</summary>
    public string AdapterVersion { get; }

    /// <summary>
    /// Coarse capability flags. Empty in checkpoint C, and that is not an
    /// oversight: no operation is implemented, and a feature flag is a promise
    /// the facade turns into a tool the model can call.
    /// </summary>
    public IReadOnlyList<string> Features { get; }

    public ApplicationInstance ToApplicationInstance() => new()
    {
        Application = "rhino",
        ApplicationVersion = ApplicationVersion,
        AdapterVersion = AdapterVersion,
        ProcessId = ProcessId,
        RhinoInstanceId = InstanceId,
    };
}

/// <summary>Where the bridge writes what it is doing.</summary>
/// <remarks>
/// An interface rather than a direct <c>RhinoApp.WriteLine</c> call, so that
/// everything in this assembly stays runnable outside Rhino.
/// </remarks>
public interface IBridgeLog
{
    void Info(string message);
    void Warn(string message, Exception? error = null);
}

/// <summary>Discards everything. The default for tests.</summary>
public sealed class NullBridgeLog : IBridgeLog
{
    public static readonly NullBridgeLog Instance = new();

    public void Info(string message)
    {
    }

    public void Warn(string message, Exception? error = null)
    {
    }
}

/// <summary>
/// What handling one request produced: exactly one of a response or a typed
/// error, never both and never neither.
/// </summary>
public readonly struct RequestOutcome
{
    private RequestOutcome(ResponseEnvelope? response, ErrorEnvelope? error)
    {
        Response = response;
        Error = error;
    }

    public ResponseEnvelope? Response { get; }
    public ErrorEnvelope? Error { get; }

    public static RequestOutcome Ok(ResponseEnvelope response) => new(response, null);

    public static RequestOutcome Failed(ErrorEnvelope error) => new(null, error);

    /// <summary>The message to put on the wire.</summary>
    public object Message => (object?)Response ?? Error!;
}

/// <summary>What the transport hands a decoded request to.</summary>
public interface IRequestHandler
{
    Task<RequestOutcome> HandleAsync(RequestEnvelope request, CancellationToken cancellationToken);
}

/// <summary>
/// The handler checkpoint C ships: it implements no operations.
/// </summary>
/// <remarks>
/// This is not a placeholder to be filled in with a stub tool. Refusing every
/// operation with a typed <see cref="ErrorCode.OperationNotSupported"/> is the
/// correct behaviour for a bridge that has no operations, and it exercises the
/// whole request path — correlation by request id, typed errors, a response
/// written while the next read is already pending — without putting a single
/// unimplemented tool in front of the model.
/// </remarks>
public sealed class NoOperationsHandler : IRequestHandler
{
    public Task<RequestOutcome> HandleAsync(RequestEnvelope request, CancellationToken cancellationToken)
    {
        return Task.FromResult(RequestOutcome.Failed(ErrorEnvelope.Create(
            request.RequestId,
            ErrorCode.OperationNotSupported,
            $"this HII Rhino bridge implements no operations yet; '{request.Operation}' is not available")));
    }
}
