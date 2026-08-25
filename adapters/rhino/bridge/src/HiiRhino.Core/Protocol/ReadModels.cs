using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

// The shapes the read operations return. They live here rather than beside the
// operations so that their serialization is testable without Rhino, and so the
// Rust facade has one place to mirror when it starts reading them.

/// <summary>An axis-aligned bounding box, reported in document units and in millimetres.</summary>
/// <remarks>
/// Both, deliberately. Verification asks questions like "is this 40 mm across",
/// and answering that from document units alone requires the caller to know the
/// document's unit system and apply the conversion itself — which is exactly the
/// sort of arithmetic that silently produces a box 40 inches wide.
/// </remarks>
public sealed class BoundingBoxReport
{
    [JsonPropertyName("min")] public double[] Min { get; set; } = new double[3];
    [JsonPropertyName("max")] public double[] Max { get; set; } = new double[3];
    [JsonPropertyName("size")] public double[] Size { get; set; } = new double[3];
    [JsonPropertyName("size_mm")] public double[] SizeMillimetres { get; set; } = new double[3];
    [JsonPropertyName("centre")] public double[] Centre { get; set; } = new double[3];
    [JsonPropertyName("is_valid")] public bool IsValid { get; set; }
}

/// <summary>One layer, enough to identify it and say whether it is usable.</summary>
public sealed class LayerSummary
{
    [JsonPropertyName("index")] public int Index { get; set; }
    [JsonPropertyName("id")] public Guid Id { get; set; }
    [JsonPropertyName("full_path")] public string FullPath { get; set; } = "";
    [JsonPropertyName("is_visible")] public bool IsVisible { get; set; }
    [JsonPropertyName("is_locked")] public bool IsLocked { get; set; }
}

/// <summary>One open document, as seen from the session level.</summary>
public sealed class DocumentSummary
{
    [JsonPropertyName("document_runtime_serial")] public uint DocumentRuntimeSerial { get; set; }

    /// <summary>
    /// The file name, when there is one. Reported for a person to read and never
    /// used to identify anything.
    /// </summary>
    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; set; }

    [JsonPropertyName("path")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Path { get; set; }

    [JsonPropertyName("unit_system")] public string UnitSystem { get; set; } = "";

    /// <summary>How many millimetres one document unit is.</summary>
    [JsonPropertyName("millimetres_per_unit")] public double MillimetresPerUnit { get; set; }

    [JsonPropertyName("is_active")] public bool IsActive { get; set; }
    [JsonPropertyName("is_modified")] public bool IsModified { get; set; }
    [JsonPropertyName("object_count")] public int ObjectCount { get; set; }
    [JsonPropertyName("layer_count")] public int LayerCount { get; set; }
}

/// <summary>What this Rhino instance currently has open.</summary>
public sealed class SessionReport
{
    [JsonPropertyName("rhino_instance_id")] public Guid RhinoInstanceId { get; set; }
    [JsonPropertyName("process_id")] public uint ProcessId { get; set; }
    [JsonPropertyName("session_id")] public uint SessionId { get; set; }
    [JsonPropertyName("application_version")] public string ApplicationVersion { get; set; } = "";
    [JsonPropertyName("adapter_version")] public string AdapterVersion { get; set; } = "";
    [JsonPropertyName("documents")] public List<DocumentSummary> Documents { get; set; } = new();
}

/// <summary>A document in more detail than the session listing gives.</summary>
public sealed class DocumentDescription
{
    [JsonPropertyName("document")] public DocumentSummary Document { get; set; } = new();
    [JsonPropertyName("absolute_tolerance")] public double AbsoluteTolerance { get; set; }
    [JsonPropertyName("angle_tolerance_degrees")] public double AngleToleranceDegrees { get; set; }
    [JsonPropertyName("layers")] public List<LayerSummary> Layers { get; set; } = new();

    [JsonPropertyName("bounding_box")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BoundingBoxReport? BoundingBox { get; set; }
}

/// <summary>One object in a document.</summary>
/// <remarks>
/// <c>object_id</c> is the identity; <c>runtime_serial</c> is an advisory change
/// stamp. A caller that sees the same GUID with a different serial is looking at
/// an object that has been replaced since it last looked.
/// </remarks>
public sealed class ObjectSummary
{
    [JsonPropertyName("object_id")] public Guid ObjectId { get; set; }
    [JsonPropertyName("runtime_serial")] public uint RuntimeSerial { get; set; }
    [JsonPropertyName("object_type")] public string ObjectType { get; set; } = "";

    /// <summary>
    /// The geometry's own type, which is finer than <c>object_type</c>: a Brep
    /// that happens to be a box is still an ObjectType.Brep.
    /// </summary>
    [JsonPropertyName("geometry_type")] public string GeometryType { get; set; } = "";

    [JsonPropertyName("layer")] public string Layer { get; set; } = "";

    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; set; }

    [JsonPropertyName("is_selected")] public bool IsSelected { get; set; }
    [JsonPropertyName("is_visible")] public bool IsVisible { get; set; }

    [JsonPropertyName("bounding_box")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public BoundingBoxReport? BoundingBox { get; set; }
}

/// <summary>A page of objects from one document.</summary>
/// <remarks>
/// Paged because enumeration runs on Rhino's UI thread and a document with a
/// hundred thousand objects would otherwise freeze Rhino for as long as it takes
/// to describe them all, and then put the result over an 8 MiB message cap.
/// </remarks>
public sealed class ObjectPage
{
    [JsonPropertyName("document_runtime_serial")] public uint DocumentRuntimeSerial { get; set; }
    [JsonPropertyName("total")] public int Total { get; set; }
    [JsonPropertyName("offset")] public int Offset { get; set; }
    [JsonPropertyName("objects")] public List<ObjectSummary> Objects { get; set; } = new();

    /// <summary>True when more objects exist beyond this page.</summary>
    [JsonPropertyName("has_more")] public bool HasMore { get; set; }
}
