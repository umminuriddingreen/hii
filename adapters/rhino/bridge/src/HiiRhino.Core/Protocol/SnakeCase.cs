using System;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

/// <summary>
/// Serialises enums the way <c>#[serde(rename_all = "snake_case")]</c> does.
/// </summary>
/// <remarks>
/// .NET 7 has neither <c>JsonNamingPolicy.SnakeCaseLower</c> nor a naming
/// policy overload on <c>JsonStringEnumConverter</c>; both arrived in .NET 8,
/// and Rhino 8 targets net7.0. So the conversion is done here.
///
/// The mapping is computed rather than hand-listed, because a hand-written
/// table drifts silently when a variant is added. What stops the *computation*
/// from drifting is a test that pins every name of every mirrored enum against
/// the Rust source, which is where a new variant actually shows up.
/// </remarks>
public sealed class SnakeCaseEnumConverter<TEnum> : JsonConverter<TEnum>
    where TEnum : struct, Enum
{
    private static readonly Dictionary<TEnum, string> ToWire = BuildToWire();
    private static readonly Dictionary<string, TEnum> FromWire = BuildFromWire();

    private static Dictionary<TEnum, string> BuildToWire()
    {
        var map = new Dictionary<TEnum, string>();
        foreach (TEnum value in Enum.GetValues<TEnum>())
        {
            map[value] = ToSnakeCase(value.ToString()!);
        }
        return map;
    }

    private static Dictionary<string, TEnum> BuildFromWire()
    {
        var map = new Dictionary<string, TEnum>(StringComparer.Ordinal);
        foreach (KeyValuePair<TEnum, string> pair in ToWire)
        {
            map[pair.Value] = pair.Key;
        }
        return map;
    }

    /// <summary>
    /// <c>UiDispatchFailed</c> becomes <c>ui_dispatch_failed</c>: an underscore
    /// before every capital except the first, then lower-cased. This matches
    /// serde for the names actually in the protocol, all of which spell
    /// acronyms as words (<c>Ui</c>, not <c>UI</c>) precisely so that the two
    /// implementations cannot disagree about run-on capitals.
    /// </summary>
    public static string ToSnakeCase(string name)
    {
        var builder = new StringBuilder(name.Length + 8);
        for (int index = 0; index < name.Length; index++)
        {
            char character = name[index];
            if (char.IsUpper(character) && index > 0)
            {
                builder.Append('_');
            }
            builder.Append(char.ToLowerInvariant(character));
        }
        return builder.ToString();
    }

    /// <summary>The wire name for one value, for tests and diagnostics.</summary>
    public static string WireName(TEnum value) => ToWire[value];

    public override TEnum Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType != JsonTokenType.String)
        {
            throw new JsonException($"expected a string for {typeof(TEnum).Name}, found {reader.TokenType}");
        }

        string text = reader.GetString()!;
        if (!FromWire.TryGetValue(text, out TEnum value))
        {
            // Deliberately fatal. An unknown code is not something to coerce to
            // a default: the peer is telling us something this build does not
            // understand, and guessing would hide a version skew.
            throw new JsonException($"'{text}' is not a known {typeof(TEnum).Name}");
        }
        return value;
    }

    public override void Write(Utf8JsonWriter writer, TEnum value, JsonSerializerOptions options)
    {
        writer.WriteStringValue(ToWire[value]);
    }
}
