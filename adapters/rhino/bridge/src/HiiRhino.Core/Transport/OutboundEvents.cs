using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Transport;

/// <summary>
/// Events waiting to be written to one connection.
/// </summary>
/// <remarks>
/// <para>
/// The producer here is a Rhino event handler running on the UI thread. It
/// cannot be allowed to block for any reason whatsoever — not on a lock held by
/// a pipe write, not on a slow client, not on anything. Every operation on this
/// queue is therefore non-blocking, and the enqueue side never fails.
/// </para>
/// <para>
/// Which means it has to be allowed to lose things. When the queue is full the
/// oldest observation is discarded, because a newer one describes the document
/// as it is now. The count travels with the next event that does get through,
/// so a consumer can tell an empty stream from a truncated one.
/// </para>
/// </remarks>
public sealed class OutboundEvents
{
    /// <summary>
    /// Deep enough to absorb a burst — Rhino fires one ObjectAdded per object,
    /// and an import or a paste produces thousands — without becoming a place
    /// where unbounded memory hides.
    /// </summary>
    public const int DefaultCapacity = 1024;

    private readonly object _gate = new();
    private readonly Queue<EventEnvelope> _queue = new();
    private readonly SemaphoreSlim _arrived = new(0);
    private readonly int _capacity;

    private ulong _droppedSinceLastDelivery;
    private ulong _droppedTotal;
    private bool _closed;

    public OutboundEvents(int capacity = DefaultCapacity) => _capacity = Math.Max(1, capacity);

    /// <summary>Everything discarded on this connection, for diagnostics.</summary>
    public ulong DroppedTotal
    {
        get
        {
            lock (_gate)
            {
                return _droppedTotal;
            }
        }
    }

    public int Count
    {
        get
        {
            lock (_gate)
            {
                return _queue.Count;
            }
        }
    }

    /// <summary>
    /// Queue one observation. Called from Rhino's UI thread; never blocks and
    /// never throws.
    /// </summary>
    public void Publish(EventEnvelope observation)
    {
        lock (_gate)
        {
            if (_closed)
            {
                return;
            }

            while (_queue.Count >= _capacity)
            {
                _queue.Dequeue();
                _droppedSinceLastDelivery++;
                _droppedTotal++;
            }

            _queue.Enqueue(observation);
        }

        // Outside the lock: releasing a semaphore can run a waiter's
        // continuation inline, and doing that while holding a lock taken on
        // Rhino's UI thread is how a UI thread ends up waiting on a pipe write.
        try
        {
            _arrived.Release();
        }
        catch (ObjectDisposedException)
        {
        }
        catch (SemaphoreFullException)
        {
        }
    }

    /// <summary>
    /// Wait for the next observation to write, stamping it with whatever was
    /// lost since the previous one.
    /// </summary>
    public async Task<EventEnvelope?> TakeAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            await _arrived.WaitAsync(cancellationToken).ConfigureAwait(false);

            lock (_gate)
            {
                if (_closed && _queue.Count == 0)
                {
                    return null;
                }
                if (_queue.Count == 0)
                {
                    continue;
                }

                EventEnvelope next = _queue.Dequeue();
                if (_droppedSinceLastDelivery > 0)
                {
                    next.DroppedBefore = _droppedSinceLastDelivery;
                    _droppedSinceLastDelivery = 0;
                }
                return next;
            }
        }
    }

    public void Close()
    {
        lock (_gate)
        {
            _closed = true;
            _queue.Clear();
        }

        try
        {
            _arrived.Release();
        }
        catch (ObjectDisposedException)
        {
        }
        catch (SemaphoreFullException)
        {
        }
    }
}
