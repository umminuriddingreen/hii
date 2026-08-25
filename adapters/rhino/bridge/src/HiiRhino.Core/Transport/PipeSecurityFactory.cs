using System;
using System.IO.Pipes;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;

namespace HiiRhino.Core.Transport;

/// <summary>Builds the DACL the bridge pipe is created with.</summary>
[SupportedOSPlatform("windows")]
public static class PipeSecurityFactory
{
    /// <summary>
    /// A discretionary ACL granting the current user, and nobody else.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A <see cref="PipeSecurity"/> with rules but no inherited entries produces
    /// a pipe whose DACL contains exactly what is added here. Everyone else,
    /// including other logon sessions on the same machine and other users of a
    /// shared workstation, is denied by omission. The pipe name plays no part in
    /// this; it is organisational only.
    /// </para>
    /// <para>
    /// The right granted is <see cref="PipeAccessRights.FullControl"/> rather
    /// than <see cref="PipeAccessRights.ReadWrite"/> on purpose. Creating a
    /// second instance of an existing pipe name requires
    /// <see cref="PipeAccessRights.CreateNewInstance"/>, which ReadWrite does
    /// not include; with ReadWrite the first instance succeeds and every
    /// subsequent one fails with access denied, which reads like a general ACL
    /// problem rather than one missing right.
    /// </para>
    /// <para>
    /// SYSTEM and Administrators are deliberately not granted. An administrator
    /// can take ownership regardless, so listing them would widen the visible
    /// surface without actually narrowing anyone's power.
    /// </para>
    /// </remarks>
    public static PipeSecurity CurrentUserOnly()
    {
        using WindowsIdentity identity = WindowsIdentity.GetCurrent();
        SecurityIdentifier user = identity.User
            ?? throw new InvalidOperationException(
                "the current Windows identity has no user SID, so the bridge pipe cannot be restricted to it");

        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            user,
            PipeAccessRights.FullControl,
            AccessControlType.Allow));
        return security;
    }
}
