using System;
using System.IO;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Transport;

/// <summary>
/// One connected HII client: the handshake, then requests until it goes away.
/// </summary>
/// <remarks>
/// <para>
/// Every write goes through <see cref="WriteAsync"/>, which holds a lock and
/// emits the header and body as a single contiguous write. Nothing else may
/// touch the stream. Two frames interleaved on the wire cannot be resynchronised
/// by the reader: it would take the tail of one frame as the header of the next,
/// and the facade would report a malformed message and drop a connection that
/// was fine until we corrupted it.
/// </para>
/// <para>
/// Requests are dispatched onto the thread pool rather than handled inline, so
/// the read stays pending while the response is written. That is a requirement,
/// not an optimisation: the facade sends concurrent requests and expects
/// unsolicited events, and a bridge that only writes between reads would
/// deadlock against it the moment an operation takes real time.
/// </para>
/// </remarks>
public sealed class BridgeConnection : IDisposable
{
    private readonly NamedPipeServerStream _stream;
    private readonly BridgeIdentity _identity;
    private readonly IRequestHandler _handler;
    private readonly IBridgeLog _log;
    private static readonly TimeSpan DrainTimeout = TimeSpan.FromMilliseconds(500);

    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly OutboundEvents _outbound = new();
    private int _disposed;

    public BridgeConnection(
        NamedPipeServerStream stream,
        BridgeIdentity identity,
        IRequestHandler handler,
        IBridgeLog log)
    {
        _stream = stream;
        _identity = identity;
        _handler = handler;
        _log = log;
    }

    /// <summary>
    /// Queue an observation for this client.
    /// </summary>
    /// <remarks>
    /// Called from Rhino UI-thread event handlers. It queues and returns; the
    /// pump below does the writing. Writing here would put a pipe write, and
    /// therefore an arbitrarily slow client, on Rhino UI thread.
    /// </remarks>
    public void Publish(EventEnvelope observation) => _outbound.Publish(observation);

    /// <summary>Observations discarded because this client was not keeping up.</summary>
    public ulong DroppedEventCount => _outbound.DroppedTotal;

    /// <summary>Serve this client until it disconnects or the bridge stops.</summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        Task pump = Task.CompletedTask;
        try
        {
            if (!await PerformHandshakeAsync(cancellationToken).ConfigureAwait(false))
            {
                return;
            }

            // Only after the handshake: an event written before it would reach a
            // client that has not yet agreed on the protocol version.
            pump = Task.Run(() => PumpEventsAsync(cancellationToken), CancellationToken.None);

            while (!cancellationToken.IsCancellationRequested)
            {
                byte[] body;
                try
                {
                    body = await Framing.ReadFrameAsync(_stream, cancellationToken).ConfigureAwait(false);
                }
                catch (FrameException frame)
                {
                    await ReportFatalFrameFaultAsync(frame, cancellationToken).ConfigureAwait(false);
                    return;
                }

                string? envelope = PeekEnvelope(body);
                if (envelope == "handshake")
                {
                    // A second handshake means the client thinks it is starting
                    // a conversation we are already having. There is no safe way
                    // to reconcile that mid-stream.
                    await RefuseAsync(
                        ErrorEnvelope.Create(null, ErrorCode.MalformedMessage,
                            "a second handshake arrived on an established connection"),
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

                if (envelope != "request")
                {
                    await RefuseAsync(
                        ErrorEnvelope.Create(null, ErrorCode.MalformedMessage,
                            $"'{envelope ?? "(absent)"}' is not a message this bridge accepts"),
                        cancellationToken).ConfigureAwait(false);
                    return;
                }

                RequestEnvelope request;
                try
                {
                    request = Framing.Decode<RequestEnvelope>(body);
                }
                catch (FrameException frame)
                {
                    await ReportFatalFrameFaultAsync(frame, cancellationToken).ConfigureAwait(false);
                    return;
                }

                if (request.ProtocolVersion != WireProtocol.Version)
                {
                    // Answerable, unlike a framing fault: we know which request
                    // it was, so the caller gets a typed error and the
                    // connection survives.
                    await WriteAsync(
                        ErrorEnvelope.Create(
                            string.IsNullOrEmpty(request.RequestId) ? null : request.RequestId,
                            ErrorCode.ProtocolVersionMismatch,
                            $"request speaks protocol {request.ProtocolVersion}; this bridge speaks {WireProtocol.Version}"),
                        cancellationToken).ConfigureAwait(false);
                    continue;
                }

                // Deliberately not awaited: the loop goes straight back to
                // reading while this request is answered.
                _ = DispatchAsync(request, cancellationToken);
            }
        }
        catch (OperationCanceledException)
        {
            // The bridge is stopping. Not a fault.
        }
        catch (ObjectDisposedException)
        {
            // Stop() disposed the stream out from under the read. Also not a fault.
        }
        catch (IOException error)
        {
            _log.Warn("the HII Rhino connection ended unexpectedly", error);
        }
        finally
        {
            _outbound.Close();
            try
            {
                await pump.ConfigureAwait(false);
            }
            catch (Exception error) when (error is OperationCanceledException or IOException or ObjectDisposedException)
            {
            }
            Dispose();
        }
    }

    /// <summary>Writes queued observations, one at a time, off the UI thread.</summary>
    private async Task PumpEventsAsync(CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                EventEnvelope? observation = await _outbound.TakeAsync(cancellationToken).ConfigureAwait(false);
                if (observation is null)
                {
                    return;
                }
                await WriteAsync(observation, cancellationToken).ConfigureAwait(false);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or IOException or ObjectDisposedException)
        {
            // The client left, or the bridge is stopping. Observations are not
            // worth reporting a failure over.
        }
    }

