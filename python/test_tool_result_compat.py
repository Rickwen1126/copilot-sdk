from copilot.tools import ToolResult


def test_tool_result_accepts_legacy_camel_case_kwargs() -> None:
    result = ToolResult(
        textResultForLlm="legacy custom",
        resultType="failure",
        toolTelemetry={"source": "legacy"},
    )

    assert result.text_result_for_llm == "legacy custom"
    assert result.result_type == "failure"
    assert result.tool_telemetry == {"source": "legacy"}
