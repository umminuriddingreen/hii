# Channing Court Eichler Retrofit Concept

Concept package for an actual Bay Area site:

- Site: 1601 Channing Ave, Palo Alto, CA 94303
- Working premise: preservation-first renovation of a 1951 single-story modern / Eichler-era home
- Public listing snapshot, August 11, 2026: 5 beds, 3 baths, 2,134 sf, 7,125 sf lot, R1 zoning, listed at $3,798,000
- Output status: feasibility concept only; not a permit set, survey, appraisal, or legal zoning opinion

## Package Contents

- `README.md`: source-backed concept brief.
- `site-plan.svg`: readable diagrammatic site plan.
- `massing.step.py`: local CAD generator script.
- `massing.step`: generated STEP massing model.
- `concept-slides.md`: eight-slide concept narrative.
- `concept-board.html`: presentation board for visual review.
- `visual-precedent-mining-skill.md`: HII skill draft for Pinterest/Cosmos/API/browser precedent mining.

## HII Intent

Use the property as a prototype for HII's community-funding/vitality layer:

1. Preserve the Eichler public identity.
2. Add useful housing and work capacity without breaking the single-story neighborhood character.
3. Convert design intent into a visible project object: QR concept sign, budget ranges, pre-lease/pre-booking signals, neighbor feedback, investor interest, and contractor scope.
4. Keep evidence attached: listing facts, city guidelines, code constraints, concept drawings, cost buckets, and feedback receipts.

## Site Facts

Publicly sourced facts:

- Palo Alto has a large Eichler stock; local Eichler sources describe 2,700+ Palo Alto Eichlers built from 1951-1974 across tracts including Channing Park, Greenmeadow, Fairmeadow, Green Gables, and others.
- The current listing source reports one Palo Alto Eichler listing on August 11, 2026 and identifies 1601 Channing Ave as pending at $3,798,000 with 5 beds, 3 baths, and 2,134 sf.
- Other listing sources report 7,125 sf lot, parcel `00329012`, zoning `R1`, one story, slab foundation, foam roof, public utilities, and 1951 year built.
- Palo Alto's Single Story Overlay combining district, where applicable, limits sites to one habitable floor and 17 ft maximum height to the roof peak, with a flood-zone adjustment path up to 20 ft.
- Palo Alto's protected tree guidance says protected public/private/designated trees may require permits for pruning, removal, or activities that affect them.

## Core Concept

**Project name:** Channing Court

**Thesis:** Keep the house low, luminous, and neighbor-compatible, then transform the underused rear-yard and carport edges into a flexible three-part living system:

- **The preserved house:** original street rhythm, low roofline, entry sequence, exposed-post logic, and indoor/outdoor transparency.
- **The service spine:** upgraded all-electric mechanical, laundry, storage, pantry, and maker/work wall along the least public side of the plan.
- **The garden room / ADU option:** a rear single-story studio volume that can start as office + guest suite, then become a permitted ADU if the owner/community/investor budget supports it.

The renovation is not "make it bigger at all costs." It is "make the lot work harder while the neighborhood still feels like itself."

## Spatial Strategy

Assumptions for concept drawing only:

- Approximate lot area: 7,125 sf.
- Diagram lot: 75 ft by 95 ft rectangle.
- Street/front assumed on the south edge.
- Existing home mass assumed toward the front/middle with rear garden available.
- Exact setbacks, easements, trees, utilities, and finished floor elevations require survey and city parcel report.

Program:

- Existing main house: retain as 4-5 bedroom family / co-living capable plan.
- Atrium reset: restore the central outdoor room as the emotional center and natural ventilation engine.
- Work-share suite: one bedroom near entry becomes consult room, creator studio, or community design office.
- Rear garden room: 420-650 sf single-story flexible volume; design as office/guest first, ADU-ready if permitted.
- Covered exterior commons: light trellis and permeable patio connecting main house, garden room, and outdoor kitchen.
- QR project node: small front-yard sign overlaying the real estate/permit-sign ecosystem, pointing to a HII project page with scopes, alternates, budget movement, neighborhood feedback, and pre-booking/investor interest.

