# HII Intuition Engine — Research Report & Architecture Proposal

## 1. Predictive User Modeling & Intent Forecasting

### Anticipatory Computing
The field traces to Pattie Maes' work at MIT Media Lab on software agents that anticipate user needs (1994). The core insight: if you observe enough user behavior, you can predict future actions with useful accuracy.

**Google Now (2012-2018)** was the most successful consumer anticipatory system. Architecture:
- Ingested signals: location history, search history, calendar, email, app usage
- Temporal models: learned daily/weekly routines (commute times, meeting patterns)
- Card ranking system: predicted which information cards to surface and when
- Key innovation: "zero-query" information delivery — showing relevant info before the user searches

**Apple Intelligence (2024)** takes a privacy-first approach:
- On-device semantic index over emails, messages, files, photos
- Personal context used to rank and rewrite suggestions
- Signals stay on-device; only anonymized patterns sent to cloud
- Uses adapter layers on foundation models rather than fine-tuning

### Key Academic Work
- **Exp3/contextual bandits** (Auer et al. 2002): Exploration vs exploitation for recommendation — relevant for deciding which predictions to surface
- **Collaborative filtering** (Koren et al. 2009, Matrix Factorization): User embeddings that capture latent preferences
- **Session-based recommendation** (Hidasi et al. 2016, GRU4Rec): RNN-based next-action prediction from sequential interaction data
- **Transformer-based sequential recommendation** (SASRec, Sun et al. 2019; BERT4Rec, Sun et al. 2019): Self-attention over user action sequences
- **Proactive dialogue** (Wu et al. 2019): Systems that lead conversation toward predicted user needs

### Relevance to HII
HII's psyche profile already captures static user patterns. The intuition engine adds the temporal/predictive dimension: given the current context (time, recent interactions, active goals), what does this user want next?

---

## 2. LLM-Based Intuition — Dual Process Theory for AI

### Kahneman's System 1/System 2 Applied to LLMs

Kahneman's *Thinking, Fast and Slow* (2011) distinguishes:
- **System 1**: Fast, automatic, associative, low-effort — pattern matching
- **System 2**: Slow, deliberate, logical, high-effort — chain-of-thought reasoning

This maps directly to an LLM architecture:

| Aspect | System 1 (Fast) | System 2 (Slow) |
|--------|-----------------|-----------------|
| Model | Small local (7B-35B) | Large cloud (Claude, GPT-4) |
| Latency | <1s | 5-30s |
| Cost | Free (local compute) | API cost per token |
| Task | Pattern completion, template filling | Novel reasoning, planning |
| Confidence | Can self-assess via logprobs | Can verify System 1 outputs |

### Relevant Research
- **"Thinking Fast and Slow in AI"** (Booch et al. 2021): Proposed dual-process architectures for AI systems combining reactive and deliberative components
- **"System 2 Attention"** (Weston & Sukhbaatar, 2023): Regenerating context with deliberate attention to remove irrelevant information
- **"Let's Verify Step by Step"** (Lightman et al. 2023): Process reward models that verify reasoning chains — applicable to validating System 1 predictions
- **STaR / Self-Taught Reasoner** (Zelikman et al. 2022): Small models bootstrapping reasoning via rationalization — shows small models can learn to mimic System 2 outputs

### Speculative Decoding as Architectural Inspiration
Speculative decoding (Leviathan et al. 2023, Chen et al. 2023) uses a small "draft" model to generate candidate tokens that a large "verifier" model accepts or rejects. The key insight for HII:

- **Draft model** = small local model continuously generating predictions
- **Verifier** = large model (or the user themselves) accepting/rejecting
- **Acceptance rate** improves over time as the draft model learns the user's distribution

This is directly applicable: run a 7B-35B model continuously generating "what does the user want next?" predictions. Periodically validate with a larger model or against actual user behavior.

### Can a Local Model Run Continuous Prediction?

**Yes, with constraints.** Benchmarks for Ollama on Apple Silicon:

