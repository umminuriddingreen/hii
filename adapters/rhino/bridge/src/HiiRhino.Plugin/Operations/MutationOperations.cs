using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace HiiRhino.Plugin.Operations;

/// <summary>
/// Checkpoint F: the first operations that change a document.
/// </summary>
/// <remarks>
/// <para>
/// Every mutation here is wrapped in one Rhino undo record, so one HII action is
/// one thing the user can undo. Not several, and not none. There is no parallel
/// undo engine: Rhino's own is the only one, and anything HII does has to live
/// inside it or the user's Ctrl+Z stops meaning what they expect.
/// </para>
/// <para>
/// What these return is <em>evidence</em>, not proof. A GUID and a "success"
/// mean the API did not throw. Whether a 40 mm box actually exists, is 40 mm,
/// and is where it was asked for is settled by reading the document back
/// afterwards through the checkpoint E operations — which is why verification
/// lives in the facade and not here. A bridge that graded its own work would
/// only ever be as trustworthy as the call it just made.
/// </para>
/// </remarks>
internal static class MutationOperations
{
    public static IReadOnlyList<INativeOperation> All(BridgeIdentity identity) => new INativeOperation[]
    {
        new CreateObject(identity),
        new DeleteObject(identity),
        new Undo(identity),
    };

    /// <summary>The feature flags these operations justify advertising.</summary>
    public static IReadOnlyList<string> Features => new[] { "rhino.mutate", "rhino.undo" };

    private abstract class MutationOperation : INativeOperation
    {
        protected MutationOperation(BridgeIdentity identity) => Identity = identity;

        protected BridgeIdentity Identity { get; }

        public abstract string Name { get; }

        public abstract object Execute(RequestEnvelope request, CancellationToken cancellationToken);

        /// <summary>
        /// Run <paramref name="work"/> inside exactly one undo record.
        /// </summary>
        /// <remarks>
        /// The record is closed in a finally: a mutation that throws half-way
        /// must still leave a closed record, or Rhino is left with an open one
        /// and the next undo swallows whatever the user does next.
        /// </remarks>
        protected static T InOneUndoRecord<T>(RhinoDoc document, string description, Func<uint, T> work)
        {
            uint record = document.BeginUndoRecord(description);
            if (record == 0)
            {
                // Rhino refuses to open a record when undo is disabled or one is
                // already open. Going ahead anyway would produce a change the
                // user cannot reverse, which is worse than not doing it.
                throw new OperationFailedException(
                    ErrorCode.UndoFailed,
                    "Rhino would not open an undo record, so this change was not made");
            }

            try
            {
                return work(record);
            }
            finally
            {
                document.EndUndoRecord(record);
            }
        }
    }

    /// <summary>
    /// Create one primitive.
    /// </summary>
    /// <remarks>
    /// Typed arguments, not a script. <c>kind</c> names a primitive this bridge
    /// knows how to build and verify; anything else is refused rather than
    /// approximated.
    /// </remarks>
    private sealed class CreateObject : MutationOperation
    {
        public CreateObject(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.object.create";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);

            string kind = DocumentAccess.Argument(request, "kind")?.GetString()
                ?? throw new OperationFailedException(
                    ErrorCode.InvalidArguments, "'kind' must name the primitive to create");

            return kind switch
            {
                "box" => CreateBox(document, request),
                _ => throw new OperationFailedException(
                    ErrorCode.InvalidArguments,
                    $"'{kind}' is not a primitive this bridge can create; it knows: box"),
            };
        }

