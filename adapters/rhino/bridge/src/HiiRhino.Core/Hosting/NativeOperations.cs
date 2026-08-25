using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Hosting;

/// <summary>
/// A failure an operation can describe precisely.
/// </summary>
/// <remarks>
/// An operation that simply throws gets <see cref="ErrorCode.NativeOperationFailed"/>,
/// which tells the harness only that something went wrong. Most of the
/// interesting failures are not like that: a document that has been closed, an
/// object that no longer exists, and an argument that makes no sense each imply
/// a different next move, and the retry disposition attached to the code is how
/// the harness knows which. Throwing this instead of a bare exception is how an
/// operation says so.
/// </remarks>
public sealed class OperationFailedException : Exception
{
    public OperationFailedException(ErrorCode code, string message, Exception? inner = null)
        : base(message, inner)
    {
        Code = code;
    }

    public ErrorCode Code { get; }
}

/// <summary>One thing the bridge can be asked to do.</summary>
public interface INativeOperation
{
    /// <summary>Canonical dotted name, for example <c>rhino.object.create</c>.</summary>
    string Name { get; }

    /// <summary>
    /// Runs <em>on the host UI thread</em>. Return the value to put in the
    /// response, or null for none.
    /// </summary>
    /// <remarks>
    /// Implementations never post to the UI thread themselves and never block
    /// on another thread: they are already where they need to be, and blocking
    /// here freezes Rhino. Throwing is the correct way to fail — the dispatcher
    /// captures it and the handler gives it a typed code.
    /// </remarks>
    object? Execute(RequestEnvelope request, CancellationToken cancellationToken);
}

/// <summary>
/// Routes a request to an operation, runs it on the UI thread, and turns
/// whatever happens into one typed answer.
/// </summary>
public sealed class DispatchingRequestHandler : IRequestHandler
{
    /// <summary>
    /// Used when a request names no deadline of its own.
    /// </summary>
    /// <remarks>
    /// The facade times out independently and is the authority on how long
    /// <em>it</em> waits. This one exists so a wedged UI thread cannot pin a
    /// bridge worker forever even if the facade has walked away.
    /// </remarks>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(30);

    /// <summary>
    /// No request gets to ask for an unbounded wait, however politely.
    /// </summary>
    public static readonly TimeSpan MaximumTimeout = TimeSpan.FromMinutes(5);

    private readonly IReadOnlyDictionary<string, INativeOperation> _operations;
    private readonly INativeDispatcher _dispatcher;
    private readonly IBridgeLog _log;

    public DispatchingRequestHandler(
        IEnumerable<INativeOperation> operations,
        INativeDispatcher dispatcher,
        IBridgeLog? log = null)
    {
        var map = new Dictionary<string, INativeOperation>(StringComparer.Ordinal);
        foreach (INativeOperation operation in operations)
        {
            if (!map.TryAdd(operation.Name, operation))
            {
                throw new ArgumentException(
                    $"two operations are both registered as '{operation.Name}'", nameof(operations));
            }
        }

        _operations = map;
        _dispatcher = dispatcher;
        _log = log ?? NullBridgeLog.Instance;
    }

    /// <summary>The operation names this bridge answers to.</summary>
    public IReadOnlyCollection<string> OperationNames => (IReadOnlyCollection<string>)_operations.Keys;

    public async Task<RequestOutcome> HandleAsync(
        RequestEnvelope request,
        CancellationToken cancellationToken)
    {
        if (!_operations.TryGetValue(request.Operation, out INativeOperation? operation))
        {
            // Named rather than guessed at. A bridge that quietly did something
            // adjacent to what was asked would be far worse than one that says
            // no.
            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                ErrorCode.OperationNotSupported,
                $"'{request.Operation}' is not an operation this HII Rhino bridge implements"));
        }

        TimeSpan timeout = ResolveTimeout(request.TimeoutMs);
        var stopwatch = Stopwatch.StartNew();

        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);

        try
        {
            object? result = await _dispatcher
                .InvokeAsync(token => operation.Execute(request, token), deadline.Token)
                .ConfigureAwait(false);

            stopwatch.Stop();
            return RequestOutcome.Ok(new ResponseEnvelope
            {
                RequestId = request.RequestId,
                Status = ResponseStatus.Ok,
                Result = result is null
                    ? null
                    : JsonSerializer.SerializeToElement(result, result.GetType(), WireJson.Options),
                DurationMs = (ulong)stopwatch.ElapsedMilliseconds,
            });
        }
        catch (NativeDispatchException dispatch)
        {
            stopwatch.Stop();

            // The distinction the whole taxonomy exists for. "Never started" is
            // provable here and means a retry is safe; "already running" means
            // Rhino may be part-way through changing the document, and a retry
            // could do it twice.
            ErrorCode code = dispatch.Started
                ? ErrorCode.RequestOutcomeUnknown
                : ErrorCode.Cancelled;

            _log.Warn($"'{request.Operation}' did not complete after {stopwatch.ElapsedMilliseconds}ms: {dispatch.Message}");

            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                code,
                dispatch.Message));
        }
        catch (UiDispatchRefusedException refused)
        {
            // Nothing was scheduled, so nothing happened. Safe by default.
            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                ErrorCode.UiDispatchFailed,
                refused.Message));
        }
        catch (OperationFailedException failed)
        {
            // The operation knew exactly what went wrong. Its code carries a
            // retry disposition the harness can act on, which is the entire
            // difference between this and a bare exception.
            stopwatch.Stop();
            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                failed.Code,
                failed.Message));
        }
        catch (OperationCanceledException)
        {
            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                ErrorCode.Cancelled,
                "the bridge stopped while this request was waiting for the UI thread"));
        }
        catch (Exception error)
        {
            stopwatch.Stop();

            // The operation itself failed. The type and message go across
            // because "native operation failed" on its own tells the harness
            // nothing it can act on; the stack trace does not, because it is
            // noise on the wire and leaks paths.
            _log.Warn($"'{request.Operation}' failed", error);

            return RequestOutcome.Failed(ErrorEnvelope.Create(
                request.RequestId,
                ErrorCode.NativeOperationFailed,
                $"{error.GetType().Name}: {error.Message}"));
        }
    }

    private static TimeSpan ResolveTimeout(ulong? requested)
    {
        if (requested is null or 0)
        {
            return DefaultTimeout;
        }

        var asked = TimeSpan.FromMilliseconds(Math.Min(requested.Value, (ulong)MaximumTimeout.TotalMilliseconds));
        return asked;
    }
}
