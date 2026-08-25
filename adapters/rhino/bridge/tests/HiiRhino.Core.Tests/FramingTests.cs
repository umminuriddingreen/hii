using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;
using Xunit;

namespace HiiRhino.Core.Tests;

public sealed class FramingTests
{
    private static HandshakeRequest Handshake() => new()
    {
        ProtocolVersion = WireProtocol.Version,
        Client = "hii-cli",
        ClientVersion = "0.1.0",
    };

    private static async Task<T> ReadOne<T>(byte[] bytes)
    {
        using var stream = new MemoryStream(bytes);
        byte[] body = await Framing.ReadFrameAsync(stream, CancellationToken.None);
        return Framing.Decode<T>(body);
    }

    [Fact]
    public void a_frame_is_a_little_endian_length_then_the_body()
    {
        byte[] frame = Framing.Encode(Handshake());
        int declared = Framing.DecodeLength(frame.AsSpan(0, Framing.HeaderBytes));

        Assert.Equal(frame.Length - Framing.HeaderBytes, declared);

        // Spelled out rather than read back through DecodeLength, so that a
        // machine which is somehow big-endian, or a refactor that reaches for
        // BitConverter, fails here instead of on the wire.
        Assert.Equal((byte)(declared & 0xFF), frame[0]);
        Assert.Equal((byte)((declared >> 8) & 0xFF), frame[1]);
        Assert.Equal((byte)((declared >> 16) & 0xFF), frame[2]);
        Assert.Equal((byte)((declared >> 24) & 0xFF), frame[3]);
    }

    [Fact]
    public void a_frame_carries_no_byte_order_mark_and_no_trailing_newline()
    {
        byte[] frame = Framing.Encode(Handshake());
        byte[] body = frame[Framing.HeaderBytes..];

        Assert.Equal((byte)'{', body[0]);
        Assert.Equal((byte)'}', body[^1]);
        Assert.NotEqual(0xEF, body[0]);
    }

    [Fact]
    public async Task frames_round_trip_back_to_back_on_one_stream()
    {
        using var stream = new MemoryStream();
        byte[] frame = Framing.Encode(Handshake());
        stream.Write(frame);
        stream.Write(frame);
        stream.Position = 0;

        for (int index = 0; index < 2; index++)
        {
            byte[] body = await Framing.ReadFrameAsync(stream, CancellationToken.None);
            Assert.Equal("hii-cli", Framing.Decode<HandshakeRequest>(body).Client);
        }

        // The end of a complete frame is a clean close, not corruption.
        FrameException closed = await Assert.ThrowsAsync<FrameException>(
            () => Framing.ReadFrameAsync(stream, CancellationToken.None));
        Assert.Equal(FrameFault.Closed, closed.Fault);
        Assert.Equal(ErrorCode.BridgeUnavailable, closed.Code);
    }

    [Fact]
    public void an_oversized_prefix_is_rejected_before_anything_is_allocated()
    {
        // From the four header bytes alone, with no body present at all. This is
        // the whole reason the length is validated separately.
        byte[] header = BitConverter.GetBytes((uint)WireProtocol.MaxMessageBytes + 1);
        FrameException error = Assert.Throws<FrameException>(() => Framing.DecodeLength(header));

        Assert.Equal(FrameFault.TooLarge, error.Fault);
        Assert.Equal(ErrorCode.MalformedMessage, error.Code);

        // The boundary itself is legal.
        Assert.Equal(
            WireProtocol.MaxMessageBytes,
            Framing.DecodeLength(BitConverter.GetBytes((uint)WireProtocol.MaxMessageBytes)));
    }

    [Fact]
    public void a_zero_length_frame_is_rejected()
    {
        FrameException error = Assert.Throws<FrameException>(
            () => Framing.DecodeLength(BitConverter.GetBytes(0u)));
        Assert.Equal(FrameFault.Empty, error.Fault);
    }

    [Theory]
    [InlineData(2)]
    [InlineData(6)]
    public async Task a_half_written_frame_is_truncated_not_closed(int cut)
    {
        byte[] frame = Framing.Encode(Handshake());
        using var stream = new MemoryStream(frame[..cut]);

        FrameException error = await Assert.ThrowsAsync<FrameException>(
            () => Framing.ReadFrameAsync(stream, CancellationToken.None));
        Assert.Equal(FrameFault.Truncated, error.Fault);
    }

    [Fact]
    public async Task a_body_that_is_not_a_known_message_is_malformed_not_ignored()
    {
        byte[] body = System.Text.Encoding.UTF8.GetBytes("not json at all");
        byte[] frame = new byte[Framing.HeaderBytes + body.Length];
        BitConverter.GetBytes((uint)body.Length).CopyTo(frame, 0);
        body.CopyTo(frame, Framing.HeaderBytes);

        FrameException error = await Assert.ThrowsAsync<FrameException>(
            async () => await ReadOne<HandshakeRequest>(frame));
        Assert.Equal(FrameFault.Decode, error.Fault);
        Assert.Equal(ErrorCode.MalformedMessage, error.Code);
    }

    [Fact]
    public async Task a_stream_that_dribbles_bytes_still_assembles_the_frame()
    {
        // A pipe is free to return one byte at a time. Assuming a single read
        // fills the four-byte header works right up until it does not, and then
        // it desynchronises the stream rather than failing cleanly.
        byte[] frame = Framing.Encode(Handshake());
        using var stream = new DribbleStream(frame);

        byte[] body = await Framing.ReadFrameAsync(stream, CancellationToken.None);
        Assert.Equal("hii-cli", Framing.Decode<HandshakeRequest>(body).Client);
    }

    private sealed class DribbleStream : Stream
    {
        private readonly byte[] _bytes;
        private int _position;

        public DribbleStream(byte[] bytes) => _bytes = bytes;

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_position >= _bytes.Length || count == 0)
            {
                return 0;
            }
            buffer[offset] = _bytes[_position++];
            return 1;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _bytes.Length;
        public override long Position { get => _position; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
