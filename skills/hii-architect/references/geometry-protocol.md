# Neutral Architectural Geometry Protocol

## Object Envelope

Represent every object with stable identity, semantic type, frame, units, geometry, properties, relations, provenance, and version. Keep semantics separate from geometry. A wall can have a parametric centerline, a B-Rep reference, a mesh representation, and drawing projections without becoming four unrelated objects.

## Semantic Types

Use `site`, `parcel`, `level`, `space`, `zone`, `wall`, `curtain_wall`, `opening`, `door`, `window`, `slab`, `roof`, `column`, `beam`, `stair`, `ramp`, `core`, `shaft`, `equipment`, `fixture`, `furniture`, `circulation_path`, `structural_grid`, `service_zone`, `envelope`, `landscape`, `analysis_surface`, and `annotation`.

Extend only when the new type has distinct behavior, checks, or downstream meaning.

## Relations

Prefer explicit typed edges: `contains`, `bounded_by`, `hosted_by`, `opens_to`, `adjacent_to`, `connected_to`, `served_by`, `supported_by`, `above`, `below`, `aligned_with`, `derived_from`, `conflicts_with`, and `supersedes`.

Every relation endpoint must resolve to an object ID. Record direction deliberately.

## Representations

- Exact intent: dimensions, constraints, profiles, axes, levels, parametric objects.
- Analytic geometry: points, vectors, planes, polylines, polygons, curves, surfaces, solids, CSG trees.
- Exchange references: STEP, IFC, GLB, OBJ/STL, GeoJSON, DXF/DWG, RVT, 3DM.
- Presentation: drawing paths, raster images, materials, cameras, diagrams.

Do not use STL as a canonical editable model. Use GLB for browser inspection, STEP or an exact-kernel format for solids, IFC for openBIM exchange, and explicit state JSON for HII's durable semantics.

## Command Envelope

Record a stable command ID, operation, input IDs, parameters with units, tolerance, expected semantic result, executor ID/version, result IDs, and status. Record failed commands too. Never infer success from an output file merely existing.

## Capability Negotiation

Before complex execution, request the required operations, representations, precision, and units. The executor response must state supported operations, version, tolerance model, supported formats, size limits, and known failure modes. If no executor satisfies the need, downgrade the claim and produce a bounded diagram or unresolved issue.

## Validation

Check finite coordinates, units, closedness, winding, self-intersection, degeneracy, manifoldness where relevant, minimum clearance, solid volume, wall joins, opening containment, duplicates, level consistency, stable IDs, lineage, and export parity against canonical state.
