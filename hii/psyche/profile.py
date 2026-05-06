"""
Psyche Profile — Persistent model of a human's mind.

This is the heart of HII. It extracts and stores:
- Identity (who you are)
- Cognitive patterns (how you think)
- Decision heuristics (how you choose)
- Knowledge topology (what you know and how it connects)
- Values & goals (what drives you)
- Interaction history (compressed observations over time)

The profile is append-only with periodic compaction.
It exports itself as a system prompt that can drive agents
to act on the user's behalf.
"""

import json
from pathlib import Path
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Optional

HII_DIR = Path.home() / ".hii"
PSYCHE_FILE = HII_DIR / "psyche.json"


@dataclass
class CognitivePattern:
    trait: str          # e.g. "systems thinker", "pattern matcher"
    confidence: float   # 0.0 to 1.0
    evidence: str       # observation that led to this
    observed_at: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class DecisionHeuristic:
    context: str        # e.g. "technology choice"
    rule: str           # e.g. "prefers unix-native, minimal deps"
    confidence: float
    examples: list[str] = field(default_factory=list)


@dataclass
class KnowledgeNode:
    domain: str
    depth: str          # surface | working | deep | expert
    connections: list[str] = field(default_factory=list)


@dataclass
class Goal:
    description: str
    priority: str       # critical | high | medium | low
    status: str = "active"  # active | done | paused
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())


@dataclass
class Observation:
    timestamp: str
    kind: str           # observation | correction | preference | decision
    content: str
    source: str         # which subsystem observed this


@dataclass
class PsycheProfile:
    # Identity
    name: str = ""
    roles: list[str] = field(default_factory=list)
    domains: list[str] = field(default_factory=list)

    # Patterns
    cognitive: list[CognitivePattern] = field(default_factory=list)
    decisions: list[DecisionHeuristic] = field(default_factory=list)

    # Knowledge graph
    knowledge: list[KnowledgeNode] = field(default_factory=list)

    # Motivation
    values: list[str] = field(default_factory=list)
    goals: list[Goal] = field(default_factory=list)

    # History (compressed)
    observations: list[Observation] = field(default_factory=list)

    last_updated: str = field(default_factory=lambda: datetime.now().isoformat())

    # ── Persistence ──

    def save(self):
        HII_DIR.mkdir(parents=True, exist_ok=True)
        self.last_updated = datetime.now().isoformat()
        PSYCHE_FILE.write_text(json.dumps(asdict(self), indent=2))

    @classmethod
    def load(cls) -> "PsycheProfile":
        try:
            raw = json.loads(PSYCHE_FILE.read_text())
            p = cls()
            p.name = raw.get("name", "")
            p.roles = raw.get("roles", [])
            p.domains = raw.get("domains", [])
            p.values = raw.get("values", [])
            p.last_updated = raw.get("last_updated", "")
            p.cognitive = [CognitivePattern(**c) for c in raw.get("cognitive", [])]
            p.decisions = [DecisionHeuristic(**d) for d in raw.get("decisions", [])]
            p.knowledge = [KnowledgeNode(**k) for k in raw.get("knowledge", [])]
            p.goals = [Goal(**g) for g in raw.get("goals", [])]
            p.observations = [Observation(**o) for o in raw.get("observations", [])]
            return p
        except (FileNotFoundError, json.JSONDecodeError):
            return cls()

    # ── Mutations ──

    def observe(self, kind: str, content: str, source: str = "hii"):
        self.observations.append(Observation(
            timestamp=datetime.now().isoformat(),
            kind=kind,
            content=content,
            source=source,
        ))
        # Keep last 1000
        if len(self.observations) > 1000:
            self.observations = self.observations[-1000:]
        self.save()

    def add_cognitive(self, trait: str, confidence: float, evidence: str):
        existing = next((c for c in self.cognitive if c.trait == trait), None)
        if existing:
            existing.confidence = min(1.0, (existing.confidence + confidence) / 2)
            existing.evidence = evidence
        else:
            self.cognitive.append(CognitivePattern(trait, confidence, evidence))
        self.save()

    def add_decision(self, context: str, rule: str, confidence: float, example: Optional[str] = None):
        existing = next((d for d in self.decisions if d.context == context), None)
        if existing:
            existing.rule = rule
            existing.confidence = min(1.0, (existing.confidence + confidence) / 2)
            if example:
                existing.examples.append(example)
                existing.examples = existing.examples[-5:]
        else:
            self.decisions.append(DecisionHeuristic(context, rule, confidence, [example] if example else []))
        self.save()

    def add_knowledge(self, domain: str, depth: str, connections: Optional[list[str]] = None):
        existing = next((k for k in self.knowledge if k.domain == domain), None)
        if existing:
            existing.depth = depth
            if connections:
                existing.connections = list(set(existing.connections + connections))
        else:
            self.knowledge.append(KnowledgeNode(domain, depth, connections or []))
        self.save()

    def add_goal(self, description: str, priority: str = "high"):
        self.goals.append(Goal(description, priority))
        self.save()

    # ── Export ──

    def to_system_prompt(self) -> str:
        """Export as a system prompt fragment for agent injection."""
        if not self.name:
            return ""

        lines = [f"You are acting on behalf of {self.name}."]
        if self.roles:
            lines.append(f"Roles: {', '.join(self.roles)}")
        if self.domains:
            lines.append(f"Domains: {', '.join(self.domains)}")
        if self.values:
            lines.append(f"Values: {', '.join(self.values)}")

        high_conf_cog = [c for c in self.cognitive if c.confidence > 0.5]
        if high_conf_cog:
            lines.append("Thinking style:")
            for c in high_conf_cog:
                lines.append(f"  - {c.trait}")

        high_conf_dec = [d for d in self.decisions if d.confidence > 0.5]
        if high_conf_dec:
            lines.append("Decision patterns:")
            for d in high_conf_dec:
                lines.append(f"  - {d.context}: {d.rule}")

        active = [g for g in self.goals if g.status == "active"]
        if active:
            lines.append("Active goals:")
            for g in active:
                lines.append(f"  - [{g.priority}] {g.description}")

        return "\n".join(lines)

    def summary(self) -> dict:
        """Token-efficient summary for quick context."""
        return {
            "name": self.name,
            "roles": self.roles,
            "values": self.values[:5],
            "active_goals": [g.description for g in self.goals if g.status == "active"][:3],
            "total_observations": len(self.observations),
        }
