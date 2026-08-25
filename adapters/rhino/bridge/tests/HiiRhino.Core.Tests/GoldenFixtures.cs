using System;
using System.IO;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace HiiRhino.Core.Tests;

/// <summary>
/// Access to the fixtures the Rust protocol crate is pinned against.
/// </summary>
/// <remarks>
/// These are the same files, read from the same place. That is the point: a set
/// of C# assertions written from the Rust source would agree with whatever this
/// side happens to do, whereas a fixture disagrees the moment the two
/// implementations diverge — which is the only failure that matters for a
/// protocol mirrored by hand.
/// </remarks>
internal static class GoldenFixtures
{
    private static readonly Lazy<string> Root = new(Locate);

    private static string Locate()
    {
        // Walk up from the test binary rather than hard-coding a path, so this
        // survives being run from the IDE, from dotnet test, and from CI.
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            string candidate = Path.Combine(directory.FullName, "adapters", "rhino", "tests", "golden");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            "could not find adapters/rhino/tests/golden above " + AppContext.BaseDirectory);
    }

    public static string Read(string name) => File.ReadAllText(Path.Combine(Root.Value, name));

    public static byte[] ReadHex(string name)
    {
        string text = Read(name).Trim();
        return Convert.FromHexString(text);
    }

    /// <summary>
    /// The fixture as it would look on the wire: same key order, same values, no
    /// pretty-printing.
    /// </summary>
    /// <remarks>
    /// <see cref="JsonDocument"/> preserves both member order and the original
    /// text of numbers, so this re-indents without normalising anything that the
    /// comparison is supposed to catch.
    /// </remarks>
    public static string Minify(string json)
    {
        using var document = JsonDocument.Parse(json);
        var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions
        {
            Indented = false,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            document.RootElement.WriteTo(writer);
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }
}
