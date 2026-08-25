using System;
using System.Threading;
using System.Threading.Tasks;

namespace HiiRhino.Core.Hosting;

/// <summary>
/// The one place work crosses onto the host's UI thread.
/// </summary>
/// <remarks>
/// Every RhinoCommon and Grasshopper call that needs the main thread goes
/// through here. Individual operation handlers never post to the UI thread
/// themselves: one boundary means one place where exception capture,
/// cancellation semantics and deadlock avoidance are decided, instead of
/// however many handlers there eventually are.
/// </remarks>
public interface INativeDispatcher
{
    /// <summary>True when the caller is already on the host's UI thread.</summary>
    bool IsOnUiThread { get; }

    /// <summary>
    /// Run <paramref name="operation"/> on the UI thread and bring back its
    /// value or its exception.
    /// </summary>
    /// <exception cref="NativeDispatchException">
    /// The wait ended without a result. <see cref="NativeDispatchException.Started"/>
    /// says whether the operation had begun, which is the difference between a
    /// request that is safe to repeat and one that is not.
    /// </exception>
    Task<T> InvokeAsync<T>(Func<CancellationToken, T> operation, CancellationToken cancellationToken);
}

/// <summary>
/// A dispatch that produced no result.
/// </summary>
/// <remarks>
/// <see cref="Started"/> is the whole point of this type. Once the operation
/// has begun running on the UI thread there is no way to stop it — .NET has no
/// safe thread abort, and one would corrupt the Rhino document anyway — so a
/// caller that gives up waiting has to be told that the work may still be
/// happening. Reporting that as an ordinary timeout would tell the harness the
/// request is safe to send again, and the second one could duplicate whatever
/// the first is in the middle of doing.
/// </remarks>
public sealed class NativeDispatchException : Exception
{
    public NativeDispatchException(bool started, string message, Exception? inner = null)
        : base(message, inner)
    {
        Started = started;
    }

    /// <summary>Whether the operation had begun executing when the wait ended.</summary>
    public bool Started { get; }
}

/// <summary>
/// Posts work to a UI thread and waits for it, without ever blocking that
/// thread waiting for itself.
/// </summary>
/// <remarks>
/// The host is injected as two delegates rather than referenced directly, so
/// this whole class is testable against an ordinary pumped thread and carries
/// no dependency on RhinoCommon.
/// </remarks>
public sealed class UiThreadDispatcher : INativeDispatcher
{
    private readonly Action<Action> _post;
    private readonly Func<bool> _isOnUiThread;

    public UiThreadDispatcher(Action<Action> post, Func<bool> isOnUiThread)
    {
        _post = post;
        _isOnUiThread = isOnUiThread;
    }

    public bool IsOnUiThread => _isOnUiThread();

    public Task<T> InvokeAsync<T>(Func<CancellationToken, T> operation, CancellationToken cancellationToken)
    {
        if (_isOnUiThread())
        {
            // Already there. Posting and waiting would post to the thread that
            // is doing the waiting, which never completes.
            try
            {
                return Task.FromResult(operation(cancellationToken));
            }
            catch (Exception error)
            {
                return Task.FromException<T>(error);
            }
        }

        var slot = new Slot<T>(operation);
        try
        {
            _post(slot.Run);
        }
        catch (Exception error)
        {
            // The host refused the work outright. Nothing ran, so this is
            // cleanly safe to retry once whatever is wrong with the host is
            // fixed — which is why it is not a NativeDispatchException.
            return Task.FromException<T>(
                new UiDispatchRefusedException("the host would not accept work on its UI thread", error));
        }

        return slot.WaitAsync(cancellationToken);
    }

    /// <summary>
    /// One posted operation, and the handshake between the thread running it
    /// and the thread waiting for it.
    /// </summary>
    private sealed class Slot<T>
    {
        private const int Pending = 0;
        private const int Running = 1;
        private const int Abandoned = 2;

        private readonly Func<CancellationToken, T> _operation;
        private readonly TaskCompletionSource<T> _result =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly CancellationTokenSource _operationCancellation = new();
        private int _state = Pending;

        public Slot(Func<CancellationToken, T> operation) => _operation = operation;

        /// <summary>Runs on the UI thread.</summary>
        public void Run()
        {
            // If the waiter gave up before we were scheduled, do not run at
            // all. That is what makes "never started" a claim rather than a
            // hope, and it is the only case where giving up is safe.
            if (Interlocked.CompareExchange(ref _state, Running, Pending) != Pending)
            {
                return;
            }

            try
            {
                _result.TrySetResult(_operation(_operationCancellation.Token));
            }
            catch (OperationCanceledException error)
            {
                _result.TrySetException(
                    new NativeDispatchException(started: true, "the operation observed cancellation", error));
            }
            catch (Exception error)
            {
                // The operation's own failure, propagated as itself. The
                // handler above turns it into a typed native failure; losing it
                // here would leave the caller with "something went wrong".
                _result.TrySetException(error);
            }
        }

        public async Task<T> WaitAsync(CancellationToken cancellationToken)
        {
            using CancellationTokenRegistration registration = cancellationToken.Register(GiveUp);
            return await _result.Task.ConfigureAwait(false);
        }

        private void GiveUp()
        {
            int previous = Interlocked.CompareExchange(ref _state, Abandoned, Pending);
            if (previous == Pending)
            {
                // Beaten the UI thread to it: Run() will now decline to
                // execute, so nothing happened and nothing can have happened.
                _result.TrySetException(new NativeDispatchException(
                    started: false,
                    "the operation was cancelled before it reached the UI thread"));
                return;
            }

            // Already running. We cannot stop it, so we ask it to notice and
            // then stop waiting — but we must not claim it did not happen.
            _operationCancellation.Cancel();
            _result.TrySetException(new NativeDispatchException(
                started: true,
                "the operation was already running on the UI thread when the wait ended; "
                    + "whether it completed is unknown"));
        }
    }
}

/// <summary>
/// The host would not take the work at all — a shutting-down or wedged UI.
/// </summary>
/// <remarks>
/// Distinct from <see cref="NativeDispatchException"/> because nothing was
/// scheduled, let alone run, so retrying is safe once the host recovers.
/// </remarks>
public sealed class UiDispatchRefusedException : Exception
{
    public UiDispatchRefusedException(string message, Exception? inner = null)
        : base(message, inner)
    {
    }
}
