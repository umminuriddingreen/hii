using System;
using System.Text.Json;
using System.Threading;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using HiiRhino.Core.Transport;
using Rhino;
using Rhino.DocObjects;

namespace HiiRhino.Plugin;

/// <summary>
/// Turns Rhino's document events into protocol observations.
/// </summary>
/// <remarks>
/// <para>
/// <strong>These handlers observe. They never act.</strong> A handler may
/// describe what happened and hand it to the transport; it must never create,
/// delete or modify anything in response. Rhino fires these from inside its own
/// document operations, and mutating from within one is how re-entrancy, half-
/// applied undo records and corrupted documents happen. Anything HII wants to do
/// as a consequence comes back through the normal request path.
/// </para>
/// <para>
/// Handlers must also be fast and must not throw. They run on Rhino's UI thread,
/// once per object for an add or a delete, so a slow handler is a slow Rhino and
/// an exception is an exception thrown into Rhino's own edit loop. Everything
/// here builds a small object, queues it, and returns.
/// </para>
/// </remarks>
internal sealed class RhinoEventBridge : IDisposable
{
    private readonly BridgeServer _server;
    private readonly BridgeIdentity _identity;
    private readonly IBridgeLog _log;
    private long _sequence;
    private int _subscribed;

    public RhinoEventBridge(BridgeServer server, BridgeIdentity identity, IBridgeLog log)
    {
        _server = server;
        _identity = identity;
        _log = log;
    }

    /// <summary>Start observing. Called on the UI thread as the bridge starts.</summary>
    public void Subscribe()
    {
        if (Interlocked.Exchange(ref _subscribed, 1) != 0)
        {
            return;
        }

        RhinoDoc.AddRhinoObject += OnAdd;
        RhinoDoc.DeleteRhinoObject += OnDelete;
        RhinoDoc.ReplaceRhinoObject += OnReplace;
        RhinoDoc.ModifyObjectAttributes += OnAttributes;
        RhinoDoc.SelectObjects += OnSelect;
        RhinoDoc.DeselectObjects += OnDeselect;
        RhinoDoc.DeselectAllObjects += OnDeselectAll;
        RhinoDoc.EndOpenDocument += OnOpened;
        RhinoDoc.CloseDocument += OnClosed;
        RhinoDoc.ActiveDocumentChanged += OnActiveChanged;
    }

    /// <summary>
    /// Stop observing.
    /// </summary>
    /// <remarks>
    /// Not optional. These are static events on <see cref="RhinoDoc"/>, so a
    /// handler that is never removed outlives the bridge it belongs to, keeps
    /// the whole object graph alive, and goes on publishing into a server that
    /// has been stopped — for as long as Rhino stays open.
    /// </remarks>
    public void Unsubscribe()
    {
        if (Interlocked.Exchange(ref _subscribed, 0) != 1)
        {
            return;
        }

        RhinoDoc.AddRhinoObject -= OnAdd;
        RhinoDoc.DeleteRhinoObject -= OnDelete;
        RhinoDoc.ReplaceRhinoObject -= OnReplace;
        RhinoDoc.ModifyObjectAttributes -= OnAttributes;
        RhinoDoc.SelectObjects -= OnSelect;
        RhinoDoc.DeselectObjects -= OnDeselect;
        RhinoDoc.DeselectAllObjects -= OnDeselectAll;
        RhinoDoc.EndOpenDocument -= OnOpened;
        RhinoDoc.CloseDocument -= OnClosed;
        RhinoDoc.ActiveDocumentChanged -= OnActiveChanged;
    }

    public void Dispose() => Unsubscribe();

    // -- handlers -----------------------------------------------------------

    private void OnAdd(object? sender, RhinoObjectEventArgs args) => Publish(
        EventKind.ObjectAdded, args.TheObject?.Document, () => new
        {
            object_id = args.ObjectId,
            object_type = args.TheObject?.ObjectType.ToString(),
        });

    private void OnDelete(object? sender, RhinoObjectEventArgs args) => Publish(
        EventKind.ObjectDeleted, args.TheObject?.Document, () => new
        {
            object_id = args.ObjectId,
        });

    private void OnReplace(object? sender, RhinoReplaceObjectEventArgs args) => Publish(
        EventKind.ObjectReplaced, args.Document, () => new
        {
            object_id = args.ObjectId,
        });

    private void OnAttributes(object? sender, RhinoModifyObjectAttributesEventArgs args) => Publish(
        EventKind.ObjectAttributesChanged, args.Document, () => new
        {
            object_id = args.RhinoObject?.Id,
        });

    private void OnSelect(object? sender, RhinoObjectSelectionEventArgs args) => Publish(
        EventKind.SelectionChanged, args.Document, () => new
        {
            selected = true,
            count = args.RhinoObjects?.Length ?? 0,
        });

    private void OnDeselect(object? sender, RhinoObjectSelectionEventArgs args) => Publish(
        EventKind.SelectionChanged, args.Document, () => new
        {
            selected = false,
            count = args.RhinoObjects?.Length ?? 0,
        });

    private void OnDeselectAll(object? sender, RhinoDeselectAllObjectsEventArgs args) => Publish(
        EventKind.SelectionChanged, args.Document, () => new
        {
            selected = false,
            count = args.ObjectCount,
        });

    private void OnOpened(object? sender, DocumentOpenEventArgs args) => Publish(
        EventKind.DocumentOpened, args.Document, () => new
        {
            // Reported for a person to read. Never an identity: the runtime
            // serial on the session ref is what addresses this document.
            name = args.Document?.Name,
        });

    private void OnClosed(object? sender, DocumentEventArgs args) => Publish(
        EventKind.DocumentClosed, args.Document, () => new
        {
            document_runtime_serial = args.DocumentSerialNumber,
        });

    private void OnActiveChanged(object? sender, DocumentEventArgs args) => Publish(
        EventKind.ActiveDocumentChanged, args.Document, () => new
        {
            document_runtime_serial = args.DocumentSerialNumber,
        });

    // -- publication --------------------------------------------------------

    private void Publish(EventKind kind, RhinoDoc? document, Func<object> data)
    {
        try
        {
            uint? serial = document?.RuntimeSerialNumber;

            // The envelope is built per connection, because the transport
            // stamps `dropped_before` onto it and one slow client must not
            // change what another is told. The data payload is shared: it is
            // immutable once serialized.
            JsonElement payload = JsonSerializer.SerializeToElement(data(), WireJson.Options);
            long id = Interlocked.Increment(ref _sequence);
            ulong emitted = (ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            _server.Publish(() => new EventEnvelope
            {
                EventId = $"evt-{id:00000000}",
                Kind = kind,
                Session = new RhinoSessionRef
                {
                    RhinoInstanceId = _identity.InstanceId,
                    ProcessId = _identity.ProcessId,
                    SessionId = _identity.SessionId,
                    DocumentRuntimeSerial = serial,
                },
                EmittedAtUnixMs = emitted,
                Data = payload,
            });
        }
        catch (Exception error)
        {
            // Swallowed on purpose. This runs inside Rhino's own edit loop; an
            // exception escaping here would surface to the user as their edit
            // failing, because HII could not describe it.
            _log.Warn($"an HII Rhino observation ({kind}) could not be published", error);
        }
    }
}
