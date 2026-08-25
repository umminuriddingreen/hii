using System.Text.Json.Serialization;

namespace HiiRhino.Core.Protocol;

/// <summary>Mirrors <c>hii_rhino_protocol::RetryDisposition</c>.</summary>
[JsonConverter(typeof(SnakeCaseEnumConverter<RetryDisposition>))]
public enum RetryDisposition
{
    Safe,
    Unsafe,
    RequiresRefreshedState,
    RequiresUserAction,
    RequiresDifferentArguments,
}

/// <summary>Mirrors <c>hii_rhino_protocol::ErrorCode</c>. All 29 of them.</summary>
[JsonConverter(typeof(SnakeCaseEnumConverter<ErrorCode>))]
public enum ErrorCode
{
    // -- transport / session ------------------------------------------------
    BridgeUnavailable,
    ProtocolVersionMismatch,
    MalformedMessage,
    RhinoInstanceNotFound,
    Timeout,
    RequestOutcomeUnknown,
    Cancelled,

    // -- document / object --------------------------------------------------
    DocumentNotFound,
    DocumentChanged,
    ObjectNotFound,
    StaleReference,

    // -- request ------------------------------------------------------------
    InvalidArguments,
    OperationNotSupported,
    PermissionDenied,

    // -- native execution ---------------------------------------------------
    InvalidNativeState,
    UiDispatchFailed,
    NativeOperationFailed,
    UndoFailed,
    VerificationFailed,

    // -- grasshopper --------------------------------------------------------
    GrasshopperUnavailable,
    GrasshopperDocumentNotFound,
    ComponentNotFound,
    ComponentAmbiguous,
    ParameterNotFound,
    ParameterAmbiguous,
    ConnectionInvalid,
    SolutionFailed,

    // -- model provider -----------------------------------------------------
    ProviderUnavailable,
    ProviderToolCallInvalid,
}

public static class ErrorCodeExtensions
{
    /// <summary>
    /// Mirrors <c>ErrorCode::default_retry</c>. The bridge must not invent its
    /// own dispositions: the harness decides whether to replay a mutation from
    /// this value, and the two sides disagreeing is exactly how a box gets
    /// created twice.
    /// </summary>
    public static RetryDisposition DefaultRetry(this ErrorCode code) => code switch
    {
        ErrorCode.BridgeUnavailable
            or ErrorCode.RhinoInstanceNotFound
            or ErrorCode.GrasshopperUnavailable
            or ErrorCode.ProviderUnavailable
            or ErrorCode.PermissionDenied
            or ErrorCode.ProtocolVersionMismatch => RetryDisposition.RequiresUserAction,

        ErrorCode.DocumentNotFound
            or ErrorCode.DocumentChanged
            or ErrorCode.ObjectNotFound
            or ErrorCode.StaleReference
            or ErrorCode.InvalidNativeState
            or ErrorCode.GrasshopperDocumentNotFound => RetryDisposition.RequiresRefreshedState,

        ErrorCode.InvalidArguments
            or ErrorCode.OperationNotSupported
            or ErrorCode.ComponentNotFound
            or ErrorCode.ComponentAmbiguous
            or ErrorCode.ParameterNotFound
            or ErrorCode.ParameterAmbiguous
            or ErrorCode.ConnectionInvalid
            or ErrorCode.ProviderToolCallInvalid => RetryDisposition.RequiresDifferentArguments,

        ErrorCode.Timeout
            or ErrorCode.Cancelled
            or ErrorCode.UiDispatchFailed => RetryDisposition.Safe,

        _ => RetryDisposition.Unsafe,
    };
}

/// <summary>Mirrors <c>hii_rhino_protocol::ResponseStatus</c>.</summary>
[JsonConverter(typeof(SnakeCaseEnumConverter<ResponseStatus>))]
public enum ResponseStatus
{
    Ok,
    Partial,
}

/// <summary>Mirrors <c>hii_rhino_protocol::EventKind</c>.</summary>
[JsonConverter(typeof(SnakeCaseEnumConverter<EventKind>))]
public enum EventKind
{
    DocumentOpened,
    DocumentClosed,
    ActiveDocumentChanged,
    ObjectAdded,
    ObjectDeleted,
    ObjectReplaced,
    ObjectAttributesChanged,
    SelectionChanged,
    GrasshopperSolutionStart,
    GrasshopperSolutionEnd,
}
