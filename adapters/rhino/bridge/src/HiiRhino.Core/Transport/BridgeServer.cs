using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Transport;

/// <summary>
/// The named-pipe server: one pipe per Rhino process, started and stopped
/// explicitly.
/// </summary>
/// <remarks>
/// <para>
/// The pipe is created in byte mode with an explicit little-endian length
/// prefix supplying message boundaries. Message mode is not used: a reader that
/// does not drain a whole message in one call gets <c>ERROR_MORE_DATA</c>, which
/// reaches the facade as an opaque I/O error rather than anything diagnosable.
/// </para>
/// <para>
/// It is asynchronous, and that is load-bearing on both sides. A synchronous
/// pipe handle serialises every operation on it, so a pending read blocks a
/// write on the same handle — measured at 87 seconds on the facade side before
/// it was found and fixed there. The same trap exists here, because the bridge
/// writes responses and events while a read is outstanding.
/// </para>
/// </remarks>
[SupportedOSPlatform("windows")]
public sealed class BridgeServer : IDisposable
{
    /// <summary>
    /// How many instances of the pipe name may exist at once.
    /// </summary>
    /// <remarks>
    /// Greater than one so that a free instance is always listening while a
    /// connected one is being served. With a single instance there is a window
    /// in which the pipe name does not exist at all, and a client arriving in it
    /// gets <c>ERROR_FILE_NOT_FOUND</c>, which the facade reads as
    /// <c>bridge_unavailable</c> and answers by pruning the advertisement of a
    /// perfectly healthy bridge. With a listener always posted, the worst a
    /// client sees is <c>ERROR_PIPE_BUSY</c>, which it already retries.
    /// </remarks>
    public const int MaxServerInstances = 4;

    /// <summary>
    /// Kernel buffer sizes. Unrelated to the 8 MiB protocol message cap: this is
    /// how much the kernel will hold before a writer blocks on flow control, and
    /// leaving it at the default is how a write ends up waiting on a peer that
    /// has not got round to reading yet.
    /// </summary>
    public const int PipeBufferBytes = 64 * 1024;

    private static readonly TimeSpan StopJoinTimeout = TimeSpan.FromSeconds(2);

    private readonly object _gate = new();
    private readonly BridgeIdentity _identity;
    private readonly IRequestHandler _handler;
    private readonly IBridgeLog _log;
    private readonly string _advertisementDirectory;
    private readonly ConcurrentDictionary<BridgeConnection, byte> _connections = new();

    private CancellationTokenSource? _stopping;
    private Task? _acceptLoop;
    private NamedPipeServerStream? _listener;
    private string? _advertisementPath;

    public BridgeServer(
        BridgeIdentity identity,
        IRequestHandler handler,
        IBridgeLog? log = null,
        string? advertisementDirectory = null)
    {
        _identity = identity;
        _handler = handler;
        _log = log ?? NullBridgeLog.Instance;
        _advertisementDirectory = advertisementDirectory ?? RuntimePaths.AdvertisementDirectory();
        PipeName = PipeNames.PipeName(identity.SessionId, identity.ProcessId);
    }

    public string PipeName { get; }

    public bool IsRunning
    {
        get
        {
            lock (_gate)
            {
                return _acceptLoop is not null;
            }
        }
    }

    /// <summary>The advertisement currently published, or null when stopped.</summary>
    public string? AdvertisementPath
    {
        get
        {
            lock (_gate)
            {
                return _advertisementPath;
            }
        }
    }

    /// <summary>Connections being served right now.</summary>
    public int ConnectionCount => _connections.Count;

    /// <summary>
    /// Offer an observation to every connected client.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Called from Rhino UI-thread event handlers, so it queues per connection
    /// and returns immediately. It never blocks, never throws, and never waits
    /// on a client: an observation is not worth a frozen Rhino.
    /// </para>
    /// <para>
    /// Each connection gets its own envelope instance, because the pump stamps
    /// <c>dropped_before</c> onto it and one client falling behind must not
    /// change what another client is told.
    /// </para>
    /// </remarks>
    public void Publish(Func<EventEnvelope> observation)
    {
        if (_connections.IsEmpty)
        {
            // Nobody is listening. Do not even pay for building the envelope —
            // this runs on every object added to the document.
            return;
        }

        foreach (BridgeConnection connection in _connections.Keys)
        {
            try
            {
                connection.Publish(observation());
            }
            catch (Exception error)
            {
                // A handler on Rhino's UI thread must not be able to throw into
                // Rhino. There is nothing to recover here and nothing worth
                // failing an edit over.
                _log.Warn("an HII Rhino observation could not be queued", error);
            }
        }
    }

