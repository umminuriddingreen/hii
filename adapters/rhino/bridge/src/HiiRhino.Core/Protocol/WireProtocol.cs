namespace HiiRhino.Core.Protocol;

/// <summary>
/// Constants shared with the Rust protocol crate. These are mirrored by hand,
/// so they are pinned by tests that read the same golden fixtures the Rust side
/// reads (see <c>adapters/rhino/tests/golden</c>).
/// </summary>
public static class WireProtocol
{
    /// <summary>Mirrors <c>hii_rhino_protocol::PROTOCOL_VERSION</c>.</summary>
    public const int Version = 1;

    /// <summary>
    /// Mirrors <c>hii_rhino_protocol::MAX_MESSAGE_BYTES</c>. Unrelated to the
    /// pipe's kernel buffer sizes: this bounds one logical message, those bound
    /// how much the kernel will hold before a writer blocks.
    /// </summary>
    public const int MaxMessageBytes = 8 * 1024 * 1024;
}