        private static Dictionary<string, object?> CreateBox(RhinoDoc document, RequestEnvelope request)
        {
            double millimetresPerUnit = DocumentAccess.MillimetresPerUnit(document);
            if (millimetresPerUnit <= 0)
            {
                throw new OperationFailedException(
                    ErrorCode.InvalidNativeState,
                    $"document units ({document.ModelUnitSystem}) do not convert to millimetres, "
                        + "so a size in millimetres cannot be honoured");
            }

            double[] sizeMm = BoxSizeMillimetres(request);
            double[] origin = Origin(request);
            string anchor = DocumentAccess.Argument(request, "anchor")?.GetString() ?? "corner";

            // Everything is asked for in millimetres and built in document
            // units. Doing this conversion in one place, once, is the whole
            // defence against a box that is 40 of the wrong thing.
            double[] sizeUnits =
            {
                sizeMm[0] / millimetresPerUnit,
                sizeMm[1] / millimetresPerUnit,
                sizeMm[2] / millimetresPerUnit,
            };

            var from = new Point3d(origin[0], origin[1], origin[2]);
            Point3d min, max;
            switch (anchor)
            {
                case "corner":
                    min = from;
                    max = new Point3d(from.X + sizeUnits[0], from.Y + sizeUnits[1], from.Z + sizeUnits[2]);
                    break;

                case "centre":
                case "center":
                    min = new Point3d(
                        from.X - sizeUnits[0] / 2, from.Y - sizeUnits[1] / 2, from.Z - sizeUnits[2] / 2);
                    max = new Point3d(
                        from.X + sizeUnits[0] / 2, from.Y + sizeUnits[1] / 2, from.Z + sizeUnits[2] / 2);
                    break;

                default:
                    throw new OperationFailedException(
                        ErrorCode.InvalidArguments,
                        $"'anchor' must be 'corner' or 'centre', not '{anchor}'");
            }

            var box = new BoundingBox(min, max);
            Brep? brep = Brep.CreateFromBox(box);
            if (brep is null || !brep.IsValid)
            {
                throw new OperationFailedException(
                    ErrorCode.NativeOperationFailed,
                    "Rhino could not build a valid box from those dimensions");
            }

            Guid created = InOneUndoRecord(document, "HII Rhino: create box", _ =>
            {
                Guid id = document.Objects.AddBrep(brep);
                if (id == Guid.Empty)
                {
                    throw new OperationFailedException(
                        ErrorCode.NativeOperationFailed,
                        "Rhino accepted the geometry but returned no object id");
                }
                return id;
            });

            document.Views.Redraw();

            RhinoObject? added = document.Objects.FindId(created);

            return new Dictionary<string, object?>
            {
                ["object_id"] = created,
                ["document_runtime_serial"] = document.RuntimeSerialNumber,
                ["runtime_serial"] = added?.RuntimeSerialNumber,
                // Echoed back so verification compares against what was actually
                // built rather than against what it believes it asked for.
                ["kind"] = "box",
                ["anchor"] = anchor,
                ["requested_size_mm"] = sizeMm,
                ["millimetres_per_unit"] = millimetresPerUnit,
                ["unit_system"] = document.ModelUnitSystem.ToString(),
            };
        }

        private static double[] BoxSizeMillimetres(RequestEnvelope request)
        {
            JsonElement? single = DocumentAccess.Argument(request, "size_mm");
            if (single is { ValueKind: JsonValueKind.Number } cube)
            {
                double side = cube.GetDouble();
                return new[] { side, side, side };
            }

            if (single is { ValueKind: JsonValueKind.Array } array)
            {
                double[] sides = Numbers(array, "size_mm", 3);
                return sides;
            }

            var explicitSides = new double[3];
            string[] names = { "width_mm", "depth_mm", "height_mm" };
            for (int index = 0; index < names.Length; index++)
            {
                JsonElement? value = DocumentAccess.Argument(request, names[index]);
                if (value is not { ValueKind: JsonValueKind.Number } number)
                {
                    throw new OperationFailedException(
                        ErrorCode.InvalidArguments,
                        "a box needs 'size_mm' (a number or three numbers), "
                            + "or all of 'width_mm', 'depth_mm' and 'height_mm'");
                }
                explicitSides[index] = number.GetDouble();
            }
            return explicitSides;
        }

        private static double[] Origin(RequestEnvelope request)
        {
            JsonElement? value = DocumentAccess.Argument(request, "origin");
            if (value is null)
            {
                return new double[] { 0, 0, 0 };
            }
            if (value.Value.ValueKind != JsonValueKind.Array)
            {
                throw new OperationFailedException(
                    ErrorCode.InvalidArguments, "'origin' must be three numbers");
            }
            return Numbers(value.Value, "origin", 3);
        }