    private async Task<bool> PerformHandshakeAsync(CancellationToken cancellationToken)
    {
        byte[] body;
        try
        {
            body = await Framing.ReadFrameAsync(_stream, cancellationToken).ConfigureAwait(false);
        }
        catch (FrameException frame)
        {
            await ReportFatalFrameFaultAsync(frame, cancellationToken).ConfigureAwait(false);
            return false;
        }

        if (PeekEnvelope(body) != "handshake")
        {
            await RefuseAsync(
                ErrorEnvelope.Create(null, ErrorCode.MalformedMessage,
                    "the first message on a connection must be a handshake"),
                cancellationToken).ConfigureAwait(false);
            return false;
        }

        HandshakeRequest request;
        try
        {
            request = Framing.Decode<HandshakeRequest>(body);
        }
        catch (FrameException frame)
        {
            await ReportFatalFrameFaultAsync(frame, cancellationToken).ConfigureAwait(false);
            return false;
        }

        if (request.ProtocolVersion != WireProtocol.Version)
        {
            // Refused outright. There is no compatibility window: the bridge and
            // the facade are installed separately, and a half-understood peer
            // that is allowed to make document changes is far more expensive to
            // diagnose than a refused connection.
            await RefuseAsync(
                ErrorEnvelope.Create(null, ErrorCode.ProtocolVersionMismatch,
                    $"client speaks protocol {request.ProtocolVersion}; this bridge speaks {WireProtocol.Version}"),
                cancellationToken).ConfigureAwait(false);
            _log.Warn(
                $"refused an HII client speaking protocol {request.ProtocolVersion}; this bridge speaks {WireProtocol.Version}");
            return false;
        }

        var response = new HandshakeResponse
        {
            Application = _identity.ToApplicationInstance(),
            Features = new System.Collections.Generic.List<string>(_identity.Features),
        };
        await WriteAsync(response, cancellationToken).ConfigureAwait(false);

        _log.Info($"HII client connected: {request.Client} {request.ClientVersion}");
        return true;
    }

