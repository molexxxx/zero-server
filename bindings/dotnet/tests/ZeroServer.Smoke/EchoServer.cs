using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Text.Json;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>One WebSocket occurrence the pull loop took, its data copied out.</summary>
/// <param name="Kind">The <c>ZERO_EVENT_*</c> value.</param>
/// <param name="Conn">The connection's id.</param>
/// <param name="Opcode">The message opcode.</param>
/// <param name="Code">The close code.</param>
/// <param name="Data">The message, pong data or close reason.</param>
internal sealed record WsEvent(byte Kind, ulong Conn, byte Opcode, ushort Code, byte[]? Data);

/// <summary>
/// A one-thread server with two host routes that echo the request and a WebSocket route
/// that echoes messages, served by a <see cref="PullLoop"/>. It runs the vector sections
/// that need a live server, end to end over loopback sockets: <c>http1Parser</c>,
/// <c>responseSplitting</c> through <c>zero_res_header</c> inside the handler, and a
/// <c>ws</c> handshake, echo and close; then a throwing handler, a collection while the loop
/// blocks, and the detach that ends it.
/// </summary>
internal sealed unsafe class EchoServer
{
    private static readonly HashSet<string> Framing = ["body", "bodyLength"];

    /// <summary>
    /// The handshake fields a client matches without regard to ASCII case: "the |Upgrade|
    /// header field contains a value that is not an ASCII case-insensitive match for the
    /// value "websocket"", and the |Connection| field must hold "a token that is an ASCII
    /// case-insensitive match for the value "Upgrade"" (RFC 6455 Section 4.1, steps 2 and 3).
    /// </summary>
    /// <seealso href="https://www.rfc-editor.org/rfc/rfc6455.html#section-4.1"/>
    private static readonly HashSet<string> CaseInsensitiveTokens = new(StringComparer.OrdinalIgnoreCase) { "Upgrade", "Connection" };

    private readonly byte[][] _splitNames;
    private readonly byte[][] _splitValues;
    private readonly ulong _app;
    private readonly ulong _server;
    private readonly ulong _target;
    private readonly uint _wsRoute;
    private readonly HashSet<uint> _echoRoutes;
    private readonly PullLoop _loop;
    private readonly IPEndPoint _address;
    private readonly ConcurrentQueue<WsEvent> _events = new();

    /// <summary>Builds the app and the server, starts the loop and the server.</summary>
    /// <param name="vectors">The root of <c>vectors.json</c>.</param>
    public EchoServer(JsonElement vectors)
    {
        JsonElement split = vectors.GetProperty("responseSplitting").GetProperty("cases");
        _splitNames = split.EnumerateArray().Select(item => Encoding.UTF8.GetBytes(item.GetProperty("field").GetString()!)).ToArray();
        _splitValues = split.EnumerateArray().Select(item => Convert.FromHexString(item.GetProperty("value").GetString()!)).ToArray();
        JsonElement handshake = WsCase(vectors, "accept value for the sample key");
        string requestLine = Encoding.ASCII.GetString(Convert.FromHexString(handshake.GetProperty("request").GetString()!)).Split("\r\n")[0];
        string wsPath = requestLine.Split(' ')[1];
        string wsOptions = $$"""{"protocols":{{handshake.GetProperty("routeProtocols").GetRawText()}},"origins":{{handshake.GetProperty("routeOrigins").GetRawText()}}}""";

        _app = Native.AppNew();
        _echoRoutes =
        [
            Native.Route(_app, Native.RouteHost, Native.MethodAny, "/", ""),
            Native.Route(_app, Native.RouteHost, Native.MethodAny, "/*", ""),
        ];
        _wsRoute = Native.Route(_app, Native.RouteWebSocket, Native.Methods["GET"], wsPath, wsOptions);
        _server = Native.ServerNew(_app);
        _target = Native.Attach(_server, Native.Worker(_server));
        _loop = new PullLoop("zero-echo", _target, OnRequest, OnEvent);
        _loop.Start();
        Check.Ok(NativeMethods.zero_server_start(_server), "zero_server_start");
        _address = Native.Address(_server);
    }

