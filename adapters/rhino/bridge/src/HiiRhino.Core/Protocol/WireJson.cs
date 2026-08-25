using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

/// <summary>The one set of serializer options the wire uses.</summary>
public static class WireJson
{
    /// <remarks>
    /// <para>
    /// <see cref="JavaScriptEncoder.UnsafeRelaxedJsonEscaping"/> is not
    /// optional. By default System.Text.Json escapes every non-ASCII character
    /// as a <c>\uXXXX</c> sequence, and also escapes <c>+ &lt; &gt; &amp;</c>.
    /// serde_json escapes none of them. Both forms parse to the same string, so
    /// this would never break a round trip — it would only make the byte-for-
    /// byte fixture comparison fail, and, worse, silently inflate the length
    /// prefix on any message carrying a millimetre sign or a non-Latin layer
    /// name. Relaxed escaping still escapes what JSON requires.
    /// </para>
    /// <para>
    /// No indentation: the length prefix counts bytes, and pretty-printing
    /// would put whitespace on the wire for no reader.
    /// </para>
    /// </remarks>
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = null,
        NumberHandling = JsonNumberHandling.Strict,
    };
}