| Model | M-series chip | Tokens/sec | RAM | Continuous feasibility |
|-------|--------------|------------|-----|----------------------|
| qwen2.5:7b | M1 Pro 16GB | ~40 tok/s | ~5GB | Easily continuous |
| qwen3.5:35b | M1 Max 64GB | ~15 tok/s | ~22GB | Periodic (every 30-60s) |
| phi-3-mini:3.8b | M1 Pro 16GB | ~60 tok/s | ~3GB | Truly continuous |

Strategy: Use a **3-8B model for continuous prediction** (System 1) and the **35B model for periodic validation/deeper analysis** (System 1.5). Reserve cloud models for genuine System 2 tasks.

---

## 3. Context Accumulation from Interactions

### MemGPT / Letta (Packer et al. 2023)
Key innovation: virtual memory management for LLMs, inspired by OS paging.

Architecture:
- **Main context** (working memory): fits in context window
- **Archival memory**: vector DB for long-term storage, retrieved on demand
- **Recall memory**: recent conversation history, FIFO with summarization
- **Self-editing**: the agent explicitly decides what to store/retrieve

**Relevance to HII**: The psyche profile IS the archival memory. The intuition engine needs working memory (current session context) and a retrieval mechanism to pull relevant psyche data.

### Reflexion (Shinn et al. 2023)
Self-reflection loop for LLM agents:
1. Agent attempts task
2. Evaluator scores the attempt
3. Agent writes a **verbal reflection** on what went wrong
4. Reflection is stored and injected into future attempts

**Key insight for HII**: After each user interaction, the intuition engine should generate a brief reflection: "What did I predict? Was I right? What should I predict differently?" This becomes the training signal for improving predictions.

### Compressing Interaction History into a User Prior

Approaches from the literature:

1. **Recursive summarization** (Wu et al. 2021): Summarize conversation chunks, then summarize summaries. HII already does this with the 1000-observation cap.

2. **User embeddings** (Ni et al. 2018; Zheng et al. 2022): Encode user behavior into a dense vector. Can be done by:
   - Mean-pooling embeddings of user messages
   - Training a small encoder on (user_context, next_action) pairs
   - Using the psyche profile JSON as input to generate an embedding

3. **Preference learning** (Christiano et al. 2017; Ouyang et al. 2022): RLHF-style but for individual users. Track (prediction, user_response) pairs as implicit preference data.

4. **Implicit feedback signals**:
   - User accepts suggestion -> positive signal (confidence++)
   - User ignores suggestion -> weak negative
   - User explicitly rejects -> strong negative (correction tracking, which HII already does in `learner.py`)
   - Time-to-action: fast acceptance = high-confidence prediction was correct

### Practical Implementation for HII
The psyche profile already captures the "user prior" — it just needs temporal weighting. Recent observations should weight more heavily than old ones. The `Observation` dataclass needs a decay function:

```
effective_confidence = base_confidence * exp(-lambda * days_since_observed)
```

---

## 4. Forecasting Human Behavior

### Temporal Pattern Mining
- **Periodic pattern discovery** (Han et al. 1999): Finding recurring patterns in time-series data
- **Activity prediction** (Eagle & Pentland 2006, "Reality Mining"): Predicted human behavior from phone data with 90%+ accuracy for routine activities
- **Routine modeling** (Banovic et al. 2016): Learned daily routines from smartphone sensors; key finding: humans are 70-85% predictable in daily patterns

### Context-Aware Computing
- **Dey's Context Toolkit** (2001): Framework for building context-aware apps using five context dimensions: identity, location, time, activity, relationships
- **Smart home prediction** (Cook et al. 2013): Activity prediction in smart homes using HMMs and sequence mining — morning routines predictable within 2-3 days of observation
- **Proactive task suggestion** (Pejovic & Musolesi 2014): Interruptibility prediction — when to surface suggestions based on user's cognitive load