    /// <summary>Sends every <c>http1Parser</c> request and checks the echo or the rejection.</summary>
    /// <param name="section">The section.</param>
    /// <returns>How many cases ran.</returns>
    public int Http1Parser(JsonElement section)
    {
        int ran = 0;
        foreach (JsonElement item in section.GetProperty("cases").EnumerateArray())
        {
            string name = item.GetProperty("name").GetString()!;
            List<byte> request = [.. Convert.FromHexString(item.GetProperty("request").GetString()!)];
            JsonElement expect = item.GetProperty("expect");
            int bodyLength = 0;
            if (expect.TryGetProperty("head", out JsonElement head))
            {
                JsonElement framing = head.GetProperty("body");
                if (framing.ValueKind == JsonValueKind.Object)
                {
                    bodyLength = framing.GetProperty("length").GetInt32();
                    request.AddRange(Enumerable.Repeat((byte)'b', bodyLength));
                }
                else if (framing.GetString() == "chunked")
                {
                    request.AddRange("0\r\n\r\n"u8.ToArray());
                }
            }

            using RawClient client = new(_address);
            client.Send(request.ToArray());
            Response response = client.Read();
            if (expect.TryGetProperty("reject", out JsonElement reject))
            {
                Check.Equal(reject.GetProperty("status").GetInt32(), response.Status, $"http1Parser {name}: the rejection");
                Check.That(response.Field("X-Echo") is null, $"http1Parser {name}: a rejected request reaches no handler");
                if (reject.GetProperty("close").GetBoolean())
                {
                    Check.That(client.Closes(), $"http1Parser {name}: the connection closes after the rejection");
                }
            }
            else
            {
                Check.Equal(200, response.Status, $"http1Parser {name}: the echo status");
                using JsonDocument echo = JsonDocument.Parse(response.Field("X-Echo") ?? throw new SmokeFailure($"http1Parser {name}: no echo"));
                Json.Match(head, echo.RootElement, $"http1Parser {name}", Framing);
                Check.Equal(bodyLength, echo.RootElement.GetProperty("bodyLength").GetInt32(), $"http1Parser {name}: the body length");
                if (!head.GetProperty("keepAlive").GetBoolean())
                {
                    Check.That(client.Closes(), $"http1Parser {name}: the connection closes after the response");
                }
            }

            ran++;
        }

        AssertSound("http1Parser");
        return ran;
    }

    /// <summary>
    /// Writes every <c>responseSplitting</c> field line through <c>zero_res_header</c> inside the
    /// handler and checks the verdict, and what reached the wire.
    /// </summary>
    /// <param name="section">The section.</param>
    /// <returns>How many cases ran.</returns>
    public int ResponseSplitting(JsonElement section)
    {
        int index = 0;
        foreach (JsonElement item in section.GetProperty("cases").EnumerateArray())
        {
            string name = item.GetProperty("name").GetString()!;
            bool accepted = item.GetProperty("accepted").GetBoolean();
            using RawClient client = new(_address);
            client.Send(Encoding.ASCII.GetBytes($"GET /split HTTP/1.1\r\nHost: a\r\nX-Smoke: split\r\nX-Case: {index}\r\n\r\n"));
            Response response = client.Read();
            Check.Equal(200, response.Status, $"responseSplitting {name}: the status");
            Check.Equal(
                accepted ? nameof(ZeroStatus.Ok) : nameof(ZeroStatus.InvalidArgument),
                response.Field("X-Split-Status"),
                $"responseSplitting {name}: zero_res_header");
            string field = Encoding.UTF8.GetString(_splitNames[index]);
            bool written = response.Fields.Any(line =>
                string.Equals(line.Name, field, StringComparison.OrdinalIgnoreCase) && line.Value.AsSpan().SequenceEqual(_splitValues[index]));
            Check.Equal(accepted, written, $"responseSplitting {name}: the field line on the wire");
            fixed (byte* namePtr = _splitNames[index])
            fixed (byte* valuePtr = _splitValues[index])
            {
                ZeroStatus validated = NativeMethods.zero_field_validate(
                    namePtr, (nuint)_splitNames[index].Length, valuePtr, (nuint)_splitValues[index].Length);
                Check.Equal(accepted ? ZeroStatus.Ok : ZeroStatus.InvalidArgument, validated, $"responseSplitting {name}: zero_field_validate");
            }

            index++;
        }

        AssertSound("responseSplitting");
        return index;
    }

