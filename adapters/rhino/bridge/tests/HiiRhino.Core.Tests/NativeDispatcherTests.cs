using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using Xunit;

namespace HiiRhino.Core.Tests;

public sealed class NativeDispatcherTests : IDisposable
{
    private readonly FakeUiThread _ui = new();

    public void Dispose() => _ui.Dispose();

    [Fact]
    public async Task work_runs_on_the_ui_thread_not_the_calling_thread()
    {
        INativeDispatcher dispatcher = _ui.Dispatcher();

        int ranOn = await dispatcher.InvokeAsync(_ => Environment.CurrentManagedThreadId, CancellationToken.None);

        Assert.Equal(_ui.ManagedThreadId, ranOn);
        Assert.NotEqual(Environment.CurrentManagedThreadId, ranOn);
    }

    [Fact]
    public async Task a_typed_value_comes_back_as_itself()
    {
        INativeDispatcher dispatcher = _ui.Dispatcher();

        (string name, int count) result = await dispatcher.InvokeAsync(
            _ => (name: "box", count: 3), CancellationToken.None);

        Assert.Equal("box", result.name);
        Assert.Equal(3, result.count);
    }

    [Fact]
    public async Task an_exception_on_the_ui_thread_reaches_the_caller_intact()
    {
        // Not "an error occurred". The type and the message are what the
        // handler turns into something the harness can act on, and they only
        // exist on the thread that threw.
        INativeDispatcher dispatcher = _ui.Dispatcher();

        var error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => dispatcher.InvokeAsync<int>(
                _ => throw new InvalidOperationException("the document was busy"),
                CancellationToken.None));

        Assert.Equal("the document was busy", error.Message);
    }

    [Fact]
    public async Task cancelling_before_the_ui_thread_gets_to_it_means_it_never_ran()
    {
        // The queue is occupied, so the second item cannot have started. That
        // makes "never started" provable rather than probable, which is the
        // only condition under which giving up is safe.
        INativeDispatcher dispatcher = _ui.Dispatcher();
        using var occupied = new SemaphoreSlim(0, 1);
        var ran = false;

        Task blocker = dispatcher.InvokeAsync(
            _ => { occupied.Wait(TimeSpan.FromSeconds(10)); return 0; },
            CancellationToken.None);

        using var cancellation = new CancellationTokenSource();
        Task queued = dispatcher.InvokeAsync(_ => { ran = true; return 0; }, cancellation.Token);

        cancellation.Cancel();

        var dispatch = await Assert.ThrowsAsync<NativeDispatchException>(() => queued);
        Assert.False(dispatch.Started);

        occupied.Release();
        await blocker;

        // Give the pump a moment to prove it declines the abandoned item.
        await Task.Delay(200);
        Assert.False(ran);
    }

    [Fact]
    public async Task giving_up_on_something_already_running_reports_that_it_started()
    {
        // The case the taxonomy exists for. The operation is on the UI thread
        // and cannot be stopped; claiming it did not happen would let the
        // caller repeat it.
        INativeDispatcher dispatcher = _ui.Dispatcher();
        using var started = new ManualResetEventSlim(false);
        using var release = new SemaphoreSlim(0, 1);

        using var cancellation = new CancellationTokenSource();
        Task running = dispatcher.InvokeAsync(
            _ =>
            {
                started.Set();
                release.Wait(TimeSpan.FromSeconds(10));
                return 42;
            },
            cancellation.Token);

        Assert.True(started.Wait(TimeSpan.FromSeconds(5)));
        cancellation.Cancel();

        var dispatch = await Assert.ThrowsAsync<NativeDispatchException>(() => running);
        Assert.True(dispatch.Started);

        release.Release();
    }

    [Fact]
    public async Task dispatching_from_the_ui_thread_runs_inline_instead_of_deadlocking()
    {
        // Posting from the UI thread and then waiting for the UI thread waits
        // for the thread that is doing the waiting. Running inline is the only
        // correct answer, and this is the test that keeps it that way.
        INativeDispatcher dispatcher = _ui.Dispatcher();

        int outer = await dispatcher.InvokeAsync(
            _ =>
            {
                Task<int> inner = dispatcher.InvokeAsync(
                    __ => Environment.CurrentManagedThreadId, CancellationToken.None);

                // Completed already: if it had been posted, this would hang.
                Assert.True(inner.IsCompleted);
                return inner.GetAwaiter().GetResult();
            },
            CancellationToken.None);

        Assert.Equal(_ui.ManagedThreadId, outer);
    }

    [Fact]
    public async Task a_host_that_will_not_accept_work_is_a_dispatch_failure_not_an_unknown_outcome()
    {
        INativeDispatcher dispatcher = _ui.Dispatcher();
        _ui.RefusePosts = true;

        await Assert.ThrowsAsync<UiDispatchRefusedException>(
            () => dispatcher.InvokeAsync(_ => 1, CancellationToken.None));
    }

    [Fact]
    public async Task the_ui_thread_runs_one_thing_at_a_time_in_order()
    {
        INativeDispatcher dispatcher = _ui.Dispatcher();
        var order = new List<int>();

        Task[] all = new Task[5];
        for (int index = 0; index < all.Length; index++)
        {
            int captured = index;
            all[index] = dispatcher.InvokeAsync(
                _ =>
                {
                    // No lock: if these ever overlapped, that would itself be
                    // the bug this asserts against.
                    order.Add(captured);
                    return captured;
                },
                CancellationToken.None);
        }

        await Task.WhenAll(all);
        Assert.Equal(new[] { 0, 1, 2, 3, 4 }, order);
    }
}

