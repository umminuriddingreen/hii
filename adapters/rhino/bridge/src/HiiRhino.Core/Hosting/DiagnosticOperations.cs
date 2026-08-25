using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Hosting;

/// <summary>
/// Operations that exercise the dispatcher and touch nothing else.
/// </summary>
/// <remarks>
/// <para>
/// These exist because a dispatcher with no operations cannot be tested: there
/// is no way to show that work reaches the UI thread, that an exception comes
/// back typed, or that a wait which expires mid-operation is reported as an
/// unknown outcome rather than a safe timeout. Checkpoint D has to demonstrate
/// all three, and the first document operation does not arrive until E.
/// </para>
/// <para>
/// They read no document, mutate nothing, and depend on no Rhino state. They
/// are <em>diagnostics</em>, not tools: when the model-visible catalogue is
/// built, these must not appear in it. Nothing about a language model's job is
/// served by being able to block Rhino's UI thread on request.
/// </para>
/// </remarks>
public static class DiagnosticOperations
{
    public const string Prefix = "bridge.diagnostics.";

    /// <summary>The full set, ready to hand to a <see cref="DispatchingRequestHandler"/>.</summary>
    public static IReadOnlyList<INativeOperation> All(Func<bool> isOnUiThread) => new INativeOperation[]
    {
        new ThreadOperation(isOnUiThread),
        new FailOperation(),
        new BlockOperation(),
    };

    /// <summary>Evidence about where the operation actually ran.</summary>
    public sealed class ThreadReport
    {
        [JsonPropertyName("on_ui_thread")] public bool OnUiThread { get; set; }
        [JsonPropertyName("managed_thread_id")] public int ManagedThreadId { get; set; }
        [JsonPropertyName("is_thread_pool_thread")] public bool IsThreadPoolThread { get; set; }
    }

    /// <summary>
    /// Reports whether the operation body ran on the host UI thread.
    /// </summary>
    /// <remarks>
    /// The single most load-bearing claim in checkpoint D. Asserting it from
    /// the host's own "would an invoke be required" answer, evaluated inside
    /// the dispatched body, is the only way to show it rather than assume it.
    /// </remarks>
    private sealed class ThreadOperation : INativeOperation
    {
        private readonly Func<bool> _isOnUiThread;

        public ThreadOperation(Func<bool> isOnUiThread) => _isOnUiThread = isOnUiThread;

        public string Name => Prefix + "thread";

        public object Execute(RequestEnvelope request, CancellationToken cancellationToken) => new ThreadReport
        {
            OnUiThread = _isOnUiThread(),
            ManagedThreadId = Environment.CurrentManagedThreadId,
            IsThreadPoolThread = Thread.CurrentThread.IsThreadPoolThread,
        };
    }

    /// <summary>Throws, so exception propagation can be observed end to end.</summary>
    private sealed class FailOperation : INativeOperation
    {
        public string Name => Prefix + "fail";

        public object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            string message = Argument(request, "message")?.GetString()
                ?? "a deliberate diagnostic failure";
            throw new InvalidOperationException(message);
        }
    }

    /// <summary>
    /// Occupies the UI thread for a while, so a wait that expires part-way can
    /// be observed.
    /// </summary>
    /// <remarks>
    /// It deliberately does <em>not</em> watch the cancellation token. Real
    /// RhinoCommon calls cannot be interrupted once they start, and a
    /// diagnostic that politely returned early would exercise a case that never
    /// happens while leaving the one that does — an operation still running
    /// when the caller gives up — untested.
    /// </remarks>
    private sealed class BlockOperation : INativeOperation
    {
        private static readonly TimeSpan Longest = TimeSpan.FromSeconds(30);

        public string Name => Prefix + "block";

        public object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            double requested = Argument(request, "hold_ms")?.GetDouble() ?? 100;
            var hold = TimeSpan.FromMilliseconds(Math.Clamp(requested, 0, Longest.TotalMilliseconds));

            Thread.Sleep(hold);
            return new Dictionary<string, object> { ["held_ms"] = (long)hold.TotalMilliseconds };
        }
    }

    private static JsonElement? Argument(RequestEnvelope request, string name)
    {
        if (request.Arguments is not { ValueKind: JsonValueKind.Object } arguments)
        {
            return null;
        }
        return arguments.TryGetProperty(name, out JsonElement value) ? value : null;
    }
}
