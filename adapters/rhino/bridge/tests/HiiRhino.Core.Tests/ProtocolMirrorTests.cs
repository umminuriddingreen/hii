using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using HiiRhino.Core.Protocol;
using HiiRhino.Core.Transport;
using Xunit;

namespace HiiRhino.Core.Tests;

/// <summary>
/// The C# mirror against the fixtures serde produced.
/// </summary>
public sealed class ProtocolMirrorTests
{
    private static string RoundTrip<T>(string fixtureName)
    {
        string fixture = GoldenFixtures.Read(fixtureName);
        T value = JsonSerializer.Deserialize<T>(fixture, WireJson.Options)!;
        return JsonSerializer.Serialize(value, WireJson.Options);
    }

    [Theory]
    [InlineData("client_handshake.json", typeof(HandshakeRequest))]
    [InlineData("bridge_handshake.json", typeof(HandshakeResponse))]
    [InlineData("client_request.json", typeof(RequestEnvelope))]
    [InlineData("bridge_response.json", typeof(ResponseEnvelope))]
    [InlineData("bridge_error.json", typeof(ErrorEnvelope))]
    [InlineData("bridge_event.json", typeof(EventEnvelope))]
    [InlineData("advertisement.json", typeof(Advertisement))]
    public void a_fixture_survives_a_round_trip_through_the_csharp_types_byte_for_byte(
        string fixtureName,
        Type type)
    {
        // Byte for byte, not merely equivalent. Key order is decided by property
        // declaration order and is invisible in a semantic comparison, but a
        // reordered key changes the length prefix and every recorded fixture.
        string expected = GoldenFixtures.Minify(GoldenFixtures.Read(fixtureName));

        object value = JsonSerializer.Deserialize(
            GoldenFixtures.Read(fixtureName), type, WireJson.Options)!;
        string actual = JsonSerializer.Serialize(value, type, WireJson.Options);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public void the_frame_the_facade_sends_is_read_exactly_as_the_facade_wrote_it()
    {
        // The hex fixture is a complete frame captured from the Rust side: four
        // little-endian length bytes and a UTF-8 body. Reading it here is the
        // only test in this suite that exercises the framing and the mirror
        // together against bytes neither side generated at test time.
        byte[] frame = GoldenFixtures.ReadHex("handshake_frame.hex");

        int declared = Framing.DecodeLength(frame.AsSpan(0, Framing.HeaderBytes));
        Assert.Equal(frame.Length - Framing.HeaderBytes, declared);

        byte[] body = frame[Framing.HeaderBytes..];
        HandshakeRequest handshake = Framing.Decode<HandshakeRequest>(body);

        Assert.Equal("handshake", handshake.Envelope);
        Assert.Equal(WireProtocol.Version, handshake.ProtocolVersion);
        Assert.Equal("hii-cli", handshake.Client);
        Assert.Equal("0.1.0", handshake.ClientVersion);
    }

    [Fact]
    public void the_advertised_name_is_the_one_the_facade_will_open()
    {
        var advertisement = JsonSerializer.Deserialize<Advertisement>(
            GoldenFixtures.Read("advertisement.json"), WireJson.Options)!;

        Assert.Equal(
            advertisement.PipeName,
            PipeNames.PipeName(advertisement.SessionId, advertisement.ProcessId));
    }

    [Fact]
    public void a_non_ascii_payload_is_not_escaped_and_its_prefix_counts_bytes()
    {
        // Two failures at once if the encoder is left at its default. The
        // millimetre sign would go out as ×, which parses back to the same
        // string and so passes every round-trip test, while making the frame a
        // different length than the Rust side produces for the same message.
        var response = new ResponseEnvelope
        {
            RequestId = "req-0001",
            Result = JsonDocument.Parse("\"40 mm × 40 mm × 40 mm\"").RootElement.Clone(),
            DurationMs = 1,
        };

        byte[] frame = Framing.Encode(response);
        string json = Encoding.UTF8.GetString(frame[Framing.HeaderBytes..]);

        Assert.Contains("40 mm × 40 mm", json);
        Assert.DoesNotContain("\\u00D7", json, StringComparison.OrdinalIgnoreCase);

        // The prefix counts bytes; the multiplication signs are two bytes each.
        Assert.Equal(
            Encoding.UTF8.GetByteCount(json),
            Framing.DecodeLength(frame.AsSpan(0, Framing.HeaderBytes)));
        Assert.True(json.Length < Encoding.UTF8.GetByteCount(json));
    }

    /// <summary>
    /// Every <c>ErrorCode</c>, spelled out.
    /// </summary>
    /// <remarks>
    /// Listed here in full rather than computed, because the thing that has to
    /// be caught is a variant added to the Rust enum and not to this one. A
    /// generated list would agree with itself and prove nothing.
    /// </remarks>
    private static readonly string[] ExpectedErrorCodeNames =
    {
        "bridge_unavailable",
        "protocol_version_mismatch",
        "malformed_message",
        "rhino_instance_not_found",
        "timeout",
        "request_outcome_unknown",
        "cancelled",
        "document_not_found",
        "document_changed",
        "object_not_found",
        "stale_reference",
        "invalid_arguments",
        "operation_not_supported",
        "permission_denied",
        "invalid_native_state",
        "ui_dispatch_failed",
        "native_operation_failed",
        "undo_failed",
        "verification_failed",
        "grasshopper_unavailable",
        "grasshopper_document_not_found",
        "component_not_found",
        "component_ambiguous",
        "parameter_not_found",
        "parameter_ambiguous",
        "connection_invalid",
        "solution_failed",
        "provider_unavailable",
        "provider_tool_call_invalid",
    };

    [Fact]
    public void every_error_code_is_mirrored_with_the_name_the_facade_uses()
    {
        string[] actual = Enum.GetValues<ErrorCode>()
            .Select(SnakeCaseEnumConverter<ErrorCode>.WireName)
            .ToArray();

        Assert.Equal(29, actual.Length);
        Assert.Equal(ExpectedErrorCodeNames, actual);
    }

    [Fact]
    public void the_other_mirrored_enums_use_the_names_the_facade_uses()
    {
        Assert.Equal(
            new[] { "safe", "unsafe", "requires_refreshed_state", "requires_user_action", "requires_different_arguments" },
            Enum.GetValues<RetryDisposition>().Select(SnakeCaseEnumConverter<RetryDisposition>.WireName));

        Assert.Equal(
            new[] { "ok", "partial" },
            Enum.GetValues<ResponseStatus>().Select(SnakeCaseEnumConverter<ResponseStatus>.WireName));

        Assert.Equal(
            new[]
            {
                "document_opened", "document_closed", "active_document_changed",
                "object_added", "object_deleted", "object_replaced",
                "object_attributes_changed", "selection_changed",
                "grasshopper_solution_start", "grasshopper_solution_end",
            },
            Enum.GetValues<EventKind>().Select(SnakeCaseEnumConverter<EventKind>.WireName));
    }

    [Fact]
    public void a_retry_disposition_is_never_invented_by_the_bridge()
    {
        // The facade decides whether replaying a mutation is safe from this
        // value. Two implementations disagreeing about it is how a box gets
        // created twice, so the mapping is asserted rather than trusted.
        var expected = new Dictionary<ErrorCode, RetryDisposition>
        {
            [ErrorCode.BridgeUnavailable] = RetryDisposition.RequiresUserAction,
            [ErrorCode.ProtocolVersionMismatch] = RetryDisposition.RequiresUserAction,
            [ErrorCode.PermissionDenied] = RetryDisposition.RequiresUserAction,
            [ErrorCode.StaleReference] = RetryDisposition.RequiresRefreshedState,
            [ErrorCode.DocumentChanged] = RetryDisposition.RequiresRefreshedState,
            [ErrorCode.OperationNotSupported] = RetryDisposition.RequiresDifferentArguments,
            [ErrorCode.InvalidArguments] = RetryDisposition.RequiresDifferentArguments,
            [ErrorCode.Timeout] = RetryDisposition.Safe,
            [ErrorCode.Cancelled] = RetryDisposition.Safe,
            [ErrorCode.UiDispatchFailed] = RetryDisposition.Safe,

            // The two that must not be Safe. A malformed message means the
            // stream is desynchronised; an unknown outcome means Rhino may
            // already have changed the document.
            [ErrorCode.MalformedMessage] = RetryDisposition.Unsafe,
            [ErrorCode.RequestOutcomeUnknown] = RetryDisposition.Unsafe,
        };

        foreach (KeyValuePair<ErrorCode, RetryDisposition> pair in expected)
        {
            Assert.Equal(pair.Value, pair.Key.DefaultRetry());
        }
    }

    [Fact]
    public void an_unknown_error_code_is_refused_rather_than_coerced()
    {
        // A code this build does not know means the peer is newer. Defaulting it
        // would turn a version skew into a mysterious wrong answer.
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<ErrorCode>("\"something_invented_later\"", WireJson.Options));
    }
}
