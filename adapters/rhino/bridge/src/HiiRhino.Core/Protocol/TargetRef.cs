using System;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

/// <summary>
/// What a request is addressed to. Mirrors <c>hii_rhino_protocol::TargetRef</c>.
/// </summary>
/// <remarks>
/// <para>
/// Nothing here identifies state by filename, window title, or "the active
/// document". A workstation can run several Rhino processes each with several
/// open documents, and acting on the wrong one is the failure this type exists
/// to make impossible.
/// </para>
/// <para>
/// serde tags this union internally, so <c>kind</c> sits alongside the
/// variant's own fields rather than wrapping them. The converter below mirrors
/// that exactly, including field order, because the golden fixtures are
/// compared byte for byte.
/// </para>
/// </remarks>
[JsonConverter(typeof(TargetRefConverter))]
public abstract class TargetRef
{
    /// <summary>The discriminator this variant writes.</summary>
    public abstract string Kind { get; }
}

/// <summary>A whole Rhino instance, with no particular document in mind.</summary>
public sealed class InstanceTarget : TargetRef
{
    public override string Kind => "instance";

    public Guid RhinoInstanceId { get; set; }
}

/// <summary>One open document inside one Rhino instance.</summary>
/// <remarks>
/// The runtime serial does not survive a Rhino restart, which is why it is
/// always paired with the instance id. A serial alone would silently mean a
/// different document after a restart.
/// </remarks>
public sealed class DocumentTarget : TargetRef
{
    public override string Kind => "document";

    public Guid RhinoInstanceId { get; set; }
    public uint DocumentRuntimeSerial { get; set; }
}

/// <summary>
/// A Grasshopper document. Mirrored so the union parses completely; no
/// Grasshopper operation exists yet, and an operation addressed to one is
/// refused like any other unimplemented operation.
/// </summary>
public sealed class GrasshopperDocumentTarget : TargetRef
{
    public override string Kind => "grasshopper_document";

    public Guid RhinoInstanceId { get; set; }
    public uint? RhinoDocumentRuntimeSerial { get; set; }
    public Guid GhRuntimeId { get; set; }
}

public sealed class TargetRefConverter : JsonConverter<TargetRef>
{
    public override TargetRef Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        using JsonDocument document = JsonDocument.ParseValue(ref reader);
        JsonElement root = document.RootElement;

        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new JsonException("a target must be an object");
        }
        if (!root.TryGetProperty("kind", out JsonElement kind) || kind.ValueKind != JsonValueKind.String)
        {
            throw new JsonException("a target must carry a string 'kind'");
        }

        return kind.GetString() switch
        {
            "instance" => new InstanceTarget
            {
                RhinoInstanceId = Guid(root, "rhino_instance_id"),
            },
            "document" => new DocumentTarget
            {
                RhinoInstanceId = Guid(root, "rhino_instance_id"),
                DocumentRuntimeSerial = UInt32(root, "document_runtime_serial"),
            },
            "grasshopper_document" => new GrasshopperDocumentTarget
            {
                RhinoInstanceId = Guid(root, "rhino_instance_id"),
                RhinoDocumentRuntimeSerial = root.TryGetProperty("rhino_document_runtime_serial", out JsonElement serial)
                    && serial.ValueKind == JsonValueKind.Number
                        ? serial.GetUInt32()
                        : null,
                GhRuntimeId = Guid(root, "gh_runtime_id"),
            },
            // Refused rather than defaulted. An unrecognised target means the
            // facade is newer than this bridge, and quietly acting on a target
            // we do not understand is how the wrong document gets edited.
            string other => throw new JsonException($"'{other}' is not a target kind this bridge knows"),
            null => throw new JsonException("a target must carry a string 'kind'"),
        };
    }

    public override void Write(Utf8JsonWriter writer, TargetRef value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        writer.WriteString("kind", value.Kind);

        switch (value)
        {
            case InstanceTarget instance:
                writer.WriteString("rhino_instance_id", instance.RhinoInstanceId);
                break;

            case DocumentTarget target:
                writer.WriteString("rhino_instance_id", target.RhinoInstanceId);
                writer.WriteNumber("document_runtime_serial", target.DocumentRuntimeSerial);
                break;

            case GrasshopperDocumentTarget grasshopper:
                writer.WriteString("rhino_instance_id", grasshopper.RhinoInstanceId);
                if (grasshopper.RhinoDocumentRuntimeSerial is { } serial)
                {
                    writer.WriteNumber("rhino_document_runtime_serial", serial);
                }
                writer.WriteString("gh_runtime_id", grasshopper.GhRuntimeId);
                break;

            default:
                throw new JsonException($"{value.GetType().Name} is not a target this bridge can write");
        }

        writer.WriteEndObject();
    }

    private static Guid Guid(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) && value.TryGetGuid(out Guid parsed)
            ? parsed
            : throw new JsonException($"a target of this kind needs a '{name}' guid");

    private static uint UInt32(JsonElement root, string name) =>
        root.TryGetProperty(name, out JsonElement value) && value.TryGetUInt32(out uint parsed)
            ? parsed
            : throw new JsonException($"a target of this kind needs a numeric '{name}'");
}
