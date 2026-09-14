# Architecture site analysis: market and first user job

Updated 2026-09-14. This is a qualitative scan of public product documentation and a small sample of student/practitioner discussions, not a quantified survey.

The first job for HII is **find a site, confirm what mapped data exists, keep its coordinate origin, and take aligned layers into a drawing**. Solar and energy analysis matter, but they are downstream of a trustworthy base. In the sampled discussions, the recurring friction is assembling maps from QGIS/CAD, coverage gaps, outdated terrain, and layers that do not align across tools.

| Product | What it already does | Implication for HII |
| --- | --- | --- |
| [CADMapper](https://cadmapper.com/) | Turns a selected area into layered CAD exports from public map/elevation sources. | CAD export alone is a weak differentiator. Show coverage, source, date, and coordinate origin before export. |
| [Autodesk Forma](https://blogs.autodesk.com/forma/2026/08/20/what-is-forma-site-design/) | Early site planning and environmental analysis including sun, wind, noise, and carbon. | A numeric sun angle is useful but not a competitive energy workflow. Keep simulation claims tied to real inputs and a runner. |
| [SketchUp Add Location](https://help.sketchup.com/en/site-context-add-location) | Imports imagery, terrain mesh, and some 3D buildings into a geolocated model. Its imagery providers include Bing and DigitalGlobe. | Architects value context placed in their model, not just a map preview. |
| [TestFit](https://support.testfit.io/knowledge/getting-started/site-creation) | Site creation from address, parcel, drawing, and KML inputs. | Boundary selection and parcel-level specificity are expected. |

User reports: [hours of QGIS/AutoCAD setup and OSM gaps](https://www.reddit.com/r/architecturestudent/comments/1pgo5vt/i_built_a_free_tool_that_generates_site_analysis/), [map-to-Illustrator handoff](https://www.reddit.com/r/architecture/comments/1vh6g0v/how_do_i_go_about_creating_this_type_of_site/), [CADMapper cost and scale confusion](https://www.reddit.com/r/architecturestudent/comments/1fsx6h3/site_plans/), [missing/outdated topography](https://www.reddit.com/r/architecture/comments/1770gp1/what_is_the_best_software_or_method_to_model_the/), and [Rhino/GIS coordinate mismatch](https://discourse.mcneel.com/t/import-geolation-data-coordinate-system/183174). These are directional signals, not population estimates.

The HII product sequence is: locate and draw the study area; inspect source coverage and freshness; export correctly scaled and georeferenced CAD/GIS layers; attach surveys and proposed geometry; then run history, demographics, solar, and energy analyses with provenance. The current workspace implements the first map interaction and OSM exports, with source pointers for terrain, history, and demographics. It does not yet deliver terrain mesh export, geolocated model overlay in the open view, or an energy simulation result.

Google Earth for Web is linked for visual inspection. An embedded photorealistic scene uses the [Google 3D Maps JavaScript API](https://developers.google.com/maps/documentation/javascript/3d/get-started), which requires a browser key and billing. It is a separate, optional provider so the open-source site workflow remains available. Google’s API can place [geolocated glTF models](https://developers.google.com/maps/documentation/javascript/3d/models), subject to scale and altitude verification.