    /// <summary>
    /// Opens a WebSocket with the RFC 6455 sample key, sends a masked text message the handler
    /// echoes, then a close the server answers, all with the bytes of the <c>ws</c> vectors.
    /// </summary>
    /// <param name="vectors">The root of <c>vectors.json</c>.</param>
    public void WebSocket(JsonElement vectors)
    {
        JsonElement handshake = WsCase(vectors, "accept value for the sample key");
        JsonElement message = WsCase(vectors, "masked text message");
        JsonElement close = WsCase(vectors, "close echoed with its code");
        using RawClient client = new(_address);
        client.Send(Convert.FromHexString(handshake.GetProperty("request").GetString()!));
        Response response = client.Read(headOnly: true);
        JsonElement expect = handshake.GetProperty("expect");
        Check.Equal(expect.GetProperty("status").GetInt32(), response.Status, "ws: the handshake status");
        foreach (JsonElement field in expect.GetProperty("fields").EnumerateArray())
        {
            string name = field[0].GetString()!;
            string? value = response.Field(name);
            if (CaseInsensitiveTokens.Contains(name))
            {
                Check.That(string.Equals(field[1].GetString(), value, StringComparison.OrdinalIgnoreCase), $"ws: the {name} field: expected {field[1].GetString()}, got {value}");
            }
            else
            {
                Check.Equal(field[1].GetString(), value, $"ws: the {name} field");
            }
        }

        Check.That(response.Field("Sec-WebSocket-Protocol") is null, "ws: no subprotocol was chosen");

        JsonElement text = message.GetProperty("expect").GetProperty("events")[0];
        Check.Equal("text", text.GetProperty("type").GetString(), "ws: the message vector");
        byte[] data = Convert.FromHexString(text.GetProperty("data").GetString()!);
        Check.That(data.Length < 126, "ws: the echo fits a frame with a one-octet length");
        client.Send(Convert.FromHexString(message.GetProperty("clientFrames").GetString()!));
        byte[] echoed = client.ReadExactly(2 + data.Length);
        Check.Equal(Convert.ToHexStringLower([0x81, (byte)data.Length, .. data]), Convert.ToHexStringLower(echoed), "ws: the echoed frame");
        Check.WaitFor(
            () => _events.Any(item => item.Kind == Native.EventWsMessage && item.Opcode == Native.OpcodeText && item.Data is not null && item.Data.AsSpan().SequenceEqual(data)),
            "the WebSocket message event");
        Check.That(_events.Any(item => item.Kind == Native.EventWsOpen), "ws: the open event came first");

        JsonElement closing = close.GetProperty("expect");
        byte[] serverFrames = Convert.FromHexString(closing.GetProperty("serverFrames").GetString()!);
        client.Send(Convert.FromHexString(close.GetProperty("clientFrames").GetString()!));
        Check.Equal(Convert.ToHexStringLower(serverFrames), Convert.ToHexStringLower(client.ReadExactly(serverFrames.Length)), "ws: the server's close frame");
        Check.That(client.Closes(), "ws: the connection ends after the closing handshake");
        int code = closing.GetProperty("events")[0].GetProperty("code").GetInt32();
        Check.WaitFor(() => _events.Any(item => item.Kind == Native.EventWsClose && item.Code == code), "the WebSocket close event");
        AssertSound("ws");
    }

    /// <summary>A handler that throws is answered 500 by the loop, and the next request succeeds.</summary>
    public void ThrowingHandler()
    {
        using RawClient client = new(_address);
        client.Send("GET /boom HTTP/1.1\r\nHost: a\r\nX-Smoke: throw\r\n\r\n"u8);
        Check.Equal(500, client.Read().Status, "a handler that throws is answered 500");
        Check.That(
            _loop.Thrown.Count == 1 && _loop.Thrown.TryDequeue(out Exception? thrown) && thrown is HandlerThrew,
            "the loop caught the handler's exception");
        client.Send("GET /after HTTP/1.1\r\nHost: a\r\n\r\n"u8);
        Check.Equal(200, client.Read().Status, "the request after a throwing handler succeeds");
        AssertSound("a throwing handler");
    }

    /// <summary>A full collection on another thread returns while the loop blocks in <c>zero_target_poll</c>.</summary>
    public void CollectionWhilePolling()
    {
        Check.WaitFor(() => _loop.BlockedInPoll, "the pull loop to block in zero_target_poll");
        long before = _loop.Batches;
        Thread collector = new(() =>
        {
            GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
            GC.WaitForPendingFinalizers();
            GC.Collect();
        })
        {
            IsBackground = true,
            Name = "zero-collector",
        };
        collector.Start();
        Check.That(collector.Join(Check.Patience), "a full collection returns while the pull loop blocks in zero_target_poll");
        Check.That(_loop.BlockedInPoll && _loop.Batches == before, "the pull loop stayed in zero_target_poll through the collection");
        using RawClient client = new(_address);
        client.Send("GET /after-gc HTTP/1.1\r\nHost: a\r\n\r\n"u8);
        Check.Equal(200, client.Read().Status, "the poll returns a batch after the collection");
        Check.That(_loop.Batches > before, "the loop took the batch");
        AssertSound("a collection while polling");
    }

