using System;
using System.Collections.Concurrent;
using System.Threading;
using HiiRhino.Core.Hosting;

namespace HiiRhino.Core.Tests;

/// <summary>
/// A stand-in for Rhino's UI thread: one dedicated thread that runs posted work
/// in order, one item at a time.
/// </summary>
/// <remarks>
/// The properties that matter for dispatch are exactly these two — a single
/// thread, and strictly serial execution — and they are what makes the whole
/// class of bugs possible: a blocked UI thread blocks everything behind it, and
/// posting from the UI thread and then waiting on it deadlocks. A test against
/// the thread pool would have neither property and would pass while proving
/// nothing.
/// </remarks>
internal sealed class FakeUiThread : IDisposable
{
    private readonly BlockingCollection<Action> _queue = new();
    private readonly Thread _thread;

    public FakeUiThread()
    {
        _thread = new Thread(Pump)
        {
            IsBackground = true,
            Name = "fake-ui-thread",
        };
        _thread.Start();
    }

    public int ManagedThreadId => _thread.ManagedThreadId;

    /// <summary>Whether the caller is the UI thread, as Rhino would answer.</summary>
    public bool IsOnUiThread => Environment.CurrentManagedThreadId == _thread.ManagedThreadId;

    /// <summary>Set to have <see cref="Post"/> throw, as a wedged host would.</summary>
    public bool RefusePosts { get; set; }

    public void Post(Action work)
    {
        if (RefusePosts)
        {
            throw new InvalidOperationException("the fake host is not accepting work");
        }
        _queue.Add(work);
    }

    public INativeDispatcher Dispatcher() => new UiThreadDispatcher(Post, () => IsOnUiThread);

    private void Pump()
    {
        try
        {
            foreach (Action work in _queue.GetConsumingEnumerable())
            {
                try
                {
                    work();
                }
                catch
                {
                    // A real UI pump does not die because one posted item
                    // threw, and the dispatcher is supposed to have caught it
                    // long before it got here anyway.
                }
            }
        }
        catch (ObjectDisposedException)
        {
            // The test finished while this thread was parked in the queue.
        }
    }

    /// <remarks>
    /// The queue is deliberately not disposed. A test may still have work
    /// parked on this thread when it ends, and disposing the collection out
    /// from under the pump kills the whole test host rather than the one test —
    /// which is exactly what happened the first time. Completing the collection
    /// is enough to end the pump; the rest is the garbage collector's problem.
    /// </remarks>
    public void Dispose()
    {
        _queue.CompleteAdding();
        _thread.Join(TimeSpan.FromSeconds(5));
    }
}