public sealed class DispatchingRequestHandlerTests : IDisposable
{
    private readonly FakeUiThread _ui = new();

    public void Dispose() => _ui.Dispose();

    private DispatchingRequestHandler Handler() => new(
        DiagnosticOperations.All(() => _ui.IsOnUiThread),
        _ui.Dispatcher());

    private static RequestEnvelope Request(string operation, object? arguments = null, ulong? timeoutMs = null) => new()
    {
        ProtocolVersion = WireProtocol.Version,
        RequestId = "req-0001",
        Operation = operation,
        Arguments = arguments is null
            ? null
            : JsonSerializer.SerializeToElement(arguments, WireJson.Options),
        TimeoutMs = timeoutMs,
    };

    [Fact]
    public async Task an_unknown_operation_is_named_rather_than_guessed_at()
    {
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("rhino.object.create"), CancellationToken.None);

        ErrorEnvelope error = Assert.IsType<ErrorEnvelope>(outcome.Message);
        Assert.Equal(ErrorCode.OperationNotSupported, error.Code);
        Assert.Equal(RetryDisposition.RequiresDifferentArguments, error.Retry);
        Assert.Contains("rhino.object.create", error.Message);
        Assert.Equal("req-0001", error.RequestId);
    }

    [Fact]
    public async Task an_operation_body_really_does_run_on_the_ui_thread()
    {
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("bridge.diagnostics.thread"), CancellationToken.None);

        ResponseEnvelope response = Assert.IsType<ResponseEnvelope>(outcome.Message);
        JsonElement result = response.Result!.Value;

        Assert.True(result.GetProperty("on_ui_thread").GetBoolean());
        Assert.Equal(_ui.ManagedThreadId, result.GetProperty("managed_thread_id").GetInt32());
        Assert.False(result.GetProperty("is_thread_pool_thread").GetBoolean());
    }

    [Fact]
    public async Task an_operation_that_throws_comes_back_as_a_typed_native_failure()
    {
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("bridge.diagnostics.fail", new Dictionary<string, string> { ["message"] = "no active document" }),
            CancellationToken.None);

        ErrorEnvelope error = Assert.IsType<ErrorEnvelope>(outcome.Message);
        Assert.Equal(ErrorCode.NativeOperationFailed, error.Code);

        // The type and the message survive; the stack trace deliberately does
        // not, because it is noise on the wire and leaks local paths.
        Assert.Contains("InvalidOperationException", error.Message);
        Assert.Contains("no active document", error.Message);
        Assert.DoesNotContain("   at ", error.Message);
    }

    [Fact]
    public async Task a_deadline_that_expires_mid_operation_is_an_unknown_outcome_not_a_timeout()
    {
        // The single most important mapping in checkpoint D. Reporting this as
        // Timeout would carry retry disposition Safe, and the harness would be
        // entitled to send the request again — while the first one is still
        // running inside Rhino.
        var stopwatch = Stopwatch.StartNew();
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("bridge.diagnostics.block", new Dictionary<string, double> { ["hold_ms"] = 3000 }, timeoutMs: 300),
            CancellationToken.None);
        stopwatch.Stop();

        ErrorEnvelope error = Assert.IsType<ErrorEnvelope>(outcome.Message);
        Assert.Equal(ErrorCode.RequestOutcomeUnknown, error.Code);
        Assert.Equal(RetryDisposition.Unsafe, error.Retry);

        // And the caller is released on its own deadline rather than waiting
        // out the operation it gave up on.
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(2),
            $"the handler waited {stopwatch.Elapsed.TotalSeconds:0.0}s for an operation it abandoned");
    }

    [Fact]
    public async Task a_deadline_that_expires_before_the_operation_starts_is_safely_cancelled()
    {
        // Queued behind a long operation, so it cannot have begun. This one
        // *is* safe to retry, and saying so is worth as much as refusing to say
        // so in the case above.
        DispatchingRequestHandler handler = Handler();

        Task<RequestOutcome> blocking = handler.HandleAsync(
            Request("bridge.diagnostics.block", new Dictionary<string, double> { ["hold_ms"] = 1500 }),
            CancellationToken.None);

        await Task.Delay(150);

        RequestOutcome outcome = await handler.HandleAsync(
            Request("bridge.diagnostics.thread", timeoutMs: 200), CancellationToken.None);

        ErrorEnvelope error = Assert.IsType<ErrorEnvelope>(outcome.Message);
        Assert.Equal(ErrorCode.Cancelled, error.Code);
        Assert.Equal(RetryDisposition.Safe, error.Retry);

        await blocking;
    }

    [Fact]
    public async Task a_completed_operation_reports_how_long_it_took()
    {
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("bridge.diagnostics.block", new Dictionary<string, double> { ["hold_ms"] = 250 }),
            CancellationToken.None);

        ResponseEnvelope response = Assert.IsType<ResponseEnvelope>(outcome.Message);
        Assert.Equal(ResponseStatus.Ok, response.Status);
        Assert.True(response.DurationMs >= 200, $"duration was {response.DurationMs}ms");

        // Nothing was mutated, so nothing is claimed to have been.
        Assert.Null(response.Mutation);
    }

    [Fact]
    public void two_operations_cannot_claim_the_same_name()
    {
        // A silently shadowed operation would route requests somewhere nobody
        // intended, and would look exactly like the operation working.
        IReadOnlyList<INativeOperation> once = DiagnosticOperations.All(() => true);
        var twice = new List<INativeOperation>(once);
        twice.AddRange(once);

        Assert.Throws<ArgumentException>(() => new DispatchingRequestHandler(twice, _ui.Dispatcher()));
    }

    [Fact]
    public async Task an_absurd_timeout_is_clamped_rather_than_honoured()
    {
        // A request must not be able to pin a bridge worker for a week by
        // asking nicely.
        RequestOutcome outcome = await Handler().HandleAsync(
            Request("bridge.diagnostics.thread", timeoutMs: ulong.MaxValue), CancellationToken.None);

        // It still succeeds — the clamp is a ceiling, not a rejection.
        Assert.IsType<ResponseEnvelope>(outcome.Message);
    }
}
