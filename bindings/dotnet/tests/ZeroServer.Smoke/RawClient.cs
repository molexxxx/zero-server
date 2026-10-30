using System.Net;
using System.Net.Sockets;
using System.Text;

namespace ZeroServer.Smoke;

/// <summary>One response head and its body.</summary>
/// <param name="Status">The status code.</param>
/// <param name="Fields">The field lines in order, each value as received.</param>
/// <param name="Body">The body, as long as its <c>Content-Length</c>.</param>
internal sealed record Response(int Status, IReadOnlyList<(string Name, byte[] Value)> Fields, byte[] Body)
{
    /// <summary>The value of the first field line with a name, compared without regard to ASCII case.</summary>
    /// <param name="name">The field name.</param>
    /// <returns>The value as text, or <c>null</c> when the response has no such line.</returns>
    public string? Field(string name)
    {
        foreach ((string fieldName, byte[] value) in Fields)
        {
            if (string.Equals(fieldName, name, StringComparison.OrdinalIgnoreCase))
            {
                return Encoding.Latin1.GetString(value);
            }
        }

        return null;
    }
}

/// <summary>A loopback connection that writes raw bytes and reads HTTP/1.1 responses.</summary>
internal sealed class RawClient : IDisposable
{
    private readonly TcpClient _client;
    private readonly NetworkStream _stream;
    private readonly byte[] _buffer = new byte[16384];
    private int _start;
    private int _end;

    /// <summary>Connects to a server.</summary>
    /// <param name="address">The address it listens on.</param>
    public RawClient(IPEndPoint address)
    {
        _client = new TcpClient(address.AddressFamily)
        {
            NoDelay = true,
            ReceiveTimeout = (int)Check.Patience.TotalMilliseconds,
            SendTimeout = (int)Check.Patience.TotalMilliseconds,
        };
        _client.Connect(address);
        _stream = _client.GetStream();
    }

    /// <summary>Writes bytes.</summary>
    /// <param name="bytes">The bytes.</param>
    public void Send(ReadOnlySpan<byte> bytes) => _stream.Write(bytes);

    /// <summary>Reads one response, with a body as long as its <c>Content-Length</c>.</summary>
    /// <param name="headOnly">Read the head alone, for a HEAD request or an upgrade.</param>
    /// <returns>The response.</returns>
    public Response Read(bool headOnly = false)
    {
        List<byte> head = [];
        while (head.Count < 4 || head[^4] != '\r' || head[^3] != '\n' || head[^2] != '\r' || head[^1] != '\n')
        {
            int next = ReadByte();
            Check.That(next >= 0, $"the connection closed inside a response head: {Encoding.Latin1.GetString(head.ToArray())}");
            head.Add((byte)next);
        }

        string[] lines = Encoding.Latin1.GetString(head.ToArray()).TrimEnd().Split("\r\n");
        string[] statusLine = lines[0].Split(' ');
        Check.That(statusLine.Length >= 2 && statusLine[0].StartsWith("HTTP/1.", StringComparison.Ordinal), $"a status line: {lines[0]}");
        List<(string Name, byte[] Value)> fields = [];
        foreach (string line in lines.Skip(1))
        {
            int colon = line.IndexOf(':');
            Check.That(colon > 0, $"a field line: {line}");
            fields.Add((line[..colon], Encoding.Latin1.GetBytes(line[(colon + 1)..].Trim(' ', '\t'))));
        }

        Response response = new(int.Parse(statusLine[1]), fields, []);
        string? length = response.Field("Content-Length");
        if (headOnly || length is null)
        {
            return response;
        }

        return response with { Body = ReadExactly(int.Parse(length)) };
    }

    /// <summary>Reads exactly <paramref name="count"/> bytes.</summary>
    /// <param name="count">How many.</param>
    /// <returns>The bytes.</returns>
    public byte[] ReadExactly(int count)
    {
        byte[] bytes = new byte[count];
        for (int i = 0; i < count; i++)
        {
            int next = ReadByte();
            Check.That(next >= 0, $"the connection closed after {i} of {count} bytes");
            bytes[i] = (byte)next;
        }

        return bytes;
    }

    /// <summary>Whether the server closes the connection with nothing more to read.</summary>
    /// <returns><c>true</c> when the next read finds the end of the stream.</returns>
    public bool Closes()
    {
        try
        {
            return ReadByte() < 0;
        }
        catch (IOException error) when (error.InnerException is SocketException { SocketErrorCode: SocketError.ConnectionReset })
        {
            return true;
        }
    }

    /// <inheritdoc/>
    public void Dispose() => _client.Dispose();

    private int ReadByte()
    {
        if (_start == _end)
        {
            _start = 0;
            _end = _stream.Read(_buffer, 0, _buffer.Length);
            if (_end == 0)
            {
                return -1;
            }
        }

        return _buffer[_start++];
    }
}