    /// <summary>Detaching the target makes the blocked poll return <c>Closed</c>, then the server stops.</summary>
    public void DetachAndStop()
    {
        Check.WaitFor(() => _loop.BlockedInPoll, "the pull loop to block in zero_target_poll");
        Check.Ok(NativeMethods.zero_target_detach(_target), "zero_target_detach");
        Check.That(_loop.Join(), "the pull loop ends once its target is detached");
        Check.Equal(ZeroStatus.Closed, _loop.Exit, "the status of the blocked poll after the detach");
        Check.Equal(ZeroStatus.Closed, NativeMethods.zero_target_detach(_target), "a second detach of the target");
        using (RawClient client = new(_address))
        {
            client.Send("GET /detached HTTP/1.1\r\nHost: a\r\n\r\n"u8);
            Check.Equal(503, client.Read().Status, "a host request with no target attached");
        }

        AssertSound("the detach");
        Native.Stop(_server);
        Check.Ok(NativeMethods.zero_app_free(_app), "zero_app_free");
    }

    private static JsonElement WsCase(JsonElement vectors, string name) =>
        vectors.GetProperty("ws").GetProperty("cases").EnumerateArray()
            .Single(item => item.GetProperty("name").GetString() == name);

    private void AssertSound(string what)
    {
        _loop.AssertSound(what);
        Check.That(_loop.Thrown.IsEmpty, $"{what}: a handler threw: {string.Join("; ", _loop.Thrown.Select(error => error.Message))}");
    }

    private void OnRequest(ulong slot, uint route)
    {
        if (route == _wsRoute)
        {
            ulong conn;
            Check.Ok(NativeMethods.zero_res_ws_accept(slot, null, 0, &conn), "zero_res_ws_accept");
            return;
        }

        Check.That(_echoRoutes.Contains(route), $"a request on route {route}");
        RequestView view = RequestView.Read(slot);
        switch (view.FieldText("X-Smoke"))
        {
            case "throw":
                throw new HandlerThrew();
            case "split":
                Split(slot, int.Parse(view.FieldText("X-Case")!));
                return;
            default:
                Reply.Send(slot, 200, [("X-Echo", Echo(view))], []);
                return;
        }
    }

    private void Split(ulong slot, int index)
    {
        ZeroStatus status;
        fixed (byte* namePtr = _splitNames[index])
        fixed (byte* valuePtr = _splitValues[index])
        {
            status = NativeMethods.zero_res_header(
                slot, namePtr, (nuint)_splitNames[index].Length, valuePtr, (nuint)_splitValues[index].Length, Native.HeaderAppend);
        }

        Reply.Send(slot, 200, [("X-Split-Status", status.ToString())], []);
    }

    private static string Echo(RequestView view)
    {
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            writer.WriteString("method", Encoding.ASCII.GetString(view.MethodToken));
            writer.WritePropertyName("target");
            Json.WriteOctets(writer, view.Target);
            writer.WriteString("version", view.Version);
            writer.WriteStartArray("fields");
            for (int i = 0; i < view.FieldCount; i++)
            {
                writer.WriteStartArray();
                Json.WriteOctets(writer, view.FieldName(i));
                Json.WriteOctets(writer, view.FieldValue(i));
                writer.WriteEndArray();
            }

            writer.WriteEndArray();
            writer.WriteBoolean("keepAlive", view.KeepAlive);
            writer.WriteNumber("bodyLength", view.BodyLength);
            writer.WriteEndObject();
        }

        return Encoding.ASCII.GetString(buffer.ToArray());
    }

    private void OnEvent(ZeroEvent occurrence)
    {
        _events.Enqueue(new WsEvent(occurrence.kind, occurrence.conn, occurrence.opcode, occurrence.close_code, Native.Copy(occurrence.data)));
        if (occurrence.kind == Native.EventWsMessage)
        {
            Check.Ok(NativeMethods.zero_ws_send(occurrence.conn, occurrence.opcode, occurrence.data.ptr, occurrence.data.len), "zero_ws_send");
        }
    }
}

/// <summary>The exception the throwing handler raises on purpose.</summary>
internal sealed class HandlerThrew() : Exception("the handler threw on purpose");
