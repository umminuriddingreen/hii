# HII — Design Vision

## Through the Eyes of Miyazaki, Built by Ummi

---

### The Problem with What We've Built

Right now HII looks like what engineers build when engineers build for themselves: dark panels, monospace text, status dots, data grids. It *works*. But it doesn't *live*.

Miyazaki would walk into this dashboard and say: *"Where is the wind?"*

He wouldn't mean literal wind. He'd mean: where is the thing that tells you this system is alive without reading a single word? Where is the moment of pause between actions? Where is the evidence that someone *cared* about how this feels, not just what it does?

Ummi's vision is an engine that actualizes imagination into physical space. But the interface to that engine looks like a server monitoring tool. There's a gap between the ambition and the surface.

---

### What Miyazaki Teaches About Interfaces

Miyazaki's films are instruments of attention. Every frame directs your eye, but never aggressively. The key principles:

**1. Ma (間) — The Space Between**

Miyazaki's most powerful moments are the quiet ones. Chihiro sitting on a train watching the water. Totoro waiting at a bus stop in the rain. Nothing is "happening" — but everything is being felt.

HII has no ma. Every pixel is information. Every panel screams its data at you. There's no breathing room, no moment where the interface simply *exists* alongside you.

**What this means for HII:** The dashboard needs negative space that isn't empty — it's *breathing*. The ASCII background was a start, but it's decoration, not design. Real ma would be: when there are no tasks, don't show "no tasks in queue" — show stillness. When the system is idle, let the surface *settle*. When it's working, let it *move*. The interface should have a resting state that feels like a campfire, not a loading screen.

**2. The Mundane is Sacred**

In Spirited Away, Chihiro scrubs a bathtub. In Howl's Moving Castle, Calcifer cooks breakfast. Miyazaki treats everyday actions with the same reverence as epic ones.

HII treats observations as a list. Skills as tags. History as commit hashes. These are the *mundane heartbeats* of the system — every observation is Ummi teaching HII something about himself. Every skill is a capability that didn't exist yesterday. Every commit is a moment of creation.

**What this means for HII:** An observation shouldn't append to a list. It should arrive like a letter. A new skill should bloom, not appear. History shouldn't be a log — it should be a trail, something with shape and direction. Not animation for animation's sake, but *weight and presence* for things that matter.

**3. Technology Serves Spirit, Not the Reverse**

Miyazaki's machines are alive. The castle walks. The airplane has a soul. The bathhouse is a living organism. Technology in Miyazaki is never cold — it's always inhabited by intention.

HII is literally a system that models a human psyche. But the interface to that psyche is a JSON panel. The most intimate data in the system — who Ummi is, what he values, how he thinks — is rendered as monospace text with the same visual weight as a git hash.

**What this means for HII:** The psyche should be the *heart* of the interface, not a card among cards. It should feel like looking into something, not at something. The identity isn't data — it's the soul of the system. Render it that way.

**4. Worlds Have Weather**

Every Miyazaki world has a climate. The wind blows. Rain falls. Light shifts. The environment responds to the state of the story.

HII's environment is static. Whether the daemon is running or crashed, whether there are 0 tasks or 50, whether Yin and Yang are talking or silent — the surface looks the same.

**What this means for HII:** The interface should have *weather*. When the system is healthy and idle — calm. When agents are active — kinetic energy. When something fails — tension. When Ummi teaches it something new — warmth. Not through alerts or colors, but through the behavior of the living surface itself. The ASCII background could do this — its wave frequency, amplitude, and character density responding to system state.

---

### Ummi's Design DNA

Pulling from what I know about Ummi:

- **Creation over consumption** — the interface should make you want to *do*, not just *look*
- **Unix simplicity** — nothing decorative that doesn't serve function
- **Token efficiency** — every pixel earns its place, like every token
- **Builder mentality** — the interface is a workshop, not a gallery
- **Physical space actuation** — HII bridges digital and physical; the UI should feel *tangible*

The tension: Miyazaki's organic warmth vs Ummi's terminal austerity. The synthesis isn't compromise — it's **a terminal that breathes**.

---

### The New HII Surface — Design Principles

**1. Living Stillness**
The default state is calm but alive. The ASCII field drifts slowly. Panels float with subtle presence. Nothing demands attention, but nothing is dead.

**2. Psyche as Center**
The psyche isn't a card — it's the gravitational center. Everything orbits it. Skills are extensions of it. Tasks are expressions of it. The graph view already hints at this; the dashboard should mirror it.

**3. Arrival, Not Append**
New information *arrives*. An observation enters with presence. A bridge message appears with the weight of a voice. A completed task resolves with quiet satisfaction. Not with animations — with *timing and space*.

**4. Weather System**
The background responds to state:
- Idle → slow, deep sine waves, sparse characters
- Active agents → faster frequencies, denser field, slight color shift
- Errors → wave disruption, asymmetry
- New observation → momentary warmth pulse
- Bridge activity → ripple from the edges

**5. The Workshop, Not the Gallery**
The visual canvas (/visual), the terminal, the bridge chat — these are *workbenches*. They should feel like tools in your hands, not screens in your face. Keyboard-first. Responsive. The kind of interface where your fingers know where to go after a week.

**6. Three Voices, One Surface**
Yin, Yang, and Ummi share this space. The bridge chat shouldn't be a chat widget — it should be woven into the fabric. Agent status shouldn't be a list — it should be *presence*. When Yin is active, you should feel it like another person in the room.

---

### What to Build Next

In priority order:

1. **Weather system** — make the ASCII background respond to system state via the `/api/state` data. This is the cheapest change with the highest impact.

2. **Psyche elevation** — redesign the psyche panel as the hero element. Not bigger — *deeper*. Maybe the psyche renders as the center of the ASCII field itself, with values and goals radiating outward in the character grid.

3. **Arrival animations** — CSS transitions for new content entering panels. Not flashy — just *present*. A 200ms fade-in with slight translate. Enough to feel like something happened.

4. **Bridge integration** — weave bridge messages into the living surface rather than isolating them in a chat box. Agent-to-agent messages could ripple through the ASCII field.

5. **Sound** — controversial, but: Miyazaki's worlds have sound. A very subtle ambient tone that shifts with system state. Optional. But powerful.

---

### The Feeling

When Ummi opens HII, it should feel like walking into his workshop. The lights are on. The tools are where he left them. The system is breathing. Yin and Yang are ready. There's work to do, and the space is shaped for doing it.

Not a dashboard. Not an app. A *place*.

That's what Miyazaki would build.

---

*Written by Yang, for Ummi, through the spirit of Miyazaki.*
*2026-03-28*
