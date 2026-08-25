using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;
using HiiRhino.Core.Transport;
using Xunit;

namespace HiiRhino.Core.Tests;

public sealed class OutboundEventsTests
{
    private static EventEnvelope Observation(string id) => new()
    {
        EventId = id,
        Kind = EventKind.ObjectAdded,
        Session = new RhinoSessionRef { RhinoInstanceId = Guid.NewGuid(), ProcessId = 1, SessionId = 1 },
        EmittedAtUnixMs = 0,
    };

    [Fact]
    public async Task observations_come_back_in_the_order_they_happened()
    {
        var events = new OutboundEvents(8);
        for (int index = 0; index < 3; index++)
        {
            events.Publish(Observation($"evt-{index}"));
        }

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        var seen = new List<string>();
        for (int index = 0; index < 3; index++)
        {
            EventEnvelope? next = await events.TakeAsync(deadline.Token);
            seen.Add(next!.EventId);
        }

        Assert.Equal(new[] { "evt-0", "evt-1", "evt-2" }, seen);
        Assert.Equal(0ul, events.DroppedTotal);
    }

    [Fact]
    public async Task a_full_queue_discards_the_oldest_and_tells_the_next_event_about_it()
    {
        // The whole contract. Publishing happens on Rhino's UI thread, so it can
        // never block or fail; the price is that something has to be thrown
        // away, and the only acceptable version of that is a loud one.
        var events = new OutboundEvents(3);
        for (int index = 0; index < 6; index++)
        {
            events.Publish(Observation($"evt-{index}"));
        }

        Assert.Equal(3ul, events.DroppedTotal);

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        EventEnvelope? first = await events.TakeAsync(deadline.Token);

        Assert.Equal("evt-3", first!.EventId);
        Assert.Equal(3ul, first.DroppedBefore);

        // The count is per delivery, not cumulative: it describes the gap
        // immediately before this event, so a consumer can locate the hole.
        EventEnvelope? second = await events.TakeAsync(deadline.Token);
        Assert.Equal("evt-4", second!.EventId);
        Assert.Null(second.DroppedBefore);
    }

    [Fact]
    public void publishing_never_blocks_however_far_behind_the_consumer_is()
    {
        // Nobody is draining at all. On the UI thread this is the difference
        // between a responsive Rhino and a frozen one.
        var events = new OutboundEvents(16);

        var stopwatch = Stopwatch.StartNew();
        for (int index = 0; index < 50_000; index++)
        {
            events.Publish(Observation($"evt-{index}"));
        }
        stopwatch.Stop();

        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(5),
            $"publishing 50,000 observations took {stopwatch.Elapsed.TotalSeconds:0.0}s");
        Assert.Equal(16, events.Count);
        Assert.Equal(50_000ul - 16ul, events.DroppedTotal);
    }

    [Fact]
    public async Task closing_releases_a_waiting_pump_instead_of_stranding_it()
    {
        var events = new OutboundEvents(4);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));

        Task<EventEnvelope?> waiting = events.TakeAsync(deadline.Token);
        events.Close();

        Assert.Null(await waiting);
    }

    [Fact]
    public async Task an_observation_published_after_closing_is_discarded_not_queued()
    {
        var events = new OutboundEvents(4);
        events.Close();
        events.Publish(Observation("too-late"));

        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        Assert.Null(await events.TakeAsync(deadline.Token));
    }
}