        private static double[] Numbers(JsonElement array, string name, int expected)
        {
            var values = new List<double>();
            foreach (JsonElement element in array.EnumerateArray())
            {
                if (element.ValueKind != JsonValueKind.Number)
                {
                    throw new OperationFailedException(
                        ErrorCode.InvalidArguments, $"'{name}' must contain only numbers");
                }
                values.Add(element.GetDouble());
            }

            if (values.Count != expected)
            {
                throw new OperationFailedException(
                    ErrorCode.InvalidArguments,
                    $"'{name}' must have exactly {expected} numbers, not {values.Count}");
            }

            foreach (double value in values)
            {
                if (double.IsNaN(value) || double.IsInfinity(value))
                {
                    throw new OperationFailedException(
                        ErrorCode.InvalidArguments, $"'{name}' contains a value that is not a real number");
                }
            }

            return values.ToArray();
        }
    }

    /// <summary>Delete one object by id.</summary>
    private sealed class DeleteObject : MutationOperation
    {
        public DeleteObject(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.object.delete";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);
            Guid objectId = DocumentAccess.RequireGuid(request, "object_id");

            if (document.Objects.FindId(objectId) is null)
            {
                throw new OperationFailedException(
                    ErrorCode.ObjectNotFound,
                    $"no object {objectId:D} in document {document.RuntimeSerialNumber}");
            }

            bool deleted = InOneUndoRecord(document, "HII Rhino: delete object",
                _ => document.Objects.Delete(objectId, quiet: true));

            if (!deleted)
            {
                throw new OperationFailedException(
                    ErrorCode.NativeOperationFailed,
                    $"Rhino refused to delete {objectId:D}; it may be locked or on a locked layer");
            }

            document.Views.Redraw();

            return new Dictionary<string, object?>
            {
                ["object_id"] = objectId,
                ["document_runtime_serial"] = document.RuntimeSerialNumber,
            };
        }
    }

    /// <summary>
    /// Undo the most recent undo record.
    /// </summary>
    /// <remarks>
    /// Rhino's own undo, deliberately. It reverses whatever is on top of the
    /// stack, which is not necessarily an HII action — the user may have drawn
    /// something since. The response reports what Rhino said it undid so the
    /// caller can check rather than assume; verifying that the intended change
    /// is actually gone is a separate independent read.
    /// </remarks>
    private sealed class Undo : MutationOperation
    {
        public Undo(BridgeIdentity identity) : base(identity) { }

        public override string Name => "rhino.undo";

        public override object Execute(RequestEnvelope request, CancellationToken cancellationToken)
        {
            RhinoDoc document = DocumentAccess.RequireDocument(request, Identity.InstanceId);

            // RhinoCommon 8 exposes no way to read the name of the record that
            // is about to be undone — checked against the installed SDK rather
            // than assumed. So there is nothing to report about *what* was
            // undone, and the caller must confirm the effect by reading the
            // document back. Which it should be doing regardless.
            //
            // There is deliberately no pre-flight "is there anything to undo"
            // guard. RhinoDoc.UndoActive reads as though it were one, but the
            // installed SDK documents it as "Undo is currently active" and it
            // is observably false immediately after a change this bridge just
            // recorded — it reports that an undo is *in progress*, not that one
            // is available. Asking Rhino to undo and reporting what it says is
            // the only answer that is actually true.
            int before = document.Objects.Count;
            bool undone = document.Undo();
            document.Views.Redraw();

            if (!undone)
            {
                throw new OperationFailedException(
                    ErrorCode.UndoFailed,
                    "Rhino would not undo; there may be nothing left to undo");
            }

            return new Dictionary<string, object?>
            {
                ["document_runtime_serial"] = document.RuntimeSerialNumber,
                ["object_count_before"] = before,
                ["object_count"] = document.Objects.Count,
            };
        }
    }
}