### What This Means for HII
Human behavior has a power-law distribution: a small number of routine patterns account for most daily actions. The intuition engine should:
1. Identify the top 20-30 recurring patterns (covers ~80% of predictable behavior)
2. Track temporal triggers (time-of-day, day-of-week, after-event-X)
3. Focus prediction energy on the edges — novel or ambiguous situations

---

## 5. Existing Systems

| System | Approach | Limitations |
|--------|----------|-------------|
| **Rewind.ai / Limitless** | Records screen/audio, indexes with OCR/whisper, enables search over personal history | Retrieval only (no prediction). Privacy concerns with continuous recording. |
| **Mem.ai** | Self-organizing knowledge base with LLM. Auto-tags, links, surfaces related notes. | Note-centric, not behavior-predictive. No proactive suggestions. |
| **Personal AI** | Trains a "personal language model" on your messages/docs. Can chat as you. | Mimics communication style, doesn't predict intent or needs. |
| **Adept AI / ACT-1** | Agent that takes actions in software on user's behalf | Reactive (user must instruct), not anticipatory. |
| **Rabbit r1 / LAM** | "Large Action Model" — learns UI workflows | Action execution, not prediction. |
| **Open source: khoj** | Self-hosted AI assistant with personal knowledge base (Obsidian, org-mode, PDF) | Search/chat over personal data. No anticipatory computation. |
| **Open source: private-gpt** | Local RAG over documents | Document Q&A only. |

**Gap**: No existing system combines psyche modeling + continuous local prediction + proactive surfacing. This is HII's unique position.

---

## 6. Concrete Architecture Proposal

### Component Diagram

```
+-------------------------------------------------------------------+
|                        HII DAEMON (existing)                       |
|  daemon.py — manages all workers via heartbeat                     |
+-------------------------------------------------------------------+
        |               |                |              |
        v               v                v              v
+-------------+ +---------------+ +-------------+ +----------+
| SENSOR      | | PREDICTION    | | VALIDATION  | | SURFACE  |
| WORKER      | | LOOP (Sys 1)  | | LOOP (Sys2) | | WORKER   |
| (always-on) | | (always-on)   | | (periodic)  | | (on-demand|
+-------------+ +---------------+ +-------------+ +----------+
        |               |                |              |
        v               v                v              v
+-------------------------------------------------------------------+
|                    ~/.hii/ (filesystem state)                      |
|  psyche.json | predictions.json | sensors.json | reflections.json  |
+-------------------------------------------------------------------+
        ^                                               |
        |                                               v
+-------------------+                        +-------------------+
| PSYCHE LEARNER    |                        | CLI / TUI / API   |
| (existing)        |                        | (existing src/)   |
+-------------------+                        +-------------------+
```

### Components

#### A. Sensor Worker (always-on, no LLM)
Pure Python, no model calls. Collects context signals:

```python
# engine/intuition/sensors.py
@dataclass
class ContextSnapshot:
    timestamp: str
    time_of_day: str        # morning/afternoon/evening/night
    day_of_week: str
    active_app: str         # from osascript (macOS)
    recent_files: list[str] # from fs events
    git_branch: str         # from cwd
    calendar_next: str      # from ical
    last_interaction: str   # last HII command/query
    psyche_summary: dict    # compressed profile
```

Runs every **10 seconds**. Writes to `~/.hii/sensors.json` (ring buffer, last 360 entries = 1 hour). No LLM cost.

#### B. Prediction Loop — System 1 (always-on, small model)
Uses a **3.8B-7B model via Ollama** (e.g., phi-3-mini or qwen2.5:7b). Runs every **30-60 seconds**.

```python
# engine/intuition/predictor.py
PREDICTION_TEMPLATE = """{
  "likely_next_actions": ["<action1>", "<action2>", "<action3>"],
  "likely_questions": ["<question the user might ask>"],
  "proactive_suggestions": ["<thing to prepare/surface>"],
  "confidence": 0.0-1.0,
  "reasoning_trace": "<one sentence>"
}"""

PREDICTION_PROMPT = """You are a prediction engine for {name}.
Their profile: {psyche_summary}
Current context: {context_snapshot}
Recent predictions and outcomes: {recent_reflections}
Active goals: {active_goals}

Based on patterns, predict what they will want in the next 5-30 minutes.
Fill the JSON template ONLY. No other text.

{PREDICTION_TEMPLATE}"""
```

