using System;
using System.Text.Json;
using HiiRhino.Core.Protocol;
using Xunit;

namespace HiiRhino.Core.Tests;

public sealed class TargetRefTests
{
    [Fact]
    public void a_document_target_round_trips_with_kind_alongside_its_fields()
    {
        // serde tags this union internally, so `kind` sits beside the variant's
        // own fields rather than wrapping them. A converter that nested them
        // would produce valid JSON that the facade cannot read.
        const string json =
            """{"kind":"document","rhino_instance_id":"11112222-3333-4444-5555-666677778888","document_runtime_serial":17}""";

        var target = JsonSerializer.Deserialize<TargetRef>(json, WireJson.Options)!;
        var document = Assert.IsType<DocumentTarget>(target);

        Assert.Equal(Guid.Parse("11112222-3333-4444-5555-666677778888"), document.RhinoInstanceId);
        Assert.Equal(17u, document.DocumentRuntimeSerial);
        Assert.Equal(json, JsonSerializer.Serialize(target, WireJson.Options));
    }

    [Fact]
    public void an_instance_target_round_trips()
    {
        const string json =
            """{"kind":"instance","rhino_instance_id":"11112222-3333-4444-5555-666677778888"}""";

        var target = JsonSerializer.Deserialize<TargetRef>(json, WireJson.Options)!;
        Assert.IsType<InstanceTarget>(target);
        Assert.Equal(json, JsonSerializer.Serialize(target, WireJson.Options));
    }

    [Fact]
    public void a_grasshopper_target_round_trips_even_though_nothing_acts_on_one_yet()
    {
        // Mirrored so the union parses completely. A request naming one is
        // refused as an unimplemented operation, which is a clear answer; a
        // parse failure would be reported as a malformed message and take the
        // connection down with it.
        const string json =
            """{"kind":"grasshopper_document","rhino_instance_id":"11112222-3333-4444-5555-666677778888","rhino_document_runtime_serial":17,"gh_runtime_id":"9999aaaa-bbbb-cccc-dddd-eeeeffff0000"}""";

        var target = JsonSerializer.Deserialize<TargetRef>(json, WireJson.Options)!;
        Assert.IsType<GrasshopperDocumentTarget>(target);
        Assert.Equal(json, JsonSerializer.Serialize(target, WireJson.Options));
    }

    [Fact]
    public void an_optional_grasshopper_document_serial_is_omitted_when_absent()
    {
        const string json =
            """{"kind":"grasshopper_document","rhino_instance_id":"11112222-3333-4444-5555-666677778888","gh_runtime_id":"9999aaaa-bbbb-cccc-dddd-eeeeffff0000"}""";

        var target = JsonSerializer.Deserialize<TargetRef>(json, WireJson.Options)!;
        Assert.Null(Assert.IsType<GrasshopperDocumentTarget>(target).RhinoDocumentRuntimeSerial);
        Assert.Equal(json, JsonSerializer.Serialize(target, WireJson.Options));
    }

    [Fact]
    public void an_unknown_target_kind_is_refused_rather_than_ignored()
    {
        // A target this build does not understand means the facade is newer.
        // Acting on it anyway is how the wrong document gets edited.
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<TargetRef>(
            """{"kind":"something_invented_later","rhino_instance_id":"11112222-3333-4444-5555-666677778888"}""",
            WireJson.Options));
    }

    [Fact]
    public void a_target_missing_the_fields_its_kind_requires_is_refused()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<TargetRef>(
            """{"kind":"document","rhino_instance_id":"11112222-3333-4444-5555-666677778888"}""",
            WireJson.Options));
    }
}
