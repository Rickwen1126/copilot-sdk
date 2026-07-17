"""Backward-compatible tool type exports.

Some downstream apps import tool dataclasses from ``copilot.types``. The local
source tree defines them in ``copilot.tools``; keep this module as a thin
compatibility layer so editable-source consumers do not need import rewrites.
"""

from .tools import (
    Tool,
    ToolBinaryResult,
    ToolHandler,
    ToolInvocation,
    ToolResult,
    ToolResultType,
)

__all__ = [
    "Tool",
    "ToolBinaryResult",
    "ToolHandler",
    "ToolInvocation",
    "ToolResult",
    "ToolResultType",
]
