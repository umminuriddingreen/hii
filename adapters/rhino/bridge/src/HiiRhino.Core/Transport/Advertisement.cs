using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using HiiRhino.Core.Protocol;

namespace HiiRhino.Core.Transport;

/// <summary>Naming for the local transport. Mirrors <c>hii_rhino_protocol::transport</c>.</summary>
public static class PipeNames
{
    /// <summary>
    /// One pipe per Rhino process. The logon session keeps a console user and
    /// an RDP user from colliding; the pid keeps two Rhino instances in one
    /// session distinct.
    /// </summary>
    /// <remarks>
    /// Named pipes have no per-session namespace, so the <c>LOCAL\</c> prefix is
    /// organisational only. Isolation comes from the pipe DACL. Never treat this
    /// name as a security boundary.
    /// </remarks>
    public static string PipeName(uint sessionId, uint processId) =>
        $@"LOCAL\hii.rhino.{sessionId}.{processId}";

    public static string AdvertisementFileName(uint processId, Guid instanceId) =>
        $"{processId}-{instanceId:D}.json";
}

/// <summary>
/// What a live bridge publishes about itself. Mirrors
/// <c>hii_rhino_protocol::transport::Advertisement</c>.
/// </summary>
/// <remarks>
/// Discovery information only. It is deliberately not authoritative about
/// anything: the facade uses <c>protocol_version</c> as a pre-filter to avoid
/// dialling a bridge it cannot speak to, but the handshake decides. Two version
/// gates that can disagree is one gate too many.
/// </remarks>
public sealed class Advertisement
{
    [JsonPropertyName("protocol_version")] public int ProtocolVersion { get; set; } = WireProtocol.Version;
    [JsonPropertyName("rhino_instance_id")] public Guid RhinoInstanceId { get; set; }
    [JsonPropertyName("process_id")] public uint ProcessId { get; set; }
    [JsonPropertyName("session_id")] public uint SessionId { get; set; }

    /// <summary>
    /// Written out rather than re-derived by the reader, so a future naming
    /// change in the bridge does not strand facades built against the old rule.
    /// </summary>
    [JsonPropertyName("pipe_name")] public string PipeName { get; set; } = "";

    [JsonPropertyName("application_version")] public string ApplicationVersion { get; set; } = "";
    [JsonPropertyName("adapter_version")] public string AdapterVersion { get; set; } = "";
    [JsonPropertyName("started_at_unix_ms")] public ulong StartedAtUnixMs { get; set; }
}

/// <summary>Publishing and retracting one advertisement file.</summary>
public static class AdvertisementFile
{
    /// <summary>
    /// The extension the staging file uses. It must not be <c>.json</c>: the
    /// Rust scan matches on that extension, so a half-written <c>.json</c> temp
    /// file would be picked up and the atomic rename would buy nothing.
    /// </summary>
    public const string StagingExtension = ".tmp";

    /// <summary>
    /// Write the advertisement so that a concurrent scan sees either no file or
    /// a complete one.
    /// </summary>
    /// <remarks>
    /// Staged in the same directory (a rename across volumes is not atomic),
    /// then moved into place. Bytes are written directly rather than through a
    /// <see cref="StreamWriter"/> so no BOM can appear: the Rust side parses the
    /// file as UTF-8 JSON and a byte order mark is not JSON.
    /// </remarks>
    public static string Publish(string directory, Advertisement advertisement)
    {
        Directory.CreateDirectory(directory);

        string finalPath = Path.Combine(
            directory,
            PipeNames.AdvertisementFileName(advertisement.ProcessId, advertisement.RhinoInstanceId));
        string stagingPath = finalPath + StagingExtension;

        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(advertisement, WireJson.Options);

        using (var stream = new FileStream(
            stagingPath, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(flushToDisk: true);
        }

        File.Move(stagingPath, finalPath, overwrite: true);
        return finalPath;
    }

    /// <summary>
    /// Remove an advertisement on clean shutdown.
    /// </summary>
    /// <remarks>
    /// Failure is swallowed deliberately. A file we could not delete is a stale
    /// advertisement, which the facade already handles as a prune candidate;
    /// throwing here would turn tidy-up into a reason Rhino fails to close.
    /// </remarks>
    public static void Retract(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return;
        }
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
