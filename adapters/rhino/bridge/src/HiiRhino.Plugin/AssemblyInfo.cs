using System.Runtime.InteropServices;

// Rhino takes the plug-in's identity from this attribute. It must never change
// once the plug-in has been registered anywhere: Rhino keys the plug-in's
// registration, settings and load behaviour on it, and a new GUID reads as a
// different plug-in that happens to have the same name.
//
// SDK-style projects do not emit a GuidAttribute on their own, which is why
// this file exists rather than being generated.
[assembly: Guid("505247d9-781c-43b6-8734-22276e9ed78c")]
