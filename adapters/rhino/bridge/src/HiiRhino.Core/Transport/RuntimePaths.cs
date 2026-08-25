using System;
using System.IO;

namespace HiiRhino.Core.Transport;

/// <summary>
/// Where HII keeps its runtime state. Mirrors <c>hii_core::runtime_root</c>.
/// </summary>
/// <remarks>
/// The rule has to match the Rust side exactly or discovery silently finds
/// nothing: the bridge writes its advertisement somewhere the facade never
/// looks, and the user sees "no Rhino instance is advertising the HII bridge"
/// while Rhino sits there with the bridge running.
/// </remarks>
public static class RuntimePaths
{
    public const string RuntimeDirectoryVariable = "HII_RUNTIME_DIR";

    /// <summary>
    /// <c>%HII_RUNTIME_DIR%</c> if set, otherwise <c>~/.hii</c>.
    /// </summary>
    /// <remarks>
    /// Rust reaches the default through <c>dirs::home_dir()</c>, which on
    /// Windows is the user profile folder; <see cref="Environment.SpecialFolder.UserProfile"/>
    /// is the same directory.
    /// </remarks>
    public static string RuntimeRoot()
    {
        string? configured = Environment.GetEnvironmentVariable(RuntimeDirectoryVariable);
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrEmpty(home))
        {
            throw new InvalidOperationException(
                "HII could not determine the home directory, and " +
                RuntimeDirectoryVariable + " is not set.");
        }
        return Path.Combine(home, ".hii");
    }

    /// <summary>Where live bridges publish themselves.</summary>
    public static string AdvertisementDirectory() =>
        Path.Combine(RuntimeRoot(), "rhino", "instances");
}
