"""The shared conformance vectors through this binding: every section of
``conformance/vectors.json`` recomputed by ``zero_conformance_case`` and compared with
the file as JSON values, and the ``http1Parser`` requests sent end to end to a server a
Python thread serves, each answered as its vector states."""

import json
import math

import pytest

import cabi
from cabi import Status

#: The vectors every binding is held to.
VECTORS = json.loads((cabi.ROOT / "conformance" / "vectors.json").read_text(encoding="utf-8"))

#: The sections this runner runs. A section the file holds and this list lacks fails the
#: run, so no section passes unread.
SECTIONS = ("http1Parser", "responseSplitting", "router", "ws", "sse", "qpack", "h3Frames")

#: The members of the file that are not sections.
DOCUMENT = ("note", "tolerance")

HTTP1 = VECTORS["http1Parser"]["cases"]


def difference(actual, expected, tolerance: float, path: str = "$") -> str | None:
    """The first place two JSON values differ, comparing floating point numbers within
    ``tolerance``; ``None`` when they are the same value."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        return None if actual is expected else f"{path}: {actual!r} is not {expected!r}"
    if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
        if isinstance(expected, int) and isinstance(actual, int):
            return None if actual == expected else f"{path}: {actual} is not {expected}"
        close = math.isclose(actual, expected, rel_tol=0.0, abs_tol=tolerance)
        return None if close else f"{path}: {actual} is not {expected} within {tolerance}"
    if isinstance(expected, dict) and isinstance(actual, dict):
        if set(actual) != set(expected):
            return f"{path}: members {sorted(actual)} are not {sorted(expected)}"
        for key in expected:
            found = difference(actual[key], expected[key], tolerance, f"{path}.{key}")
            if found:
                return found
        return None
    if isinstance(expected, list) and isinstance(actual, list):
        if len(actual) != len(expected):
            return f"{path}: {len(actual)} items are not {len(expected)}"
        for index, (left, right) in enumerate(zip(actual, expected)):
            found = difference(left, right, tolerance, f"{path}[{index}]")
            if found:
                return found
        return None
    return None if actual == expected else f"{path}: {actual!r} is not {expected!r}"


def test_every_member_of_the_vectors_file_is_a_section_this_runner_runs():
    assert sorted(set(VECTORS) - set(DOCUMENT)) == sorted(SECTIONS)


@pytest.mark.parametrize("section", SECTIONS)
def test_the_conformance_entry_recomputes_every_outcome_of_the_section(lib, section):
    document = json.dumps(VECTORS[section]).encode("utf-8")
    status, result = cabi.conformance_case(lib, section, document)
    assert status == Status.OK, cabi.last_error(lib)
    found = difference(json.loads(result), VECTORS[section], VECTORS["tolerance"])
    assert found is None, found


def test_a_case_given_a_wrong_outcome_comes_back_with_the_outcome_computed_again(lib):
    case = dict(VECTORS["responseSplitting"]["cases"][0])
    case["accepted"] = not case["accepted"]
    document = json.dumps({"cases": [case]}).encode("utf-8")
    status, result = cabi.conformance_case(lib, "responseSplitting", document)
    assert status == Status.OK, cabi.last_error(lib)
    [recomputed] = json.loads(result)["cases"]
    assert recomputed["accepted"] is not case["accepted"]


def test_an_unknown_section_is_unsupported_and_a_malformed_document_is_a_codec_error(lib):
    assert cabi.conformance_case(lib, "noSuchSection", b"{}") == (Status.UNSUPPORTED, None)
    assert cabi.conformance_case(lib, "router", b"{not json") == (Status.CODEC, None)


@pytest.fixture(scope="module")
def site(lib):
    """A server whose miss route answers every request with the parsed head it read."""
    serving = cabi.Site(lib, cabi.echo)
    yield serving
    serving.close()


def body_of(head: dict) -> tuple[bytes, bytes]:
    """The body to send after a vector's head, and the body the server must read."""
    framing = head["body"]
    if framing == "none":
        return b"", b""
    if framing == "chunked":
        return b"5\r\nhello\r\n0\r\n\r\n", b"hello"
    content = b"a" * framing["length"]
    return content, content


@pytest.mark.parametrize("case", HTTP1, ids=[f"{case['name']} ({case['section']})" for case in HTTP1])
def test_an_http1_parser_vector_is_answered_end_to_end_as_it_states(site, case):
    request = bytes.fromhex(case["request"])
    expect = case["expect"]
    if "reject" in expect:
        rejected = expect["reject"]
        reply = cabi.exchange(site.address, request, expect_close=rejected["close"])
        assert reply.status == rejected["status"]
        assert reply.closed or not rejected["close"], "the connection closes after a reject"
        return
    head = expect["head"]
    sent, read = body_of(head)
    reply = cabi.exchange(site.address, request + sent, expect_close=not head["keepAlive"])
    assert reply.status == 200, reply.body
    echoed = json.loads(reply.body)
    assert echoed["method"] == head["method"]
    assert echoed["target"] == head["target"]
    assert echoed["version"] == head["version"]
    assert echoed["fields"] == head["fields"]
    assert echoed["keepAlive"] is head["keepAlive"]
    assert bytes.fromhex(echoed["body"]) == read
    if not head["keepAlive"]:
        assert reply.closed, "the connection closes after the response"
