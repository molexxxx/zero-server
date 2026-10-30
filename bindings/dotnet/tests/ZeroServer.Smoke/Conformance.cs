using System.Text;
using System.Text.Json;

using ZeroServer.Native.Interop;

namespace ZeroServer.Smoke;

/// <summary>
/// Every codec section of <c>conformance/vectors.json</c> through <c>zero_conformance_case</c>:
/// the section goes in, and the result, every outcome computed again by the parsers and
/// encoders the server uses, must equal it as a JSON value. A section this runner does not
/// know fails the run, so no section passes unread.
/// </summary>
internal static unsafe class Conformance
{
    /// <summary>The sections this runner knows.</summary>
    public static readonly string[] Sections = ["http1Parser", "responseSplitting", "router", "ws", "sse", "qpack", "h3Frames"];

    /// <summary>Reads the vectors copied beside the executable.</summary>
    /// <returns>The parsed file.</returns>
    public static JsonDocument Load() =>
        JsonDocument.Parse(File.ReadAllBytes(Path.Combine(AppContext.BaseDirectory, "vectors.json")));

    /// <summary>Runs every section.</summary>
    /// <param name="vectors">The parsed vectors.</param>
    /// <returns>How many sections were compared.</returns>
    public static int Run(JsonDocument vectors)
    {
        double tolerance = vectors.RootElement.GetProperty("tolerance").GetDouble();
        int ran = 0;
        foreach (JsonProperty section in vectors.RootElement.EnumerateObject())
        {
            if (section.Name is "note" or "tolerance")
            {
                continue;
            }

            Check.That(Sections.Contains(section.Name), $"vectors.json holds the section {section.Name}, which this runner does not know");
            ZeroStatus status = Case(section.Name, section.Value.GetRawText(), out byte[] result);
            Check.Ok(status, $"zero_conformance_case {section.Name}");
            using JsonDocument computed = JsonDocument.Parse(result);
            List<string> differences = [];
            Json.Compare(section.Value, computed.RootElement, tolerance, section.Name, differences);
            Check.That(differences.Count == 0, $"the {section.Name} section computed again differs: {string.Join("; ", differences.Take(8))}");
            ran++;
        }

        Check.Equal(Sections.Length, ran, "the sections of vectors.json");
        Check.Equal(ZeroStatus.Unsupported, Case("notASection", "{}", out _), "zero_conformance_case of an unknown section");
        Check.Equal(ZeroStatus.Codec, Case("router", "{", out _), "zero_conformance_case of a document that is not JSON");
        return ran;
    }

    /// <summary>Calls the conformance entry.</summary>
    /// <param name="section">The section's name.</param>
    /// <param name="input">The JSON document.</param>
    /// <param name="result">Receives the result on success.</param>
    /// <returns>The status of the call.</returns>
    private static ZeroStatus Case(string section, string input, out byte[] result)
    {
        byte[] name = Encoding.UTF8.GetBytes(section);
        byte[] document = Encoding.UTF8.GetBytes(input);
        nint buffer;
        ZeroStatus status;
        fixed (byte* namePtr = name)
        fixed (byte* documentPtr = document)
        {
            status = NativeMethods.zero_conformance_case(namePtr, (nuint)name.Length, documentPtr, (nuint)document.Length, &buffer);
        }

        result = status == ZeroStatus.Ok ? OwnedBuffer.Take(buffer) : [];
        return status;
    }
}
