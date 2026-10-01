// Runs every guide example. Each one is spliced into a page of the documentation
// site by `cargo xtask docs`, so every C# example the site shows is code that ran.
using Guides;

// An argument names one guide to run; without one every guide runs, which is what CI does.
var guides = new Dictionary<string, Func<Task>>(StringComparer.Ordinal)
{
    ["version"] = () => { VersionGuide.Run(); return Task.CompletedTask; },
};

var only = args.Length > 0 ? args[0] : null;
if (only is not null && !guides.ContainsKey(only))
{
    Console.Error.WriteLine($"no guide named {only}; try one of: {string.Join(", ", guides.Keys)}");
    return 1;
}

foreach (var (name, run) in guides)
{
    if (only is not null && name != only)
    {
        continue;
    }

    await run();
}

Console.WriteLine("guides ok");
return 0;
