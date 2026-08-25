using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

// Property declaration order is part of the contract here: it decides the key
// order System.Text.Json emits, and the golden fixtures are compared byte for
// byte against what serde produces. Reordering these properties is a wire
// change even though it does not look like one.

/// <summary>Mirrors <c>ApplicationInstance</c>.</summary>
public sealed class ApplicationInstance
{
    /// <summary>Always "rhino" today; the envelopes are deliberately reusable.</summary>
    [JsonPropertyName("application")] public string Application { get; set; } = "rhino";
    [JsonPropertyName("application_version")] public string ApplicationVersion { get; set; } = "";
    [JsonPropertyName("adapter_version")] public string AdapterVersion { get; set; } = "";
    [JsonPropertyName("process_id")] public uint ProcessId { get; set; }
    [JsonPropertyName("rhino_instance_id")] public Guid RhinoInstanceId { get; set; }
}

/// <summary>Mirrors <c>RhinoSessionRef</c>.</summary>
public sealed class RhinoSessionRef
{
    [JsonPropertyName("rhino_instance_id")] public Guid RhinoInstanceId { get; set; }
    [JsonPropertyName("process_id")] public uint ProcessId { get; set; }
    [JsonPropertyName("session_id")] public uint SessionId { get; set; }

    [JsonPropertyName("document_runtime_serial")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public uint? DocumentRuntimeSerial { get; set; }
}

/// <summary>
/// Mirrors <c>RhinoObjectRef</c>. The GUID is authoritative; the runtime serial
/// is an advisory change stamp and never a lookup key.
/// </summary>
public sealed class RhinoObjectRef
{
    [JsonPropertyName("rhino_instance_id")] public Guid RhinoInstanceId { get; set; }
    [JsonPropertyName("document_runtime_serial")] public uint DocumentRuntimeSerial { get; set; }
    [JsonPropertyName("object_id")] public Guid ObjectId { get; set; }

    [JsonPropertyName("runtime_serial")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public uint? RuntimeSerial { get; set; }
}

/// <summary>
/// Mirrors <c>MutationSummary</c>. Empty collections are represented as null so
/// that they are omitted, which is what serde skip_serializing_if does.
/// </summary>
public sealed class MutationSummary
{
    [JsonPropertyName("created")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RhinoObjectRef>? Created { get; set; }

    [JsonPropertyName("modified")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RhinoObjectRef>? Modified { get; set; }

    [JsonPropertyName("deleted")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<RhinoObjectRef>? Deleted { get; set; }

    [JsonPropertyName("native_undo_record")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public uint? NativeUndoRecord { get; set; }

    [JsonIgnore]
    public bool IsEmpty =>
        (Created is null || Created.Count == 0)
        && (Modified is null || Modified.Count == 0)
        && (Deleted is null || Deleted.Count == 0)
        && NativeUndoRecord is null;
}

/// <summary>What the facade sends: mirrors <c>ClientMessage::Handshake</c>.</summary>
public sealed class HandshakeRequest
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "handshake";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; }
    [JsonPropertyName("client")] public string Client { get; set; } = "";
    [JsonPropertyName("client_version")] public string ClientVersion { get; set; } = "";
}

/// <summary>Mirrors <c>BridgeMessage::Handshake</c>.</summary>
public sealed class HandshakeResponse
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "handshake";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; } = WireProtocol.Version;
    [JsonPropertyName("application")] public ApplicationInstance Application { get; set; } = new();

    /// <summary>
    /// Coarse capability flags. Checkpoint C implements no operations, so this
    /// is empty: advertising rhino.document before a document tool exists would
    /// put an unusable tool in front of the model.
    /// </summary>
    [JsonPropertyName("features")] public List<string> Features { get; set; } = new();
}

/// <summary>Mirrors <c>ClientMessage::Request</c>.</summary>
public sealed class RequestEnvelope
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "request";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; }
    [JsonPropertyName("request_id")] public string RequestId { get; set; } = "";
    [JsonPropertyName("operation")] public string Operation { get; set; } = "";

    /// <summary>
    /// Absent for operations that discover state before any target is known.
    /// </summary>
    /// <remarks>
    /// Typed as of checkpoint E, where the first operations that act on a
    /// specific document arrive. An absent target is never silently resolved to
    /// "the active document": a document operation without a target is refused,
    /// and the caller is expected to have discovered a runtime serial first.
    /// </remarks>
    [JsonPropertyName("target")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public TargetRef? Target { get; set; }

    [JsonPropertyName("arguments")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Arguments { get; set; }

    [JsonPropertyName("timeout_ms")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ulong? TimeoutMs { get; set; }
}

/// <summary>Mirrors <c>BridgeMessage::Response</c>.</summary>
public sealed class ResponseEnvelope
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "response";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; } = WireProtocol.Version;
    [JsonPropertyName("request_id")] public string RequestId { get; set; } = "";
    [JsonPropertyName("status")] public ResponseStatus Status { get; set; } = ResponseStatus.Ok;

    [JsonPropertyName("result")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Result { get; set; }

    [JsonPropertyName("mutation")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MutationSummary? Mutation { get; set; }

    [JsonPropertyName("warnings")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<string>? Warnings { get; set; }

    [JsonPropertyName("duration_ms")] public ulong DurationMs { get; set; }
}

/// <summary>Mirrors <c>BridgeMessage::Error</c>.</summary>
public sealed class ErrorEnvelope
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "error";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; } = WireProtocol.Version;

    /// <summary>
    /// Null when the failure happened before a request could be parsed. The
    /// facade treats an unattributed error as the end of the connection, which
    /// is correct: nothing else can be said about a stream we cannot read.
    /// </summary>
    [JsonPropertyName("request_id")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RequestId { get; set; }

    [JsonPropertyName("code")] public ErrorCode Code { get; set; }
    [JsonPropertyName("message")] public string Message { get; set; } = "";
    [JsonPropertyName("retry")] public RetryDisposition Retry { get; set; }

    [JsonPropertyName("details")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Details { get; set; }

    public static ErrorEnvelope Create(string? requestId, ErrorCode code, string message) => new()
    {
        RequestId = requestId,
        Code = code,
        Message = message,
        Retry = code.DefaultRetry(),
    };
}

/// <summary>Mirrors <c>BridgeMessage::Event</c>.</summary>
public sealed class EventEnvelope
{
    [JsonPropertyName("envelope")] public string Envelope { get; set; } = "event";
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; } = WireProtocol.Version;
    [JsonPropertyName("event_id")] public string EventId { get; set; } = "";
    [JsonPropertyName("kind")] public EventKind Kind { get; set; }
    [JsonPropertyName("session")] public RhinoSessionRef Session { get; set; } = new();
    [JsonPropertyName("emitted_at_unix_ms")] public ulong EmittedAtUnixMs { get; set; }

    [JsonPropertyName("data")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Data { get; set; }

    /// <summary>
    /// How many observations were discarded between the previous event on this
    /// connection and this one.
    /// </summary>
    /// <remarks>
    /// Events are queued, and a queue that may not block Rhino's UI thread must
    /// be allowed to drop. A silent drop would be worse than a loud one:
    /// verification reasons from event evidence, and "no ObjectAdded arrived"
    /// must stay distinguishable from "the evidence was thrown away".
    /// </remarks>
    [JsonPropertyName("dropped_before")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ulong? DroppedBefore { get; set; }
}
