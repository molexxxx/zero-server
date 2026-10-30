using System.Net;
using System.Text;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>The constants of <c>zero.h</c> the smoke uses, and calls with valid arguments.</summary>
internal static unsafe class Native
{
    /// <summary><c>ZERO_ABI_VERSION</c>.</summary>
    public const uint AbiVersion = 1;

    /// <summary><c>ZERO_ID_MAX</c>, 2^53 - 1.</summary>
    public const ulong IdMax = 9007199254740991;

    /// <summary><c>ZERO_NONE</c>.</summary>
    public const ulong None = ulong.MaxValue;

    /// <summary><c>ZERO_MAX_BATCH</c>.</summary>
    public const int MaxBatch = 256;

    /// <summary><c>ZERO_METHOD_ANY</c>.</summary>
    public const byte MethodAny = 254;

    /// <summary><c>ZERO_HEADER_APPEND</c>.</summary>
    public const uint HeaderAppend = 1;

    /// <summary><c>ZERO_BATCH_REQUESTS</c>.</summary>
    public const byte BatchRequests = 1;

    /// <summary><c>ZERO_EVENT_WS_OPEN</c>.</summary>
    public const byte EventWsOpen = 1;

    /// <summary><c>ZERO_EVENT_WS_MESSAGE</c>.</summary>
    public const byte EventWsMessage = 2;

    /// <summary><c>ZERO_EVENT_WS_CLOSE</c>.</summary>
    public const byte EventWsClose = 4;

    /// <summary><c>ZERO_OPCODE_TEXT</c>.</summary>
    public const byte OpcodeText = 1;

    /// <summary><c>ZERO_VIEW_KEEP_ALIVE</c>.</summary>
    public const ushort ViewKeepAlive = 4;

    /// <summary><c>ZERO_VIEW_HEAD_AS_GET</c>.</summary>
    public const ushort ViewHeadAsGet = 16;

    /// <summary><c>ZERO_VIEW_QUERY</c>.</summary>
    public const ushort ViewQuery = 32;

    /// <summary><c>ZERO_ROUTE_HOST</c>.</summary>
    public const uint RouteHost = 0;

    /// <summary><c>ZERO_ROUTE_WEBSOCKET</c>.</summary>
    public const uint RouteWebSocket = 4;

    /// <summary>The <c>ZERO_METHOD_*</c> ids of the method table, by token.</summary>
    public static readonly IReadOnlyDictionary<string, byte> Methods = new Dictionary<string, byte>(StringComparer.Ordinal)
    {
        ["GET"] = 0,
        ["HEAD"] = 1,
        ["POST"] = 2,
        ["PUT"] = 3,
        ["DELETE"] = 4,
        ["CONNECT"] = 5,
        ["OPTIONS"] = 6,
        ["TRACE"] = 7,
        ["PATCH"] = 8,
    };

    /// <summary>Creates an app.</summary>
    /// <returns>The app's id.</returns>
    public static ulong AppNew()
    {
        ulong app;
        Check.Ok(NativeMethods.zero_app_new(&app), "zero_app_new");
        return app;
    }

    /// <summary>Registers a route.</summary>
    /// <param name="app">The app's id.</param>
    /// <param name="kind">A <c>ZERO_ROUTE_*</c> value.</param>
    /// <param name="method">A <c>ZERO_METHOD_*</c> id.</param>
    /// <param name="pattern">The path pattern.</param>
    /// <param name="options">The JSON option document.</param>
    /// <returns>The route's id.</returns>
    public static uint Route(ulong app, uint kind, byte method, string pattern, string options)
    {
        byte[] patternBytes = Encoding.UTF8.GetBytes(pattern);
        byte[] optionBytes = Encoding.UTF8.GetBytes(options);
        uint route;
        fixed (byte* patternPtr = patternBytes)
        fixed (byte* optionPtr = optionBytes)
        {
            Check.Ok(
                NativeMethods.zero_app_route(
                    app,
                    kind,
                    method,
                    patternPtr,
                    (nuint)patternBytes.Length,
                    optionPtr,
                    (nuint)optionBytes.Length,
                    &route),
                $"zero_app_route {pattern}");
        }

        return route;
    }