## Community-Funding Layer

The QR code is not decoration. It is the project interface.

Visitor flow:

1. Scan from sign, flyer, permit notice, listing, or neighborhood walk.
2. See the site concept, constraints, massing, and alternates.
3. Vote/comment on neighbor-facing tradeoffs: rear studio, no second story, tree preservation, parking, noise, street character.
4. Pre-commit interest: lease the ADU, book the work studio, invest in the retrofit, sponsor solar/battery, or bid as a contractor.
5. HII records each signal as a receipt attached to the project object.

Sellable concepts:

- Owner renovation package.
- Lease-backed ADU package.
- Community design office / showroom package.
- Investor-funded electrification and resilience package.
- Contractor bid package with public design alternatives.

## Design Rules

- Single-story only unless confirmed outside overlay constraints and neighborhood acceptance is explicit.
- Keep the street elevation low, horizontal, and quiet.
- Use flat or very low-slope roof forms, deep fascia, warm wood, simple masonry/concrete, and large shaded glazing.
- Avoid faux-historic materials and bulky second-floor massing.
- Make new work legible but deferential: a thinner rear pavilion instead of a front-facing mansion addition.
- Keep mature/protected trees until an arborist and city process prove otherwise.
- All-electric first: heat pump HVAC, heat pump water heater, induction, solar-ready roof, battery-ready exterior equipment zone.

## Phasing

### Phase 0: HII Public Concept Object

- Create landing page, QR code, source log, feedback form, and budget ladder.
- Capture neighbor and investor signals before design development.

### Phase 1: Low-Risk Renovation

- Restore atrium and indoor/outdoor thresholds.
- Kitchen/bath refresh without changing roofline.
- Electrical panel assessment and heat-pump readiness.
- Permeable landscape and privacy planting.

### Phase 2: Service Spine

- Rework storage, laundry, mechanical, and work wall.
- Add acoustic/thermal improvements that preserve exposed roof/deck character where possible.

### Phase 3: Garden Room / ADU-Ready Pavilion

- Build rear studio within confirmed setbacks and tree constraints.
- Keep roof below single-story character limits.
- Design utilities for future independent occupancy if allowed.

## Rough Budget Bands

Order-of-magnitude only:

- Phase 0 concept + QR + feedback system: $8k-$25k
- Phase 1 preservation renovation: $250k-$650k
- Phase 2 electrification/service spine: $150k-$400k
- Phase 3 garden room / ADU-ready pavilion: $350k-$750k
- Full design-build with contingency: $900k-$1.8M

## HII Capability Notes

- `hii discover github eichler architecture --min-stars 100 --limit 5` found no safe-star source repos.
- `hii discover web ...` surfaced Palo Alto Eichler guidelines, SSO information, ADU sources, and listing pages.
- `hii discover x ...` surfaced weak social signal; useful for market pulse, not design authority.
- Local `text-to-cad` / `cadgen` is used for a simple massing proof artifact.

## Source Links

- Palo Alto Eichler listing page: https://www.eichlerforsale.com/palo-alto-eichlers/
- 1601 Channing Ave listing detail: https://www.eichlerforsale.com/idx/1601-channing-ave-palo-alto-ca-94303/1804995322_spid/
- Zillow listing data: https://www.zillow.com/homedetails/1601-Channing-Ave-Palo-Alto-CA-94303/19468090_zpid/
- Palo Alto Eichler Neighborhood Design Guidelines PDF: https://www.cityofpaloalto.org/files/assets/public/planning-amp-development-services/eichler-neighood-design-guidelines/2018-03-14_pa-eichler-design-guidelines_final-draft_revised-for-city-council.pdf
- Palo Alto Single Story Overlay code: https://codelibrary.amlegal.com/codes/paloalto/latest/paloalto_ca/0-0-0-77330
- Palo Alto protected trees: https://www.paloalto.gov/Departments/Public-Works/Public-Services/Palo-Altos-Urban-Forest/Development-Process/Protected-Trees
- Palo Alto ADU code: https://codelibrary.amlegal.com/codes/paloalto/latest/paloalto_ca/0-0-0-76738