    /// <summary>
    /// Create the pipe, publish the advertisement, and start accepting.
    /// </summary>
    /// <remarks>
    /// Idempotent: starting an already-running bridge is a no-op rather than a
    /// second server. Two servers on one pipe name would both appear healthy and
    /// the facade would connect to whichever answered first.
    ///
    /// The order matters. The first listener is created before the advertisement
    /// is published, so a facade that reads the file the instant it appears finds
    /// a pipe that already exists.
    /// </remarks>
    public void Start()
    {
        lock (_gate)
        {
            if (_acceptLoop is not null)
            {
                _log.Info($"the HII Rhino bridge is already running on {PipeName}");
                return;
            }

            var stopping = new CancellationTokenSource();
            NamedPipeServerStream listener = CreateListener();

            try
            {
                _advertisementPath = AdvertisementFile.Publish(_advertisementDirectory, new Advertisement
                {
                    RhinoInstanceId = _identity.InstanceId,
                    ProcessId = _identity.ProcessId,
                    SessionId = _identity.SessionId,
                    PipeName = PipeName,
                    ApplicationVersion = _identity.ApplicationVersion,
                    AdapterVersion = _identity.AdapterVersion,
                    StartedAtUnixMs = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                });
            }
            catch
            {
                listener.Dispose();
                stopping.Dispose();
                throw;
            }

            _stopping = stopping;
            _listener = listener;
            _acceptLoop = Task.Run(() => AcceptLoopAsync(listener, stopping.Token));

            _log.Info($"the HII Rhino bridge is listening on {PipeName}");
        }
    }

    /// <summary>
    /// Stop accepting, drop every connection, and retract the advertisement.
    /// </summary>
    /// <remarks>
    /// Bounded on purpose. Cancelling a token does not reliably abort a pending
    /// <c>ConnectNamedPipe</c>, so the listening stream is disposed as well; and
    /// the join has a timeout, because this can be called from Rhino's UI thread
    /// while it closes, and a bridge that will not let go is a Rhino that will
    /// not shut down. The advertisement is retracted whether or not the join
    /// completed: a stale file the facade prunes is a far smaller problem than a
    /// hung host.
    /// </remarks>
    public void Stop()
    {
        CancellationTokenSource? stopping;
        Task? acceptLoop;
        NamedPipeServerStream? listener;
        string? advertisementPath;

        lock (_gate)
        {
            if (_acceptLoop is null)
            {
                _log.Info("the HII Rhino bridge is not running");
                return;
            }

            stopping = _stopping;
            acceptLoop = _acceptLoop;
            listener = _listener;
            advertisementPath = _advertisementPath;

            _stopping = null;
            _acceptLoop = null;
            _listener = null;
            _advertisementPath = null;
        }

        try
        {
            stopping?.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }

        // Breaks a listener parked in WaitForConnectionAsync.
        listener?.Dispose();

        foreach (BridgeConnection connection in _connections.Keys)
        {
            connection.Dispose();
        }
        _connections.Clear();

        try
        {
            if (acceptLoop is not null && !acceptLoop.Wait(StopJoinTimeout))
            {
                _log.Warn(
                    $"the HII Rhino accept loop did not finish within {StopJoinTimeout.TotalSeconds:0} seconds; " +
                    "carrying on with shutdown");
            }
        }
        catch (AggregateException error)
        {
            _log.Warn("the HII Rhino accept loop ended with an error", error.GetBaseException());
        }

        AdvertisementFile.Retract(advertisementPath);
        stopping?.Dispose();

        _log.Info("the HII Rhino bridge has stopped");
    }

    private NamedPipeServerStream CreateListener() => NamedPipeServerStreamAcl.Create(
        PipeName,
        PipeDirection.InOut,
        MaxServerInstances,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous,
        PipeBufferBytes,
        PipeBufferBytes,
        PipeSecurityFactory.CurrentUserOnly());

    private async Task AcceptLoopAsync(NamedPipeServerStream first, CancellationToken cancellationToken)
    {
        NamedPipeServerStream? pending = first;

        while (!cancellationToken.IsCancellationRequested && pending is not null)
        {
            try
            {
                await pending.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException)
            {
                pending.Dispose();
                return;
            }
            catch (IOException error)
            {
                // A client that connected and vanished before we noticed. The
                // instance is spent either way; post a fresh one.
                _log.Warn("an HII connection attempt failed before it was established", error);
                pending.Dispose();
                pending = TryCreateListener(cancellationToken);
                continue;
            }

            NamedPipeServerStream connected = pending;

            // The next listener goes up before this connection is served, so the
            // pipe name never briefly ceases to exist.
            pending = TryCreateListener(cancellationToken);
            lock (_gate)
            {
                _listener = pending;
            }

            var connection = new BridgeConnection(connected, _identity, _handler, _log);
            _connections.TryAdd(connection, 0);
            _ = connection
                .RunAsync(cancellationToken)
                .ContinueWith(
                    finished => _connections.TryRemove(connection, out _),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
        }
    }

    private NamedPipeServerStream? TryCreateListener(CancellationToken cancellationToken)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            return null;
        }

        try
        {
            return CreateListener();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Every instance is in use, or the name went away. Either way the
            // bridge stops accepting; it does not spin retrying.
            _log.Warn("the HII Rhino bridge could not post another pipe listener", error);
            return null;
        }
    }

    public void Dispose() => Stop();
}
