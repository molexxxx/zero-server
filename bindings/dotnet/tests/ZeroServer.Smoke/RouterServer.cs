using System.Net;
using System.Text;
using System.Text.Json;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// The <c>router</c> vector table registered through <c>zero_app_route</c> and
/// <c>zero_app_mount</c> on a one-thread server, each vector id mapped to the route id the
/// registration returned. Every case is one request line over its own connection: a match
/// is echoed by the handler (route, parameters, path, query and the HEAD flag), and a miss
/// is the core's own answer, its status and <c>Allow</c>.
/// </summary>
internal sealed unsafe class RouterServer
{
    private readonly Dictionary<uint, (int Vector, string[] Params)> _routes = [];
    private readonly ulong _app;
    private readonly ulong _server;
    private readonly ulong _target;
    private readonly PullLoop _loop;
    private readonly IPEndPoint _address;

    /// <summary>Registers the table, starts the loop and the server.</summary>
    /// <param name="table">The section's <c>table</c>.</param>
    public RouterServer(JsonElement table)
    {
        Check.Equal("ignore", table.GetProperty("trailingSlash").GetString(), "the trailing slash rule of the table, the router's default");
        _app = Native.AppNew();
        foreach (JsonElement route in table.GetProperty("routes").EnumerateArray())
        {
            Register(route);
        }

        foreach (JsonElement mount in table.GetProperty("mounts").EnumerateArray())
        {
            ulong child = Native.AppNew();
            List<(uint Id, JsonElement Route)> registered = [];
            foreach (JsonElement route in mount.GetProperty("routes").EnumerateArray())
            {
                registered.Add((Native.Route(child, Native.RouteHost, Method(route), route.GetProperty("pattern").GetString()!, ""), route));
            }

            uint grew = Native.Mount(_app, mount.GetProperty("prefix").GetString()!, child);
            foreach ((uint id, JsonElement route) in registered)
            {
                _routes.Add(id + grew, (route.GetProperty("id").GetInt32(), Params(route.GetProperty("pattern").GetString()!)));
            }
        }

        _server = Native.ServerNew(_app);
        _target = Native.Attach(_server, Native.Worker(_server));
        _loop = new PullLoop("zero-router", _target, OnRequest, occurrence => throw new SmokeFailure($"an event {occurrence.kind} on the router server"));
        _loop.Start();
        Check.Ok(NativeMethods.zero_server_start(_server), "zero_server_start");
        _address = Native.Address(_server);
    }

    /// <summary>Sends every case and checks the match or the core's answer.</summary>
    /// <param name="cases">The section's <c>cases</c>.</param>
    /// <returns>How many cases ran.</returns>
    public int Run(JsonElement cases)
    {
        int ran = 0;
        foreach (JsonElement item in cases.EnumerateArray())
        {
            string method = item.GetProperty("method").GetString()!;
            string target = item.GetProperty("target").GetString()!;
            string what = $"router {item.GetProperty("name").GetString()} ({method} {target})";
            JsonElement expect = item.GetProperty("expect");
            using RawClient client = new(_address);
            client.Send(Encoding.ASCII.GetBytes($"{method} {target} HTTP/1.1\r\nHost: www.example.org\r\n\r\n"));
            Response response = client.Read(headOnly: method == "HEAD");
            if (expect.TryGetProperty("matched", out JsonElement matched))
            {
                Check.Equal(200, response.Status, $"{what}: the status of a match");
                using JsonDocument echo = JsonDocument.Parse(response.Field("X-Echo") ?? throw new SmokeFailure($"{what}: no echo"));
                Json.Match(matched, echo.RootElement, what);
            }
            else
            {
                Check.Equal(expect.GetProperty("status").GetInt32(), response.Status, $"{what}: the status");
                Check.That(response.Field("X-Echo") is null, $"{what}: the core answers a miss without the host");
                if (expect.TryGetProperty("allow", out JsonElement allow))
                {
                    Check.Equal(allow.GetString(), response.Field("Allow"), $"{what}: Allow");
                }
            }

            ran++;
        }

        _loop.AssertSound("router");
        Check.That(_loop.Thrown.IsEmpty, $"router: a handler threw: {string.Join("; ", _loop.Thrown.Select(error => error.Message))}");
        return ran;
    }

    /// <summary>Detaches the target, stops the server and frees the app.</summary>
    public void Stop()
    {
        Check.Ok(NativeMethods.zero_target_detach(_target), "zero_target_detach");
        Check.That(_loop.Join(), "the router's pull loop ends once its target is detached");
        Check.Equal(ZeroStatus.Closed, _loop.Exit, "the status of the router's blocked poll after the detach");
        Native.Stop(_server);
        Check.Ok(NativeMethods.zero_app_free(_app), "zero_app_free");
    }

    private static byte Method(JsonElement route) => Native.Methods[route.GetProperty("method").GetString()!];

    private static string[] Params(string pattern) => pattern
        .Split('/')
        .Where(segment => segment.StartsWith(':') || segment.StartsWith('*'))
        .Select(segment => segment == "*" ? "*" : segment[1..])
        .ToArray();

    private void Register(JsonElement route)
    {
        string pattern = route.GetProperty("pattern").GetString()!;
        uint id = Native.Route(_app, Native.RouteHost, Method(route), pattern, "");
        _routes.Add(id, (route.GetProperty("id").GetInt32(), Params(pattern)));
    }

    private void OnRequest(ulong slot, uint route)
    {
        Check.That(_routes.TryGetValue(route, out (int Vector, string[] Params) entry), $"a request on route {route}, which the table does not hold");
        RequestView view = RequestView.Read(slot);
        Check.Equal(entry.Params.Length, view.ParamCount, $"the parameters of route {entry.Vector}");
        using MemoryStream buffer = new();
        using (Utf8JsonWriter writer = new(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("id", entry.Vector);
            writer.WriteBoolean("head", view.HeadAsGet);
            writer.WritePropertyName("path");
            Json.WriteOctets(writer, view.RoutePath);
            writer.WritePropertyName("query");
            if (view.Query is byte[] query)
            {
                Json.WriteOctets(writer, query);
            }
            else
            {
                writer.WriteNullValue();
            }

            writer.WriteStartArray("params");
            for (int i = 0; i < view.ParamCount; i++)
            {
                ZeroBytes value;
                Check.Ok(NativeMethods.zero_req_param(slot, (uint)i, &value), "zero_req_param");
                writer.WriteStartArray();
                writer.WriteStringValue(entry.Params[i]);
                Json.WriteOctets(writer, Native.Copy(value) ?? throw new SmokeFailure($"parameter {i} is absent"));
                writer.WriteEndArray();
            }

            writer.WriteEndArray();
            writer.WriteEndObject();
        }

        Reply.Send(slot, 200, [("X-Echo", Encoding.ASCII.GetString(buffer.ToArray()))], []);
    }
}
