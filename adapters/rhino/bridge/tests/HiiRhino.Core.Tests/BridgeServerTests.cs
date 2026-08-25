using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HiiRhino.Core.Hosting;
using HiiRhino.Core.Protocol;
using HiiRhino.Core.Transport;
using Xunit;

namespace HiiRhino.Core.Tests;

/// <summary>
/// The bridge lifecycle, run outside Rhino.
/// </summary>
/// <remarks>
/// Everything here is the production <see cref="BridgeServer"/> on a real named
/// pipe with a real DACL. Only the identity is synthetic, and only so that a
/// test run cannot collide with a bridge actually serving a Rhino on this
/// machine. What these cannot cover is Rhino's own lifecycle — plug-in load,
/// the UI thread, shutdown — which is why the acceptance run in Rhino is not
/// optional.
/// </remarks>
public sealed class BridgeServerTests : IDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(10);

    private readonly string _advertisementDirectory;
    private readonly BridgeIdentity _identity;

    public BridgeServerTests()
    {
        _advertisementDirectory = Path.Combine(
            Path.GetTempPath(), "hii-rhino-bridge-tests", Guid.NewGuid().ToString("N"));

        // A process id that is not this process, so the pipe name cannot collide
        // with a bridge serving a real Rhino, and a fresh instance id per test.
        _identity = new BridgeIdentity(
            instanceId: Guid.NewGuid(),
            processId: (uint)Random.Shared.Next(1_000_000, 2_000_000),
            sessionId: 1,
            applicationVersion: "8.32.26160.13001",
            adapterVersion: "0.1.0-test");
    }

    private BridgeServer NewServer(IRequestHandler? handler = null) => new(
        _identity,
        handler ?? new NoOperationsHandler(),
        NullBridgeLog.Instance,
        _advertisementDirectory);

    private static CancellationTokenSource Deadline() => new(Patience);

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_advertisementDirectory))
            {
                Directory.Delete(_advertisementDirectory, recursive: true);
            }
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void a_started_bridge_publishes_an_advertisement_naming_the_pipe_it_serves()
    {
        using BridgeServer server = NewServer();
        server.Start();

        Assert.True(server.IsRunning);
        string path = Assert.IsType<string>(server.AdvertisementPath);
        Assert.True(File.Exists(path));

        byte[] bytes = File.ReadAllBytes(path);

        // No byte order mark. The facade parses this as UTF-8 JSON, and a BOM is
        // not JSON.
        Assert.NotEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes.Take(3).ToArray());

        var advertisement = JsonSerializer.Deserialize<Advertisement>(bytes, WireJson.Options)!;
        Assert.Equal(WireProtocol.Version, advertisement.ProtocolVersion);
        Assert.Equal(_identity.InstanceId, advertisement.RhinoInstanceId);
        Assert.Equal(_identity.ProcessId, advertisement.ProcessId);
        Assert.Equal(server.PipeName, advertisement.PipeName);
        Assert.Equal(
            PipeNames.PipeName(advertisement.SessionId, advertisement.ProcessId),
            advertisement.PipeName);
        Assert.True(advertisement.StartedAtUnixMs > 0);

        // Nothing staged left behind, and nothing else that a scan would trip on.
        Assert.Empty(Directory.GetFiles(_advertisementDirectory, "*" + AdvertisementFile.StagingExtension));
        Assert.Single(Directory.GetFiles(_advertisementDirectory, "*.json"));
    }

    [Fact]
    public void starting_twice_does_not_create_a_second_server()
    {
        using BridgeServer server = NewServer();
        server.Start();
        string? first = server.AdvertisementPath;

        server.Start();

        Assert.Equal(first, server.AdvertisementPath);
        Assert.Single(Directory.GetFiles(_advertisementDirectory, "*.json"));
    }

    [Fact]
    public void stopping_retracts_the_advertisement_and_the_bridge_can_start_again()
    {
        using BridgeServer server = NewServer();
        server.Start();
        string path = server.AdvertisementPath!;

        server.Stop();

        Assert.False(server.IsRunning);
        Assert.False(File.Exists(path));
        Assert.Null(server.AdvertisementPath);

        // Stopping an already-stopped bridge is a no-op, not a fault.
        server.Stop();

        server.Start();
        Assert.True(server.IsRunning);
        Assert.True(File.Exists(server.AdvertisementPath!));
    }

    [Fact]
    public async Task a_handshake_reports_the_identity_this_bridge_was_given()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        HandshakeResponse handshake = await client.HandshakeAsync(deadline.Token);

        Assert.Equal("handshake", handshake.Envelope);
        Assert.Equal(WireProtocol.Version, handshake.ProtocolVersion);
        Assert.Equal("rhino", handshake.Application.Application);
        Assert.Equal(_identity.InstanceId, handshake.Application.RhinoInstanceId);
        Assert.Equal(_identity.ProcessId, handshake.Application.ProcessId);
        Assert.Equal(_identity.ApplicationVersion, handshake.Application.ApplicationVersion);
        Assert.Equal(_identity.AdapterVersion, handshake.Application.AdapterVersion);

        // No features, because no operation is implemented. A flag here becomes
        // a tool the model can call.
        Assert.Empty(handshake.Features);
    }

    [Fact]
    public async Task a_client_speaking_another_protocol_is_refused_before_it_can_ask_for_anything()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.SendAsync(
            new HandshakeRequest
            {
                ProtocolVersion = WireProtocol.Version + 1,
                Client = "from-the-future",
                ClientVersion = "9.9.9",
            },
            deadline.Token);

        var error = await client.ReceiveAsync<ErrorEnvelope>(deadline.Token);
        Assert.Equal("error", error.Envelope);
        Assert.Equal(ErrorCode.ProtocolVersionMismatch, error.Code);
        Assert.Equal(RetryDisposition.RequiresUserAction, error.Retry);

        // Unattributed on purpose: it is about the connection, not a request.
        Assert.Null(error.RequestId);

        // And the connection is over.
        FrameException closed = await Assert.ThrowsAsync<FrameException>(
            () => Framing.ReadFrameAsync(client.Stream, deadline.Token));
        Assert.Equal(FrameFault.Closed, closed.Fault);
    }

    [Fact]
    public async Task the_first_message_must_be_a_handshake()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.SendAsync(
            new RequestEnvelope
            {
                ProtocolVersion = WireProtocol.Version,
                RequestId = "req-0001",
                Operation = "rhino.document.describe",
            },
            deadline.Token);

        var error = await client.ReceiveAsync<ErrorEnvelope>(deadline.Token);
        Assert.Equal(ErrorCode.MalformedMessage, error.Code);
        Assert.Null(error.RequestId);
    }

    [Fact]
    public async Task regression_a_refusal_reaches_the_client_whole_before_the_pipe_closes()
    {
        // Found by an intermittent failure of the test above. Dropping a
        // connection used to call NamedPipeServerStream.Disconnect(), which
        // *discards* whatever the client has not read — so the typed reason we
        // had just written was sometimes truncated to its four-byte header, and
        // the client reported "malformed message" instead of why it was
        // refused. Repeated, because the original only lost the race sometimes.
        using BridgeServer server = NewServer();
        server.Start();

        for (int attempt = 0; attempt < 25; attempt++)
        {
            using CancellationTokenSource deadline = Deadline();
            using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);

            await client.SendAsync(
                new HandshakeRequest
                {
                    ProtocolVersion = WireProtocol.Version + 1,
                    Client = "from-the-future",
                    ClientVersion = "9.9.9",
                },
                deadline.Token);

            var error = await client.ReceiveAsync<ErrorEnvelope>(deadline.Token);
            Assert.Equal(ErrorCode.ProtocolVersionMismatch, error.Code);
            Assert.Contains("this bridge speaks", error.Message);
        }
    }

    [Fact]
    public async Task an_unimplemented_operation_comes_back_as_a_typed_error_for_that_request()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.HandshakeAsync(deadline.Token);

        JsonElement answer = await client.RequestAsync("req-0007", "rhino.object.create", deadline.Token);

        Assert.Equal("error", answer.GetProperty("envelope").GetString());
        Assert.Equal("operation_not_supported", answer.GetProperty("code").GetString());
        Assert.Equal("requires_different_arguments", answer.GetProperty("retry").GetString());

        // Correlated, so the facade hands it to the caller that asked rather
        // than treating it as the end of the connection.
        Assert.Equal("req-0007", answer.GetProperty("request_id").GetString());

        // The connection survives a refused operation.
        JsonElement second = await client.RequestAsync("req-0008", "rhino.session.list", deadline.Token);
        Assert.Equal("req-0008", second.GetProperty("request_id").GetString());
    }

    [Fact]
    public async Task a_frame_larger_than_the_limit_ends_the_connection_without_being_allocated()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.HandshakeAsync(deadline.Token);

        // A prefix only. If the server allocated from it before checking, it
        // would reserve a gigabyte and then wait forever for a body that is
        // never coming.
        await client.SendRawAsync(BitConverter.GetBytes(1_000_000_000u), deadline.Token);

        var error = await client.ReceiveAsync<ErrorEnvelope>(deadline.Token);
        Assert.Equal(ErrorCode.MalformedMessage, error.Code);
        Assert.Equal(RetryDisposition.Unsafe, error.Retry);
        Assert.Null(error.RequestId);
    }

    [Fact]
    public async Task a_client_that_vanishes_does_not_take_the_bridge_with_it()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        var first = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await first.HandshakeAsync(deadline.Token);

        // Dropped without any goodbye, which is what a killed facade looks like.
        first.Dispose();

        using TestClient second = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        HandshakeResponse handshake = await second.HandshakeAsync(deadline.Token);

        Assert.Equal(_identity.InstanceId, handshake.Application.RhinoInstanceId);
        Assert.True(server.IsRunning);
    }

    [Fact]
    public async Task a_second_client_can_connect_while_the_first_is_still_being_served()
    {
        // The listener has to be posted again before the connected one is
        // served. Without that there is a window in which the pipe name does not
        // exist, a client arriving in it gets ERROR_FILE_NOT_FOUND, and the
        // facade prunes the advertisement of a healthy bridge.
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient first = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await first.HandshakeAsync(deadline.Token);

        using TestClient second = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await second.HandshakeAsync(deadline.Token);

        // Both still work, and neither got the other's answer.
        JsonElement one = await first.RequestAsync("req-a", "rhino.session.list", deadline.Token);
        JsonElement two = await second.RequestAsync("req-b", "rhino.session.list", deadline.Token);
        Assert.Equal("req-a", one.GetProperty("request_id").GetString());
        Assert.Equal("req-b", two.GetProperty("request_id").GetString());
    }

    [Fact]
    public async Task stopping_the_bridge_drops_a_connected_client_without_hanging()
    {
        using BridgeServer server = NewServer();
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.HandshakeAsync(deadline.Token);

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        server.Stop();
        stopwatch.Stop();

        // Stop is called from Rhino's UI thread while it closes. It is bounded,
        // and this is the assertion that keeps it that way.
        Assert.True(
            stopwatch.Elapsed < TimeSpan.FromSeconds(5),
            $"Stop took {stopwatch.Elapsed.TotalSeconds:0.0}s");

        // The client sees the connection end, not a hang.
        await Assert.ThrowsAnyAsync<Exception>(
            () => Framing.ReadFrameAsync(client.Stream, deadline.Token));
    }

    [Fact]
    public async Task a_slow_operation_does_not_stop_the_bridge_reading_the_next_request()
    {
        // The requirement the whole asynchronous design exists for: a request
        // read stays pending while a response is written. A bridge that only
        // wrote between reads would deadlock against a facade that pipelines.
        using var gate = new SemaphoreSlim(0, 1);
        using BridgeServer server = NewServer(new GatedHandler(gate));
        server.Start();
        using CancellationTokenSource deadline = Deadline();

        using TestClient client = await TestClient.ConnectAsync(server.PipeName, deadline.Token);
        await client.HandshakeAsync(deadline.Token);

        await client.SendAsync(
            new RequestEnvelope { ProtocolVersion = WireProtocol.Version, RequestId = "slow", Operation = "slow" },
            deadline.Token);
        await client.SendAsync(
            new RequestEnvelope { ProtocolVersion = WireProtocol.Version, RequestId = "fast", Operation = "fast" },
            deadline.Token);

        // "slow" was sent first and is still blocked in the handler, so the only
        // way "fast" can come back at all is if the read loop kept reading and
        // the write happened alongside the outstanding one.
        JsonElement first = await client.ReceiveAsync(deadline.Token);
        Assert.Equal("fast", first.GetProperty("request_id").GetString());

        gate.Release();
        JsonElement second = await client.ReceiveAsync(deadline.Token);
        Assert.Equal("slow", second.GetProperty("request_id").GetString());
    }

    [Fact]
    public void the_pipe_is_readable_only_by_the_user_that_created_it()
    {
        using BridgeServer server = NewServer();
        server.Start();

        using var probe = new NamedPipeClientStream(
            ".", server.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        probe.Connect(5000);

        PipeSecurity security = probe.GetAccessControl();
        AuthorizationRuleCollection rules = security.GetAccessRules(
            includeExplicit: true, includeInherited: true, targetType: typeof(SecurityIdentifier));

        using WindowsIdentity self = WindowsIdentity.GetCurrent();
        var granted = rules
            .Cast<PipeAccessRule>()
            .Where(rule => rule.AccessControlType == AccessControlType.Allow)
            .ToArray();

        // Exactly one allow entry, and it is us. Anyone else is denied by
        // omission; the pipe name is not doing any of this work.
        Assert.Single(granted);
        Assert.Equal(self.User, granted[0].IdentityReference);
        Assert.True(granted[0].PipeAccessRights.HasFlag(PipeAccessRights.ReadWrite));

        // CreateNewInstance specifically: without it the first pipe instance
        // succeeds and every later one fails with access denied.
        Assert.True(granted[0].PipeAccessRights.HasFlag(PipeAccessRights.CreateNewInstance));
    }

    private sealed class GatedHandler : IRequestHandler
    {
        private readonly SemaphoreSlim _gate;

        public GatedHandler(SemaphoreSlim gate) => _gate = gate;

        public async Task<RequestOutcome> HandleAsync(
            RequestEnvelope request,
            CancellationToken cancellationToken)
        {
            if (request.Operation == "slow")
            {
                await _gate.WaitAsync(cancellationToken);
            }

            return RequestOutcome.Ok(new ResponseEnvelope
            {
                RequestId = request.RequestId,
                Status = ResponseStatus.Ok,
                DurationMs = 0,
            });
        }
    }
}
