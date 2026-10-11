from types import SimpleNamespace

from server.agent import normalize, run_agent
from server.plans import DEMO_PLANS


def test_normalize():
    assert normalize("  Top 3, most DANGEROUS moments?! ") == "top 3 most dangerous moments"


class ScriptedClient:
    """Stands in for anthropic.Anthropic: replays tool calls and records the tool results it is sent."""

    def __init__(self, turns):
        self.turns = iter(turns)
        self.sent = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))

    def create(self, **kwargs):
        self.sent.append(kwargs["messages"][-1])
        calls = enumerate(next(self.turns))
        blocks = [SimpleNamespace(type="tool_use", id=f"t{i}", name=n, input=a) for i, (n, a) in calls]
        return SimpleNamespace(stop_reason="tool_use", content=blocks)


def test_agent_loop_threads_result_ids_and_matches_the_plan(ds):
    client = ScriptedClient([
        [("filter_tracks", {"cls": "person"})],
        [("in_zone", {"zone_id": "crosswalk", "result_id": "r1"})],
        [("count", {"result_id": "r2", "group_by": "minute"})],
        [("highlight", {"result_ids": ["r3"], "caption": "People crossing per minute", "summary": "s"})],
    ])
    out = run_agent(ds, "how many people crossed per minute", client)
    plan = DEMO_PLANS["how many people crossed per minute"](ds)
    assert out["highlight"]["list"] == plan["highlight"]["list"]
    assert out["highlight"]["segments"] == plan["highlight"]["segments"]


def test_highlight_track_ids_keep_only_rows_about_those_tracks(ds):
    client = ScriptedClient([
        [("rank_near_misses", {"top_k": 3})],
        [("highlight", {"result_ids": ["r1"], "caption": "c", "summary": "s", "track_ids": [13]})],
    ])
    out = run_agent(ds, "q", client)
    assert [row["label"] for row in out["highlight"]["list"]] == ["person 13 and car 14, 8 px at 420 px/s"]
    assert {s["track_id"] for s in out["highlight"]["segments"]} == {13, 14}


def test_agent_reports_tool_errors_back_to_the_model(ds):
    client = ScriptedClient([
        [("stopped", {"zone_id": "no such zone"})],
        [("rank_near_misses", {"top_k": 1})],
        [("highlight", {"result_ids": ["r1"], "caption": "c", "summary": "s"})],
    ])
    out = run_agent(ds, "q", client)
    err = client.sent[1]["content"][0]
    assert err["is_error"] is True and "No zone named" in err["content"]
    assert len(out["highlight"]["list"]) == 1


def test_agent_without_highlight_is_an_error(ds):
    client = ScriptedClient([[]])
    assert set(run_agent(ds, "q", client)) == {"error"}


def test_real_sdk_request_shape_and_loop(ds):
    """Drive run_agent through the real anthropic client over a mock transport: checks the wire request
    and that real SDK response objects (not stand-ins) flow through the loop."""
    import json

    import anthropic
    import httpx2 as httpx

    sent = []
    turns = iter([
        [{"type": "tool_use", "id": "toolu_1", "name": "rank_near_misses", "input": {"top_k": 3}}],
        [{"type": "tool_use", "id": "toolu_2", "name": "highlight",
          "input": {"result_ids": ["r1"], "caption": "Top 3", "summary": "Three close calls."}}],
    ])

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append((request.headers, json.loads(request.content)))
        return httpx.Response(200, json={
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5",
            "content": next(turns), "stop_reason": "tool_use", "stop_sequence": None,
            "usage": {"input_tokens": 1, "output_tokens": 1}})

    client = anthropic.Anthropic(api_key="test", http_client=httpx.Client(transport=httpx.MockTransport(handler)))
    out = run_agent(ds, "Top 3 most dangerous moments", client)

    headers, body = sent[0]
    assert body["model"] == "claude-sonnet-5-5" and body["fallbacks"] == "default"
    assert "server-side-fallback-2026-07-01" in headers["anthropic-beta"]
    assert {t["name"] for t in body["tools"]} == {"filter_tracks", "near", "in_zone", "stopped",
                                                  "rank_near_misses", "count", "highlight"}
    tool_result = sent[1][1]["messages"][-1]["content"][0]
    assert tool_result["tool_use_id"] == "toolu_1" and json.loads(tool_result["content"])["count"] == 3
    assert out["summary"] == "Three close calls." and len(out["highlight"]["list"]) == 3
