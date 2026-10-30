using System.Text;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// The request of a leased slot read in one <c>zero_req_view</c>, with spans into the slot.
/// </summary>
/// <remarks>
/// The spans are valid only under the view rule: on the slot's target thread before it
/// acknowledges the delivering batch, or while the thread pins the slot. A
/// <see langword="ref"/> struct cannot be stored or captured, so a view never outlives the
/// handler call that read it.
/// </remarks>
internal readonly unsafe ref struct RequestView
{
    private readonly ZeroRequestView _view;

    private RequestView(ZeroRequestView view)
    {
        _view = view;
    }

    /// <summary>Gets the head as received; every span indexes it.</summary>
    public ReadOnlySpan<byte> Head => new(_view.head, checked((int)_view.head_len));

    /// <summary>Gets the method token.</summary>
    public ReadOnlySpan<byte> MethodToken => Of(_view.method_token);

    /// <summary>Gets the request target.</summary>
    public ReadOnlySpan<byte> Target => Of(_view.target);

    /// <summary>Gets the query without its <c>?</c>, or <c>null</c> when the target has none.</summary>
    public byte[]? Query => (_view.flags & Native.ViewQuery) != 0 ? Of(_view.query).ToArray() : null;

    /// <summary>Gets the normalized path the route matched.</summary>
    public ReadOnlySpan<byte> RoutePath => new(_view.route_path, checked((int)_view.route_path_len));

    /// <summary>Gets the protocol version as the request line spells it.</summary>
    public string Version => _view.version switch
    {
        10 => "HTTP/1.0",
        11 => "HTTP/1.1",
        _ => throw new SmokeFailure($"the view reports version {_view.version}"),
    };

    /// <summary>Gets whether the connection stays open after the response.</summary>
    public bool KeepAlive => (_view.flags & Native.ViewKeepAlive) != 0;

    /// <summary>Gets whether a HEAD request matched a GET route.</summary>
    public bool HeadAsGet => (_view.flags & Native.ViewHeadAsGet) != 0;

    /// <summary>Gets the number of route parameters.</summary>
    public int ParamCount => checked((int)_view.param_count);

    /// <summary>Gets the number of field lines.</summary>
    public int FieldCount => checked((int)_view.field_count);

    /// <summary>Gets the length of the buffered body.</summary>
    public ulong BodyLength => _view.body_len;

    /// <summary>Reads the view of a slot.</summary>
    /// <param name="slot">The slot's id.</param>
    /// <returns>The view.</returns>
    public static RequestView Read(ulong slot)
    {
        ZeroRequestView view = default;
        view.size = (uint)sizeof(ZeroRequestView);
        Check.Ok(NativeMethods.zero_req_view(slot, &view), "zero_req_view");
        Check.Equal((uint)sizeof(ZeroRequestView), view.size, "the octets zero_req_view wrote");
        Check.That(view.field_size >= (uint)sizeof(ZeroField), "the stride of the field table");
        return new RequestView(view);
    }

    /// <summary>The name of a field line.</summary>
    /// <param name="index">The line's position.</param>
    /// <returns>The name as received.</returns>
    public ReadOnlySpan<byte> FieldName(int index) => Of(Field(index).name);

    /// <summary>The value of a field line.</summary>
    /// <param name="index">The line's position.</param>
    /// <returns>The value without its surrounding whitespace.</returns>
    public ReadOnlySpan<byte> FieldValue(int index) => Of(Field(index).value);

    /// <summary>The value of the first field line with a name, compared without regard to ASCII case.</summary>
    /// <param name="name">The field name.</param>
    /// <returns>The value, or <c>null</c> when the request has no such line.</returns>
    public string? FieldText(string name)
    {
        for (int i = 0; i < FieldCount; i++)
        {
            if (Ascii.EqualsIgnoreCase(FieldName(i), Encoding.ASCII.GetBytes(name)))
            {
                return Encoding.UTF8.GetString(FieldValue(i));
            }
        }

        return null;
    }

    private ZeroField Field(int index)
    {
        Check.That((uint)index < _view.field_count, $"field {index} of {_view.field_count}");
        return *(ZeroField*)((byte*)_view.fields + ((nuint)index * _view.field_size));
    }

    private ReadOnlySpan<byte> Of(ZeroSpan span) => Head.Slice(checked((int)span.start), checked((int)span.len));
}
