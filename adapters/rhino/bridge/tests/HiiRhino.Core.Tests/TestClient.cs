using System;
using System.IO.Pipes;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Protocol;
using HiiRhino.Core.Transport;

namespace HiiRhino.Core.Tests;

/// <summary>
/// A minimal facade for the tests: connect, handshake, send requests.
/// </summary>
/// <remarks>
/// Deliberately not a mirror of the real Rust client. It has no demultiplexing
/// reader thread and no event queue, because these tests are about the server.
/// The real facade is exercised against this server by the Rust acceptance run,
/// which is the only place the two implementations meet.
/// </remarks>
internal sealed class TestClient : IDisposable
{
    private readonly NamedPipeClientStream _stream;

    private TestClient(NamedPipeClientStream stream) => _stream = stream;

    public static async Task<TestClient> ConnectAsync(string pipeName, CancellationToken cancellationToken)
    {
        var stream = new NamedPipeClientStream(
            ".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await stream.ConnectAsync(5000, cancellationToken);
        return new TestClient(stream);
    }

    public async Task SendAsync<T>(T message, CancellationToken cancellationToken)
    {
        byte[] frame = Framing.Encode(message);
        await _stream.WriteAsync(frame, cancellationToken);
        await _stream.FlushAsync(cancellationToken);
    }

    /// <summary>Send a frame this client would never legitimately produce.</summary>
    public async Task SendRawAsync(byte[] frame, CancellationToken cancellationToken)
    {
        await _stream.WriteAsync(frame, cancellationToken);
        await _stream.FlushAsync(cancellationToken);
    }

    public async Task<JsonElement> ReceiveAsync(CancellationToken cancellationToken)
    {
        byte[] body = await Framing.ReadFrameAsync(_stream, cancellationToken);
        return JsonDocument.Parse(body).RootElement.Clone();
    }

    public async Task<T> ReceiveAsync<T>(CancellationToken cancellationToken)
    {
        byte[] body = await Framing.ReadFrameAsync(_stream, cancellationToken);
        return Framing.Decode<T>(body);
    }

    public async Task<HandshakeResponse> HandshakeAsync(
        CancellationToken cancellationToken,
        int protocolVersion = WireProtocol.Version)
    {
        await SendAsync(
            new HandshakeRequest
            {
                ProtocolVersion = protocolVersion,
                Client = "hii-core-tests",
                ClientVersion = "0.1.0",
            },
            cancellationToken);
        return await ReceiveAsync<HandshakeResponse>(cancellationToken);
    }

    public async Task<JsonElement> RequestAsync(
        string requestId,
        string operation,
        CancellationToken cancellationToken)
    {
        await SendAsync(
            new RequestEnvelope
            {
                ProtocolVersion = WireProtocol.Version,
                RequestId = requestId,
                Operation = operation,
            },
            cancellationToken);
        return await ReceiveAsync(cancellationToken);
    }

    public PipeStream Stream => _stream;

    public void Dispose() => _stream.Dispose();
}
