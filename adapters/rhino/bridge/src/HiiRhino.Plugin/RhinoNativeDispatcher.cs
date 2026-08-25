using System;
using HiiRhino.Core.Hosting;
using Rhino;

namespace HiiRhino.Plugin;

/// <summary>
/// Binds the dispatcher to Rhino's UI thread.
/// </summary>
/// <remarks>
/// <para>
/// The whole of the Rhino-specific part of checkpoint D is these two
/// delegates. Everything else about dispatch — the ordering, the cancellation
/// semantics, the exception capture — lives in
/// <see cref="UiThreadDispatcher"/>, where it can be tested against an ordinary
/// pumped thread rather than only inside Rhino.
/// </para>
/// <para>
/// <c>RhinoApp.InvokeOnUiThread</c> posts and returns; it does not wait, and it
/// gives back neither the result nor the exception. That is why the dispatcher
/// carries its own completion handshake instead of calling this directly from
/// each handler.
/// </para>
/// </remarks>
internal static class RhinoNativeDispatcher
{
    public static INativeDispatcher Create() => new UiThreadDispatcher(
        post: action => RhinoApp.InvokeOnUiThread(action, null),
        // Rhino's own answer, not a captured thread id. A thread id captured at
        // plug-in load would be wrong the moment Rhino did anything unexpected
        // with its main thread, and would fail in the direction that deadlocks.
        isOnUiThread: () => !RhinoApp.InvokeRequired);
}