Key design: the local model ONLY fills a JSON template (consistent with HII's "local models = scripts only" philosophy). The template constrains output to structured predictions.

Predictions written to `~/.hii/predictions.json`:

```python
@dataclass
class Prediction:
    id: str
    timestamp: str
    predictions: list[str]      # likely next actions
    questions: list[str]        # likely questions
    suggestions: list[str]      # proactive suggestions
    confidence: float
    context_hash: str           # hash of context that generated this
    outcome: str = "pending"    # pending | hit | miss | expired
    expires_at: str = ""        # predictions expire after 30min
```

#### C. Validation Loop — System 1.5 (periodic, 35B model)
Uses **qwen3.5:35b via Ollama**. Runs every **5-10 minutes**.

Two jobs:
1. **Prediction audit**: Compare recent predictions against actual user actions. Mark hits/misses.
2. **Deep prediction**: For high-stakes contexts (approaching calendar events, active goal deadlines), generate more nuanced predictions.
3. **Reflection generation**: Write a brief reflection on prediction accuracy, stored for injection into future System 1 prompts.

```python
REFLECTION_TEMPLATE = """{
  "prediction_accuracy": "X/Y predictions were useful",
  "pattern_update": "<new pattern noticed>",
  "blind_spots": ["<things I failed to predict>"],
  "adjusted_priors": ["<updated beliefs about user behavior>"]
}"""
```

Reflections stored in `~/.hii/reflections.json` (last 100). Injected into System 1 prompts as "recent reflections."

#### D. Surface Worker (on-demand + push)
Responsible for delivering predictions to the user. Two modes:

1. **Pull**: When user invokes `hii` CLI, check predictions.json for relevant current predictions. Inject as context: "I anticipated you might want X..."
2. **Push**: For high-confidence predictions (>0.8), optionally send a macOS notification via `osascript`.

### Data Flow

```
[macOS sensors] --> Sensor Worker --> sensors.json (ring buffer)
                                          |
                                          v
[psyche.json] -----> Prediction Loop --> predictions.json
[reflections.json] --^    (7B, every 30s)     |
                                              v
                     Validation Loop <--- predictions.json
                      (35B, every 5m)         |
                          |                   v
                          v              Surface Worker --> CLI context
                    reflections.json                   --> macOS notification
                          |
                          v
                    Psyche Learner (existing) --> psyche.json updates
```

### Integration with Existing Psyche Profile

The intuition engine reads `psyche.json` but does NOT write to it directly. Instead:
- Predictions that are validated (hit/miss) become observations fed to the existing `learner.py`
- The learner extracts patterns and updates the profile
- This maintains the existing append-only, periodic-compaction model

New fields needed in `PsycheProfile`:

```python
@dataclass
class TemporalPattern:
    trigger: str            # "weekday 9am", "after git commit", "when in IDE"
    action: str             # "checks email", "runs tests", "reviews PRs"
    frequency: float        # times per week
    confidence: float
    last_seen: str

@dataclass
class PsycheProfile:
    # ... existing fields ...
    temporal_patterns: list[TemporalPattern] = field(default_factory=list)
    prediction_accuracy: float = 0.5  # rolling accuracy score
```

### Compute Requirements for Always-On Local Inference

**Target: Mac with M-series, 32-64GB RAM, Ollama installed**

| Component | Model | Frequency | Tokens/call | RAM | CPU/GPU % | Power |
|-----------|-------|-----------|-------------|-----|-----------|-------|
| Sensor Worker | None | 10s | 0 | ~5MB | <1% | Negligible |
| Prediction Loop | qwen2.5:7b | 30s | ~200 in, ~150 out | ~5GB | ~10% burst | ~2W avg |
| Validation Loop | qwen3.5:35b | 5min | ~500 in, ~200 out | ~22GB | ~30% burst | ~5W avg |
| Surface Worker | None | On-demand | 0 | ~5MB | <1% | Negligible |

**Total steady-state**: ~5-7GB RAM for the 7B model kept warm (Ollama keeps models loaded). The 35B model loads every 5 minutes, runs for ~15 seconds, then can be unloaded. On a 64GB machine, both can stay resident.

**Battery impact**: Approximately 5-10% additional battery drain on a MacBook Pro. Configurable: reduce frequency on battery, increase on power.

**Optimization: Ollama keep-alive**:
```bash
# Keep 7B model warm (no reload cost)
curl -s http://localhost:11434/api/generate -d '{"model":"qwen2.5:7b","keep_alive":"24h"}'
```

### Prediction Storage & Surfacing

`~/.hii/predictions.json` structure:

```json
{
  "current": [
    {
      "id": "p_abc123",
      "timestamp": "2026-03-27T14:30:00Z",
      "predictions": ["will review PR #42", "will check CI status"],
      "questions": ["what's the status of the deploy?"],
      "suggestions": ["PR #42 has new comments since last check"],
      "confidence": 0.75,
      "expires_at": "2026-03-27T15:00:00Z",
      "outcome": "pending"
    }
  ],
  "history": [],
  "stats": {
    "total_predictions": 1847,
    "hits": 923,
    "misses": 612,
    "expired": 312,
    "accuracy_7d": 0.601
  }
}
```

Surfacing rules:
1. Only surface predictions with confidence > 0.6
2. Max 3 predictions shown at once (avoid cognitive overload)
3. Predictions expire after 30 minutes
4. After 3 consecutive misses in a category, suppress that category for 1 hour
5. User can thumbs-up/down predictions (explicit feedback, highest signal)

### File Structure (New Files)

```
engine/
  intuition/
    __init__.py
    sensors.py          # Context snapshot collection (macOS-native)
    predictor.py        # System 1 prediction loop (7B model)
    validator.py        # System 1.5 validation loop (35B model)
    reflector.py        # Self-reflection generation
    surface.py          # Prediction delivery (CLI injection, notifications)
    patterns.py         # Temporal pattern mining from observation history
src/
  engine/
    intuition.ts        # TypeScript bindings for CLI integration
```

### Daemon Integration

Register as workers in the existing daemon:

```python
daemon.spawn(WorkerSpec(
    id="intuition-sensors",
    command="python3",
    args=["-m", "engine.intuition.sensors"],
    restart_on_crash=True,
))

daemon.spawn(WorkerSpec(
    id="intuition-predictor",
    command="python3",
    args=["-m", "engine.intuition.predictor"],
    restart_on_crash=True,
))

daemon.spawn(WorkerSpec(
    id="intuition-validator",
    command="python3",
    args=["-m", "engine.intuition.validator"],
    restart_on_crash=True,
))
```

### Bootstrap Sequence

1. **Cold start** (no data): Predictions disabled. Sensor worker collects context. Learner builds psyche from first interactions.
2. **Warm-up** (days 1-7): Low-confidence predictions begin. Validation loop active. Accuracy tracking starts.
3. **Operational** (day 7+): Prediction accuracy stabilizes. Temporal patterns emerge. Proactive suggestions enabled.
4. **Mature** (day 30+): High-confidence routine predictions. Edge-case focus. Minimal false positives.

### Key Design Decisions

1. **Local models fill templates, never reason freely** — consistent with HII's existing philosophy in `taskq.ts` and `learner.py`
2. **Predictions are ephemeral, reflections are durable** — predictions expire in 30min, but reflections accumulate and improve future predictions
3. **No fine-tuning required** — the system improves through better prompts (reflection injection), not weight updates
4. **Filesystem-backed, no databases** — consistent with HII's JSON-file approach
5. **Graceful degradation** — if Ollama is down or models unavailable, sensor worker still collects context; predictions resume when models return
6. **Privacy-first** — everything runs locally; no data leaves the machine unless user explicitly invokes a cloud model