    private async Task DispatchAsync(RequestEnvelope request, CancellationToken cancellationToken)
    {
        object message;
        try
        {
            RequestOutcome outcome = await _handler
                .HandleAsync(request, cancellationToken)
                .ConfigureAwait(false);
            message = outcome.Message;
        }
        catch (OperationCanceledException)
        {
            return;
        }
        catch (Exception error)
        {
            // A handler that throws is a bug on this side, and the caller still
            // needs an answer with its request id on it, or it will wait out its
            // whole timeout and then report the outcome as unknown.
            message = ErrorEnvelope.Create(
                request.RequestId,
                ErrorCode.NativeOperationFailed,
                $"{error.GetType().Name}: {error.Message}");
        }

        try
        {
            await WriteAsync(message, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error) when (error is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // The client left while we were answering. Nothing to report to.
        }
    }

    /// <summary>
    /// Tell the client why the stream is being dropped, then drop it.
    /// </summary>
    /// <remarks>
    /// A clean close needs no explanation. Anything else desynchronises the
    /// stream: there is no way to find the next frame boundary, so the error
    /// carries no request id and the facade correctly treats it as the end of
    /// the connection rather than the failure of one request.
    /// </remarks>
    private async Task ReportFatalFrameFaultAsync(FrameException frame, CancellationToken cancellationToken)
    {
        if (frame.Fault == FrameFault.Closed)
        {
            return;
        }

        _log.Warn($"dropping an HII connection: {frame.Message}");
        await RefuseAsync(
            ErrorEnvelope.Create(null, frame.Code, frame.Message),
            cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Read just the envelope discriminator.
    /// </summary>
    /// <remarks>
    /// serde tags these unions internally, so <c>envelope</c> sits alongside the
    /// variant's own fields rather than wrapping them. Reading the tag first and
    /// then deserializing the whole body into the matching type is the mirror of
    /// that, and it keeps an unknown envelope a clean typed refusal instead of a
    /// deserialization exception.
    /// </remarks>
    private static string? PeekEnvelope(byte[] body)
    {
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
            {
                return null;
            }
            return document.RootElement.TryGetProperty("envelope", out JsonElement envelope)
                && envelope.ValueKind == JsonValueKind.String
                    ? envelope.GetString()
                    : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Write a final explanation, then make sure the client actually gets it.
    /// </summary>
    /// <remarks>
    /// Every path that refuses a connection goes through here. Writing and
    /// returning is not enough on its own: the return unwinds into
    /// <see cref="Dispose"/>, and closing a pipe that the client has not read
    /// yet can lose the tail of the frame. Then the client reports a truncated
    /// message and the reason we carefully sent is exactly the thing that gets
    /// lost.
    /// </remarks>
    private async Task RefuseAsync(ErrorEnvelope error, CancellationToken cancellationToken)
    {
        try
        {
            await WriteAsync(error, cancellationToken).ConfigureAwait(false);
            await DrainAsync().ConfigureAwait(false);
        }
        catch (Exception failure)
            when (failure is IOException or ObjectDisposedException or OperationCanceledException)
        {
            // The client left before it could be told why. Nothing to do.
        }
    }

    /// <summary>
    /// Wait, briefly, for the client to read what we just wrote.
    /// </summary>
    /// <remarks>
    /// Used only on the paths that write a final explanation and then hang up.
    /// Bounded because <c>WaitForPipeDrain</c> has no timeout of its own and a
    /// client that has stopped reading would otherwise hold this open forever —
    /// and this can be reached from Rhino's UI thread during shutdown, where
    /// "forever" means Rhino never closes.
    /// </remarks>
    private async Task DrainAsync()
    {
        try
        {
            await Task.Run(() =>
                {
                    try
                    {
                        _stream.WaitForPipeDrain();
                    }
                    catch (Exception error)
                        when (error is IOException or InvalidOperationException or ObjectDisposedException)
                    {
                    }
                })
                .WaitAsync(DrainTimeout)
                .ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // The client is not reading. Its problem; we are leaving anyway.
        }
    }

    private async Task WriteAsync(object message, CancellationToken cancellationToken)
    {
        byte[] frame = message switch
        {
            HandshakeResponse handshake => Framing.Encode(handshake),
            ResponseEnvelope response => Framing.Encode(response),
            ErrorEnvelope error => Framing.Encode(error),
            EventEnvelope observation => Framing.Encode(observation),
            _ => throw new InvalidOperationException(
                $"{message.GetType().Name} is not a message the bridge may write"),
        };

        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await _stream.WriteAsync(frame, cancellationToken).ConfigureAwait(false);
            await _stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return;
        }

        // Deliberately no Disconnect(). DisconnectNamedPipe *discards* whatever
        // the client has not read yet, so calling it here would throw away the
        // typed error we write immediately before dropping a connection — the
        // client would see a truncated frame and report "malformed message"
        // instead of the reason it was refused. Closing the handle instead lets
        // the buffered bytes reach the client and then ends the connection.
        _stream.Dispose();
        _writeLock.Dispose();
    }
}
