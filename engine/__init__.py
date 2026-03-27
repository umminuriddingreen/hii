"""
HII Engine — Self-Healing Persistence Engine

The engine that writes minds onto machines.

Components:
- core/daemon.py    : Unix daemon with self-healing worker management
- psyche/profile.py : Persistent user mind model
- psyche/learner.py : Extracts patterns from interactions
- tasks/queue.py    : Persistent task queue (local vs architect routing)
- agents/delegator.py : Managed subprocess agents

Usage:
    python -m engine.core.daemon start    # start the daemon
    python -m engine.cli psyche show      # view psyche profile
    python -m engine.cli task add ...     # queue a task
"""
