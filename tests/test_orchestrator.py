"""Orchestrator tests."""

from hii.orchestrator import classify_intent
from hii.config import Config


def test_classify_refuse():
    cfg = Config()
    assert classify_intent("hack the mainframe", cfg) == "refuse"
    assert classify_intent("steal credentials", cfg) == "refuse"


def test_classify_clarify_short():
    cfg = Config()
    assert classify_intent("hi", cfg) == "clarify"
    assert classify_intent("", cfg) == "clarify"


def test_classify_execute():
    cfg = Config()
    assert classify_intent("show me the files in the project", cfg) == "execute"


def test_classify_ground():
    cfg = Config(allow_search=True, offline=False)
    assert classify_intent("what is the latest python version", cfg) == "ground"


def test_classify_no_ground_when_offline():
    cfg = Config(allow_search=True, offline=True)
    assert classify_intent("what is the latest python version", cfg) != "ground"
