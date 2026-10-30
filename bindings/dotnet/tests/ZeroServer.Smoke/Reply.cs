using System.Text;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>Writes a whole response in one <c>zero_res_respond</c>.</summary>
internal static unsafe class Reply
{
    /// <summary>Answers a slot with a status, field lines and a body, and seals it.</summary>
    /// <param name="slot">The slot's id.</param>
    /// <param name="status">The status.</param>
    /// <param name="fields">The field lines, appended in order.</param>
    /// <param name="body">The body.</param>
    public static void Send(ulong slot, ushort status, IReadOnlyList<(string Name, string Value)> fields, ReadOnlySpan<byte> body)
    {
        byte[][] parts = fields
            .SelectMany(field => new[] { Encoding.ASCII.GetBytes(field.Name), Encoding.ASCII.GetBytes(field.Value) })
            .ToArray();
        byte[] blob = new byte[Math.Max(1, parts.Sum(part => part.Length))];
        int[] offsets = new int[parts.Length];
        int at = 0;
        for (int i = 0; i < parts.Length; i++)
        {
            offsets[i] = at;
            parts[i].CopyTo(blob, at);
            at += parts[i].Length;
        }

        ZeroHeaderPair* pairs = stackalloc ZeroHeaderPair[fields.Count];
        fixed (byte* blobPtr = blob)
        fixed (byte* bodyPtr = body)
        {
            for (int i = 0; i < fields.Count; i++)
            {
                pairs[i].name = new ZeroBytes { ptr = blobPtr + offsets[2 * i], len = (nuint)parts[2 * i].Length };
                pairs[i].value = new ZeroBytes { ptr = blobPtr + offsets[(2 * i) + 1], len = (nuint)parts[(2 * i) + 1].Length };
            }

            ZeroResponseSpec spec = default;
            spec.size = (uint)sizeof(ZeroResponseSpec);
            spec.status = status;
            spec.field_size = (uint)sizeof(ZeroHeaderPair);
            spec.fields = pairs;
            spec.field_count = (nuint)fields.Count;
            spec.body = new ZeroBytes { ptr = bodyPtr, len = (nuint)body.Length };
            Check.Ok(NativeMethods.zero_res_respond(slot, &spec), "zero_res_respond");
        }
    }
}
