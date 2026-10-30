using System.Text;
using System.Text.Json;
using System.Text.Unicode;

namespace ZeroServer.Smoke;

/// <summary>
/// JSON as the conformance vectors use it: two documents are compared as values, so member
/// order and whitespace do not matter, and decoded octets are a string when they are UTF-8
/// and <c>{"hex": ...}</c> otherwise (<c>conformance/README.md</c>).
/// </summary>
internal static class Json
{
    /// <summary>Compares two values, recording every difference with its path.</summary>
    /// <param name="expected">The value the vectors hold.</param>
    /// <param name="actual">The value computed.</param>
    /// <param name="tolerance">The absolute tolerance of a number that is not an integer.</param>
    /// <param name="path">Where the values are, for the differences.</param>
    /// <param name="differences">Receives one line per difference.</param>
    /// <param name="skip">Members of the top-level objects left out of the comparison.</param>
    public static void Compare(
        JsonElement expected,
        JsonElement actual,
        double tolerance,
        string path,
        List<string> differences,
        IReadOnlySet<string>? skip = null)
    {
        if (expected.ValueKind != actual.ValueKind)
        {
            differences.Add($"{path}: expected {expected.GetRawText()}, got {actual.GetRawText()}");
            return;
        }

        switch (expected.ValueKind)
        {
            case JsonValueKind.Object:
                Dictionary<string, JsonElement> found = actual.EnumerateObject()
                    .Where(member => skip is null || !skip.Contains(member.Name))
                    .ToDictionary(member => member.Name, member => member.Value, StringComparer.Ordinal);
                foreach (JsonProperty member in expected.EnumerateObject())
                {
                    if (skip is not null && skip.Contains(member.Name))
                    {
                        continue;
                    }

                    if (found.Remove(member.Name, out JsonElement value))
                    {
                        Compare(member.Value, value, tolerance, $"{path}.{member.Name}", differences);
                    }
                    else
                    {
                        differences.Add($"{path}.{member.Name}: missing");
                    }
                }

                foreach (string extra in found.Keys)
                {
                    differences.Add($"{path}.{extra}: not expected");
                }

                break;
            case JsonValueKind.Array:
                int expectedLength = expected.GetArrayLength();
                int actualLength = actual.GetArrayLength();
                if (expectedLength != actualLength)
                {
                    differences.Add($"{path}: {expectedLength} entries expected, {actualLength} found");
                    return;
                }

                for (int i = 0; i < expectedLength; i++)
                {
                    Compare(expected[i], actual[i], tolerance, $"{path}[{i}]", differences);
                }

                break;
            case JsonValueKind.Number:
                bool same = expected.TryGetInt64(out long whole) && actual.TryGetInt64(out long other)
                    ? whole == other
                    : Math.Abs(expected.GetDouble() - actual.GetDouble()) <= tolerance;
                if (!same)
                {
                    differences.Add($"{path}: expected {expected.GetRawText()}, got {actual.GetRawText()}");
                }

                break;
            case JsonValueKind.String:
                if (!string.Equals(expected.GetString(), actual.GetString(), StringComparison.Ordinal))
                {
                    differences.Add($"{path}: expected {expected.GetRawText()}, got {actual.GetRawText()}");
                }

                break;
        }
    }

    /// <summary>Fails when two values differ, naming the first differences.</summary>
    /// <param name="expected">The value the vectors hold.</param>
    /// <param name="actual">The value computed.</param>
    /// <param name="what">What is compared.</param>
    /// <param name="skip">Members of the top-level objects left out of the comparison.</param>
    public static void Match(JsonElement expected, JsonElement actual, string what, IReadOnlySet<string>? skip = null)
    {
        List<string> differences = [];
        Compare(expected, actual, 0, what, differences, skip);
        Check.That(differences.Count == 0, string.Join("; ", differences.Take(8)));
    }

    /// <summary>Writes decoded octets the way the vectors do.</summary>
    /// <param name="writer">The writer.</param>
    /// <param name="octets">The octets.</param>
    public static void WriteOctets(Utf8JsonWriter writer, ReadOnlySpan<byte> octets)
    {
        if (Utf8.IsValid(octets))
        {
            writer.WriteStringValue(Encoding.UTF8.GetString(octets));
            return;
        }

        writer.WriteStartObject();
        writer.WriteString("hex", Convert.ToHexStringLower(octets));
        writer.WriteEndObject();
    }

    /// <summary>The octets a vector field holds, decoded the way <see cref="WriteOctets"/> encodes them.</summary>
    /// <param name="value">A string, or an object with a <c>hex</c> member.</param>
    /// <returns>The octets.</returns>
    public static byte[] Octets(JsonElement value) => value.ValueKind == JsonValueKind.String
        ? Encoding.UTF8.GetBytes(value.GetString()!)
        : Convert.FromHexString(value.GetProperty("hex").GetString()!);
}
