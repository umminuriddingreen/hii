using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace HiiRhino.Plugin.Operations;

/// <summary>
/// Checkpoint E: everything HII can learn about a Rhino document without
/// changing it.
/// </summary>
/// <remarks>
/// Nothing in this file mutates a document, opens one, closes one, or changes
/// what is selected. Reads also never force a recomputation — they describe what
/// is there, and if what is there is stale that is a fact about the document,
/// not something to fix behind the caller's back.
/// </remarks>
internal static class ReadOperations
{
    /// <summary>How many objects one page returns unless asked otherwise.</summary>
    private const int DefaultPageSize = 200;

    /// <summary>
    /// The ceiling on a page.
    /// </summary>
    /// <remarks>
    /// Enumeration runs on Rhino's UI thread and every object is serialized into
    /// one message. Without a cap, a request against a large document freezes
    /// Rhino for as long as the description takes and then produces a frame over
    /// the 8 MiB protocol limit, which the facade is obliged to refuse — so the
    /// freeze buys nothing at all.
    /// </remarks>
    private const int MaximumPageSize = 2000;

    public static IReadOnlyList<INativeOperation> All(BridgeIdentity identity) => new INativeOperation[]
    {
        new SessionDescribe(identity),
        new DocumentDescribe(identity),
        new DocumentObjects(identity),
        new ObjectGet(identity),
        new GeometryBoundingBox(identity),
    };

    /// <summary>The feature flags these operations justify advertising.</summary>
    public static IReadOnlyList<string> Features => new[] { "rhino.session", "rhino.document", "rhino.geometry" };

    private abstract class ReadOperation : INativeOperation
    {
        protected ReadOperation(BridgeIdentity identity) => Identity = identity;

        protected BridgeIdentity Identity { get; }

        public abstract string Name { get; }

        public abstract object Execute(RequestEnvelope request, CancellationToken cancellationToken);
    }

    /// <summary>
    /// What this Rhino has open. The entry point: every other operation needs a
    /// document runtime serial, and this is where one legitimately comes from.
    /// </summary>
    private sealed class SessionDescribe : ReadOperation
    {
        public SessionDescribe(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.session.describe";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken) => new SessionReport
        {
            RhinoInstanceId = Identity.InstanceId,
            ProcessId = Identity.ProcessId,
            SessionId = Identity.SessionId,
            ApplicationVersion = Identity.ApplicationVersion,
            AdapterVersion = Identity.AdapterVersion,
            Documents = RhinoDoc.OpenDocuments()
                .Select(DocumentAccess.Summarise)
                .ToList(),
        };
    }

    /// <summary>One document in detail: units, tolerances, layers.</summary>
    private sealed class DocumentDescribe : ReadOperation
    {
        public DocumentDescribe(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.document.describe";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);

            var description = new DocumentDescription
            {
                Document = DocumentAccess.Summarise(document),
                AbsoluteTolerance = document.ModelAbsoluteTolerance,
                AngleToleranceDegrees = document.ModelAngleToleranceDegrees,
                Layers = document.Layers.Select(DocumentAccess.Summarise).ToList(),
            };

            // Off by default: the document bounding box costs a pass over every
            // object, on the UI thread, and most callers do not want it.
            if (DocumentAccess.OptionalBool(request, "include_bounding_box", false))
            {
                var union = BoundingBox.Empty;
                foreach (RhinoObject rhinoObject in document.Objects)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (rhinoObject.Geometry is { } geometry)
                    {
                        union.Union(geometry.GetBoundingBox(accurate: true));
                    }
                }
                description.BoundingBox = DocumentAccess.Describe(
                    union, DocumentAccess.MillimetresPerUnit(document));
            }

            return description;
        }
    }

