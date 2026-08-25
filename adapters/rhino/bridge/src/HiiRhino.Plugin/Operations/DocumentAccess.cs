using System;
using System.Text.Json;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using Rhino;
using Rhino.DocObjects;
using Rhino.Geometry;

namespace HiiRhino.Plugin.Operations;

/// <summary>
/// Turning a request's target into a real Rhino document, and Rhino's types into
/// the shapes the protocol describes.
/// </summary>
/// <remarks>
/// Everything here runs on the UI thread, called from inside a dispatched
/// operation. Nothing here mutates anything.
/// </remarks>
internal static class DocumentAccess
{
    /// <summary>
    /// Resolve the document a request is addressed to.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A missing target is refused rather than resolved to
    /// <c>RhinoDoc.ActiveDoc</c>. That is the whole point of carrying identity:
    /// a workstation can have several documents open, "active" changes when the
    /// user clicks somewhere, and a request that silently retargets is a request
    /// that edits the wrong file. Callers discover a runtime serial from
    /// <c>rhino.session.describe</c> first.
    /// </para>
    /// <para>
    /// The instance id is checked too. A runtime serial from a Rhino that has
    /// since restarted may well match a different document in this one, and
    /// acting on it would be silently wrong in the worst possible way.
    /// </para>
    /// </remarks>
    public static RhinoDoc RequireDocument(RequestEnvelope request, Guid expectedInstance)
    {
        if (request.Target is null)
        {
            throw new OperationFailedException(
                ErrorCode.InvalidArguments,
                "this operation must name the document it applies to; "
                    + "call rhino.session.describe to discover the open documents and their runtime serials");
        }

        if (request.Target is not DocumentTarget target)
        {
            throw new OperationFailedException(
                ErrorCode.InvalidArguments,
                $"this operation needs a document target, not a '{request.Target.Kind}' one");
        }

        if (target.RhinoInstanceId != expectedInstance)
        {
            throw new OperationFailedException(
                ErrorCode.StaleReference,
                $"that reference belongs to Rhino instance {target.RhinoInstanceId:D}; "
                    + $"this is instance {expectedInstance:D}, so its runtime serials mean nothing here");
        }

        RhinoDoc? document = RhinoDoc.FromRuntimeSerialNumber(target.DocumentRuntimeSerial);
        if (document is null)
        {
            throw new OperationFailedException(
                ErrorCode.DocumentNotFound,
                $"no open document has runtime serial {target.DocumentRuntimeSerial}; it was probably closed");
        }

        return document;
    }

    /// <summary>How many millimetres one document unit is.</summary>
    public static double MillimetresPerUnit(RhinoDoc document) =>
        RhinoMath.UnitScale(document.ModelUnitSystem, UnitSystem.Millimeters);

    public static DocumentSummary Summarise(RhinoDoc document) => new()
    {
        DocumentRuntimeSerial = document.RuntimeSerialNumber,
        Name = string.IsNullOrEmpty(document.Name) ? null : document.Name,
        Path = string.IsNullOrEmpty(document.Path) ? null : document.Path,
        UnitSystem = document.ModelUnitSystem.ToString(),
        MillimetresPerUnit = MillimetresPerUnit(document),
        IsActive = RhinoDoc.ActiveDoc is { } active && active.RuntimeSerialNumber == document.RuntimeSerialNumber,
        IsModified = document.Modified,
        ObjectCount = document.Objects.Count,
        LayerCount = document.Layers.Count,
    };

    public static BoundingBoxReport? Describe(BoundingBox box, double millimetresPerUnit)
    {
        if (!box.IsValid)
        {
            // A degenerate box is reported as invalid rather than as zeros. Zeros
            // are a plausible-looking answer that verification would happily
            // compare against and get wrong.
            return new BoundingBoxReport { IsValid = false };
        }

        Point3d min = box.Min;
        Point3d max = box.Max;
        Point3d centre = box.Center;
        double[] size = { max.X - min.X, max.Y - min.Y, max.Z - min.Z };

        return new BoundingBoxReport
        {
            Min = new[] { min.X, min.Y, min.Z },
            Max = new[] { max.X, max.Y, max.Z },
            Size = size,
            SizeMillimetres = new[]
            {
                size[0] * millimetresPerUnit,
                size[1] * millimetresPerUnit,
                size[2] * millimetresPerUnit,
            },
            Centre = new[] { centre.X, centre.Y, centre.Z },
            IsValid = true,
        };
    }

    public static ObjectSummary Summarise(RhinoObject rhinoObject, RhinoDoc document, bool includeBoundingBox)
    {
        Layer layer = document.Layers[rhinoObject.Attributes.LayerIndex];

        var summary = new ObjectSummary
        {
            ObjectId = rhinoObject.Id,
            RuntimeSerial = rhinoObject.RuntimeSerialNumber,
            ObjectType = rhinoObject.ObjectType.ToString(),
            GeometryType = rhinoObject.Geometry?.GetType().Name ?? "unknown",
            Layer = layer.FullPath,
            Name = string.IsNullOrEmpty(rhinoObject.Attributes.Name) ? null : rhinoObject.Attributes.Name,
            IsSelected = rhinoObject.IsSelected(checkSubObjects: false) != 0,
            IsVisible = rhinoObject.Visible,
        };

        if (includeBoundingBox && rhinoObject.Geometry is not null)
        {
            summary.BoundingBox = Describe(
                rhinoObject.Geometry.GetBoundingBox(accurate: true),
                MillimetresPerUnit(document));
        }

        return summary;
    }

    public static LayerSummary Summarise(Layer layer) => new()
    {
        Index = layer.Index,
        Id = layer.Id,
        FullPath = layer.FullPath,
        IsVisible = layer.IsVisible,
        IsLocked = layer.IsLocked,
    };

    // -- argument helpers ---------------------------------------------------

    public static JsonElement? Argument(RequestEnvelope request, string name)
    {
        if (request.Arguments is not { ValueKind: JsonValueKind.Object } arguments)
        {
            return null;
        }
        return arguments.TryGetProperty(name, out JsonElement value) ? value : null;
    }

    public static Guid RequireGuid(RequestEnvelope request, string name)
    {
        JsonElement? value = Argument(request, name);
        if (value is null || value.Value.ValueKind != JsonValueKind.String
            || !Guid.TryParse(value.Value.GetString(), out Guid parsed))
        {
            throw new OperationFailedException(
                ErrorCode.InvalidArguments,
                $"'{name}' must be an object id in GUID form");
        }
        return parsed;
    }

    public static int OptionalInt(RequestEnvelope request, string name, int fallback)
    {
        JsonElement? value = Argument(request, name);
        return value is { ValueKind: JsonValueKind.Number } number && number.TryGetInt32(out int parsed)
            ? parsed
            : fallback;
    }

    public static bool OptionalBool(RequestEnvelope request, string name, bool fallback)
    {
        JsonElement? value = Argument(request, name);
        return value?.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => fallback,
        };
    }
}