    /// <summary>Mounts <paramref name="child"/> under <paramref name="prefix"/> of <paramref name="app"/>.</summary>
    /// <param name="app">The parent's id.</param>
    /// <param name="prefix">The prefix.</param>
    /// <param name="child">The child's id, consumed.</param>
    /// <returns>How much every child route id grew.</returns>
    public static uint Mount(ulong app, string prefix, ulong child)
    {
        byte[] prefixBytes = Encoding.UTF8.GetBytes(prefix);
        uint grew;
        fixed (byte* prefixPtr = prefixBytes)
        {
            Check.Ok(
                NativeMethods.zero_app_mount(app, prefixPtr, (nuint)prefixBytes.Length, child, &grew),
                $"zero_app_mount {prefix}");
        }

        return grew;
    }

    /// <summary>Builds a one-thread server on the loopback address from an app.</summary>
    /// <param name="app">The app's id.</param>
    /// <returns>The server's id.</returns>
    public static ulong ServerNew(ulong app)
    {
        byte[] options = """{"host":"127.0.0.1","port":0,"threads":1}"""u8.ToArray();
        ulong server;
        fixed (byte* optionPtr = options)
        {
            Check.Ok(NativeMethods.zero_server_new(app, optionPtr, (nuint)options.Length, &server), "zero_server_new");
        }

        return server;
    }

    /// <summary>The worker index of a one-thread server.</summary>
    /// <param name="server">The server's id.</param>
    /// <returns>Its only worker index.</returns>
    public static byte Worker(ulong server)
    {
        byte* workers = stackalloc byte[128];
        nuint count;
        Check.Ok(NativeMethods.zero_server_workers(server, workers, 128, &count), "zero_server_workers");
        Check.Equal((nuint)1, count, "the worker indexes of a one-thread server");
        return workers[0];
    }

    /// <summary>Attaches a pull target to a worker index.</summary>
    /// <param name="server">The server's id.</param>
    /// <param name="worker">The worker index.</param>
    /// <returns>The target's id.</returns>
    public static ulong Attach(ulong server, byte worker)
    {
        ulong target;
        Check.Ok(NativeMethods.zero_target_attach(server, worker, &target), "zero_target_attach");
        return target;
    }

    /// <summary>The address a running server listens on.</summary>
    /// <param name="server">The server's id.</param>
    /// <returns>The address.</returns>
    public static IPEndPoint Address(ulong server)
    {
        nint address;
        Check.Ok(NativeMethods.zero_server_address(server, &address), "zero_server_address");
        return IPEndPoint.Parse(OwnedString.Read(address));
    }

    /// <summary>Requests the drain of a server, waits for it to stop, and frees it.</summary>
    /// <param name="server">The server's id.</param>
    public static void Stop(ulong server)
    {
        Check.Ok(NativeMethods.zero_server_shutdown(server, None), "zero_server_shutdown");
        Check.Ok(NativeMethods.zero_server_wait(server, (ulong)Check.Patience.TotalMilliseconds), "zero_server_wait");
        Check.Ok(NativeMethods.zero_server_free(server), "zero_server_free");
    }

    /// <summary>Copies a view out: <c>null</c> for an absent one.</summary>
    /// <param name="bytes">The view, which the caller may read under the view rule.</param>
    /// <returns>Its octets.</returns>
    public static byte[]? Copy(ZeroBytes bytes)
    {
        if (bytes.ptr == null)
        {
            Check.Equal((nuint)0, bytes.len, "the length of an absent view");
            return null;
        }

        return new ReadOnlySpan<byte>(bytes.ptr, checked((int)bytes.len)).ToArray();
    }
}