    /// <summary>A page of the objects in a document.</summary>
    private sealed class DocumentObjects : ReadOperation
    {
        public DocumentObjects(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.document.objects";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);

            int offset = Math.Max(0, DocumentAccess.OptionalInt(request, "offset", 0));
            int limit = Math.Clamp(
                DocumentAccess.OptionalInt(request, "limit", DefaultPageSize), 1, MaximumPageSize);
            bool withBoxes = DocumentAccess.OptionalBool(request, "include_bounding_box", false);

            // Normal objects only, and deleted ones excluded: a deleted object is
            // still in the table until the undo record is purged, and reporting
            // one as present would be a lie that verification would believe.
            var settings = new ObjectEnumeratorSettings
            {
                IncludeLights = false,
                IncludeGrips = false,
                DeletedObjects = false,
                HiddenObjects = true,
                LockedObjects = true,
                NormalObjects = true,
            };

            List<RhinoObject> all = document.Objects.GetObjectList(settings).ToList();

            var page = new ObjectPage
            {
                DocumentRuntimeSerial = document.RuntimeSerialNumber,
                Total = all.Count,
                Offset = offset,
            };

            foreach (RhinoObject rhinoObject in all.Skip(offset).Take(limit))
            {
                cancellationToken.ThrowIfCancellationRequested();
                page.Objects.Add(DocumentAccess.Summarise(rhinoObject, document, withBoxes));
            }

            page.HasMore = offset + page.Objects.Count < all.Count;
            return page;
        }
    }

    /// <summary>One object, by the GUID that identifies it.</summary>
    private sealed class ObjectGet : ReadOperation
    {
        public ObjectGet(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.object.get";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);
            Guid objectId = DocumentAccess.RequireGuid(request, "object_id");

            RhinoObject? found = document.Objects.FindId(objectId);
            if (found is null)
            {
                // Typed, so the harness knows to re-read state rather than
                // retry the same lookup and get the same answer.
                throw new OperationFailedException(
                    ErrorCode.ObjectNotFound,
                    $"no object {objectId:D} in document {document.RuntimeSerialNumber}");
            }

            return DocumentAccess.Summarise(
                found,
                document,
                DocumentAccess.OptionalBool(request, "include_bounding_box", true));
        }
    }

    /// <summary>
    /// Bounding boxes for named objects.
    /// </summary>
    /// <remarks>
    /// Separate from <c>rhino.object.get</c> because this is the operation
    /// verification leans on: "is the thing that was just created actually 40 mm
    /// across" is answered here, from an independent read, and not from whatever
    /// the mutation claimed it did.
    /// </remarks>
    private sealed class GeometryBoundingBox : ReadOperation
    {
        public GeometryBoundingBox(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.geometry.bounding_box";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);
            double millimetresPerUnit = DocumentAccess.MillimetresPerUnit(document);

            List<Guid> ids = ObjectIds(request);
            var boxes = new Dictionary<string, BoundingBoxReport?>();
            var union = BoundingBox.Empty;

            foreach (Guid id in ids)
            {
                cancellationToken.ThrowIfCancellationRequested();

                RhinoObject? found = document.Objects.FindId(id);
                if (found?.Geometry is not { } geometry)
                {
                    // Recorded as missing rather than skipped. A caller asking
                    // about five objects and getting four answers should not
                    // have to work out which one went astray.
                    boxes[id.ToString("D")] = null;
                    continue;
                }

                BoundingBox box = geometry.GetBoundingBox(accurate: true);
                boxes[id.ToString("D")] = DocumentAccess.Describe(box, millimetresPerUnit);
                union.Union(box);
            }

            return new Dictionary<string, object?>
            {
                ["document_runtime_serial"] = document.RuntimeSerialNumber,
                ["millimetres_per_unit"] = millimetresPerUnit,
                ["boxes"] = boxes,
                ["union"] = DocumentAccess.Describe(union, millimetresPerUnit),
            };
        }

        private static List<Guid> ObjectIds(RequestEnvelope request)
        {
            System.Text.Json.JsonElement? value = DocumentAccess.Argument(request, "object_ids");
            if (value is not { ValueKind: System.Text.Json.JsonValueKind.Array } array)
            {
                // One id is also acceptable; asking for a box is common enough
                // that forcing a single-element array would be pure ceremony.
                return new List<Guid> { DocumentAccess.RequireGuid(request, "object_id") };
            }

            var ids = new List<Guid>();
            foreach (System.Text.Json.JsonElement element in array.EnumerateArray())
            {
                if (element.ValueKind != System.Text.Json.JsonValueKind.String
                    || !Guid.TryParse(element.GetString(), out Guid parsed))
                {
                    throw new OperationFailedException(
                        ErrorCode.InvalidArguments,
                        "'object_ids' must be an array of object ids in GUID form");
                }
                ids.Add(parsed);
            }

            if (ids.Count == 0)
            {
                throw new OperationFailedException(
                    ErrorCode.InvalidArguments,
                    "'object_ids' was empty; name at least one object");
            }

            return ids;
        }
    }
}
