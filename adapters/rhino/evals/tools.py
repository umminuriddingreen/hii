"""The tool catalogue exactly as the bridge implements it.

Hand-written from the operation classes rather than generated, because the
generator does not exist yet. Every schema here corresponds to an operation
that is implemented and reachable; nothing is advertised that the bridge
would refuse, which is the catalogue invariant the plan requires (§14).
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "rhino_object_create",
            "description": (
                "Create one geometric primitive in the active Rhino document. "
                "Sizes are always given in millimetres and are converted to the "
                "document's own units automatically."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["box"],
                        "description": "The primitive to create. Only 'box' is supported.",
                    },
                    "size_mm": {
                        "description": (
                            "Either one number for a cube, or three numbers "
                            "[width, depth, height] in millimetres."
                        ),
                        "oneOf": [
                            {"type": "number"},
                            {"type": "array", "items": {"type": "number"},
                             "minItems": 3, "maxItems": 3},
                        ],
                    },
                    "origin": {
                        "type": "array",
                        "items": {"type": "number"},
                        "minItems": 3,
                        "maxItems": 3,
                        "description": "[x, y, z] in document units. Defaults to [0, 0, 0].",
                    },
                    "anchor": {
                        "type": "string",
                        "enum": ["corner", "centre"],
                        "description": (
                            "Whether 'origin' is the box's near corner or its centre. "
                            "Defaults to 'corner'."
                        ),
                    },
                },
                "required": ["kind", "size_mm"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_object_delete",
            "description": "Delete one object from the active document by its id.",
            "parameters": {
                "type": "object",
                "properties": {
                    "object_id": {
                        "type": "string",
                        "description": "The object's GUID, as returned by a create or a listing.",
                    }
                },
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_undo",
            "description": (
                "Undo the most recent change to the document using Rhino's own undo. "
                "Reverses whatever is on top of the stack."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_document_describe",
            "description": (
                "Describe the active document: its unit system, object count and "
                "runtime identity. Use this to find out what units a document is in."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_document_objects",
            "description": "List the objects currently in the active document.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_object_get",
            "description": "Look up one object by id and report its type and attributes.",
            "parameters": {
                "type": "object",
                "properties": {"object_id": {"type": "string"}},
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_geometry_bounding_box",
            "description": (
                "Measure one object's world-axis bounding box, in millimetres. "
                "Use this to find out how big something is."
            ),
            "parameters": {
                "type": "object",
                "properties": {"object_id": {"type": "string"}},
                "required": ["object_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "rhino_session_describe",
            "description": "Identify which Rhino process and session this connection is talking to.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

SYSTEM = (
    "You control Rhino 8 through the tools listed. Use a tool whenever the user "
    "asks you to inspect or change the model. Sizes are given to the tools in "
    "millimetres. If a request is missing information you need, or asks for "
    "something no tool supports, say so instead of guessing."
)
