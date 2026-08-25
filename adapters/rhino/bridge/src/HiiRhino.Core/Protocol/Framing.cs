using System;
using System.Buffers.Binary;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace HiiRhino.Core.Protocol;

/// <summary>Why a frame could not be read or written.</summary>
public enum FrameFault
{
    /// <summary>The peer closed cleanly, exactly at a frame boundary. Not a fault.</summary>
    Closed,

    /// <summary>The peer vanished part-way through a frame.</summary>
    Truncated,

    /// <summary>A zero-length frame. Legal JSON never encodes to nothing.</summary>
    Empty,

    /// <summary>The prefix asks for more than <see cref="WireProtocol.MaxMessageBytes"/>.</summary>
    TooLarge,

    /// <summary>The body was not JSON, or not a message this side knows.</summary>
    Decode,
}

public sealed class FrameException : Exception
{
    public FrameException(FrameFault fault, string message, Exception? inner = null)
        : base(message, inner)
    {
        Fault = fault;
    }

    public FrameFault Fault { get; }

    /// <summary>
    /// Mirrors <c>FrameError::code</c>. A closed pipe is a missing bridge; every
    /// other framing fault desynchronises the stream.
    /// </summary>
    public ErrorCode Code => Fault == FrameFault.Closed
        ? ErrorCode.BridgeUnavailable
        : ErrorCode.MalformedMessage;
}

/// <summary>
/// Length-prefixed framing, mirroring <c>hii_rhino_protocol::framing</c>.
/// </summary>
/// <remarks>
/// Little-endian <c>uint32</c> byte count, then exactly that many bytes of
/// UTF-8 JSON. No BOM, no trailing newline, no message-mode pipe: the length
/// prefix is the only thing that marks a boundary.
/// </remarks>
public static class Framing
{
    public const int HeaderBytes = 4;

    /// <summary>
    /// Validate a length prefix on its own, before a single body byte is read.
    /// </summary>
    public static int DecodeLength(ReadOnlySpan<byte> header)
    {
        uint declared = BinaryPrimitives.ReadUInt32LittleEndian(header);
        if (declared == 0)
        {
            throw new FrameException(FrameFault.Empty, "received a zero-length frame");
        }
        if (declared > WireProtocol.MaxMessageBytes)
        {
            throw new FrameException(
                FrameFault.TooLarge,
                $"frame declares {declared} bytes, over the {WireProtocol.MaxMessageBytes} byte limit");
        }
        return (int)declared;
    }

    /// <summary>Serialize one value into a complete frame: prefix then body.</summary>
    public static byte[] Encode<T>(T value)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(value, WireJson.Options);
        if (body.Length > WireProtocol.MaxMessageBytes)
        {
            // Refuse to emit what the peer is obliged to reject.
            throw new FrameException(
                FrameFault.TooLarge,
                $"message serialized to {body.Length} bytes, over the {WireProtocol.MaxMessageBytes} byte limit");
        }

        // One contiguous buffer, so that a caller holding the write lock emits
        // the header and the body as a single write. Two writes could be
        // interleaved with another thread's frame and desynchronise the stream.
        var frame = new byte[HeaderBytes + body.Length];
        BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(0, HeaderBytes), (uint)body.Length);
        body.CopyTo(frame, HeaderBytes);
        return frame;
    }

    /// <summary>
    /// Read exactly one frame body, or throw <see cref="FrameException"/>.
    /// </summary>
    /// <remarks>
    /// The header is filled in a loop: a pipe is free to return one byte at a
    /// time, and assuming a single read fills four bytes works right up until
    /// it does not. End of stream at a boundary is
    /// <see cref="FrameFault.Closed"/>; part-way through is
    /// <see cref="FrameFault.Truncated"/>. Conflating the two would report an
    /// ordinary Rhino shutdown as corruption.
    /// </remarks>
    public static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        var header = new byte[HeaderBytes];
        int filled = 0;
        while (filled < HeaderBytes)
        {
            int read = await stream
                .ReadAsync(header.AsMemory(filled, HeaderBytes - filled), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                throw filled == 0
                    ? new FrameException(FrameFault.Closed, "the peer closed the connection")
                    : new FrameException(FrameFault.Truncated, "the connection ended inside a frame header");
            }
            filled += read;
        }

        // Validated first, so the allocation below is bounded by our own
        // constant rather than by whatever the peer put in four bytes.
        int length = DecodeLength(header);

        var body = new byte[length];
        filled = 0;
        while (filled < length)
        {
            int read = await stream
                .ReadAsync(body.AsMemory(filled, length - filled), cancellationToken)
                .ConfigureAwait(false);
            if (read == 0)
            {
                throw new FrameException(
                    FrameFault.Truncated,
                    $"the connection ended after {filled} of {length} body bytes");
            }
            filled += read;
        }

        return body;
    }

    /// <summary>Parse a frame body, turning a JSON fault into a framing fault.</summary>
    public static T Decode<T>(byte[] body)
    {
        try
        {
            T? value = JsonSerializer.Deserialize<T>(body, WireJson.Options);
            if (value is null)
            {
                throw new FrameException(FrameFault.Decode, "frame body was a bare null");
            }
            return value;
        }
        catch (JsonException error)
        {
            throw new FrameException(FrameFault.Decode, $"frame body did not parse: {error.Message}", error);
        }
    }
}
