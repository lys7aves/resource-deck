import asyncio

import pytest

from resourcedeck.collectors.codex import CodexAppServerClient, CodexCollectorError, codex_environment, merge_rate_limit_update, parse_rate_limits_response, read_codex_rate_limits
from resourcedeck.config import CodexProviderSettings
from resourcedeck.models import MetricStatus
from resourcedeck.scheduler import CodexUsagePoller
from resourcedeck.state import SnapshotStore


def response(*, credits=True):
    return {
        "rateLimitsByLimitId": {
            "extra": {"limitId": "extra", "limitName": "Reserve", "primary": {"usedPercent": 10, "windowDurationMins": 60, "resetsAt": 200}, "secondary": None},
            "codex": {"limitId": "codex", "limitName": None, "planType": "plus", "primary": {"usedPercent": 47, "windowDurationMins": 300, "resetsAt": 100}, "secondary": {"usedPercent": 32, "windowDurationMins": 10080, "resetsAt": 200}, "credits": {"hasCredits": credits, "unlimited": False, "balance": "12"}},
        },
        "rateLimitResetCredits": {"availableCount": 2, "credits": []},
    }


def test_rate_limit_parser_normalizes_windows_and_additional_buckets():
    parsed = parse_rate_limits_response(response())
    assert parsed["plan_type"] == "plus"
    assert [bucket["id"] for bucket in parsed["buckets"]] == ["codex", "extra"]
    assert parsed["buckets"][0]["windows"][0]["remaining_percent"] == 53
    assert parsed["buckets"][0]["credits"]["balance"] == "12"
    assert parsed["reset_credits_available"] == 2


def test_rate_limit_parser_supports_single_bucket_and_rejects_malformed_data():
    single = response()["rateLimitsByLimitId"]["codex"]
    assert parse_rate_limits_response({"rateLimits": single})["buckets"][0]["id"] == "codex"
    with pytest.raises(CodexCollectorError, match="codex_malformed_response"):
        parse_rate_limits_response({"rateLimitsByLimitId": {"codex": {"primary": {}}}})


def test_codex_environment_uses_home_containing_executable():
    environment = codex_environment("/mnt/c/Users/example/.codex/bin/wsl/version/codex")
    assert environment["CODEX_HOME"] == "/mnt/c/Users/example/.codex"
    assert environment["CODEX_SQLITE_HOME"].endswith("/.codex/sqlite")


def test_rate_limit_notification_merges_partial_window_update():
    data = parse_rate_limits_response(response())
    merged = merge_rate_limit_update(data, {"limitId": "codex", "primary": {"usedPercent": 60, "windowDurationMins": 300, "resetsAt": 300}})
    codex = merged["buckets"][0]
    assert codex["windows"][0]["remaining_percent"] == 40
    assert codex["windows"][1]["remaining_percent"] == 68
    assert codex["credits"]["balance"] == "12"


@pytest.mark.asyncio
async def test_wait_for_rate_limit_update_skips_unrelated_messages_and_times_out():
    client = CodexAppServerClient("codex", 1)
    messages = iter([
        {"method": "thread/started", "params": {}},
        {"method": "account/rateLimits/updated", "params": {"rateLimits": {"limitId": "codex", "primary": {"usedPercent": 60, "windowDurationMins": 300, "resetsAt": 300}}}},
    ])

    async def message():
        return next(messages)

    client._message = message  # type: ignore[method-assign]
    update = await client.wait_for_rate_limit_update(1)
    assert update and update["primary"]["usedPercent"] == 60

    async def never():
        await asyncio.Future()

    client._message = never  # type: ignore[method-assign]
    assert await client.wait_for_rate_limit_update(0.01) is None


@pytest.mark.asyncio
async def test_codex_poller_marks_failures_stale_after_a_success():
    store = SnapshotStore()
    poller = CodexUsagePoller(CodexProviderSettings(enabled=True, executable="codex"), store)

    await poller._publish_data(parse_rate_limits_response(response()))
    assert store.providers()[0].status == MetricStatus.OK
    await poller._publish_error("codex_auth_required")
    assert store.providers()[0].status == MetricStatus.STALE
    assert store.providers()[0].error_code == "codex_auth_required"


@pytest.mark.asyncio
async def test_reader_reports_missing_executable():
    with pytest.raises(CodexCollectorError, match="codex_executable_not_found"):
        await read_codex_rate_limits("/definitely/not/codex", 1)
