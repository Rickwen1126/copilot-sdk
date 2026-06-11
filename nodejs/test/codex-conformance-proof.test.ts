import { describe, expect, it } from "vitest";
import {
    buildToolPolicyReadinessReport,
    buildToolCallComplianceReport,
    buildToolSchemaRoundTripReport,
} from "../conformance/codexConformanceProof.js";

describe("Codex conformance proof helpers", () => {
    it("passes when SDK tool descriptors round-trip into Codex dynamic tool schemas", () => {
        const report = buildToolSchemaRoundTripReport({
            expectedTools: [
                {
                    name: "save_memo",
                    description: "Persist a memo.",
                    parameters: {
                        type: "object",
                        properties: {
                            text: { type: "string" },
                            tags: { type: "array", items: { type: "string" } },
                        },
                        required: ["text"],
                    },
                },
                {
                    name: "list_memos",
                },
            ],
            observedDynamicTools: [
                {
                    name: "save_memo",
                    description: "Persist a memo.",
                    inputSchema: {
                        required: ["text"],
                        properties: {
                            tags: { items: { type: "string" }, type: "array" },
                            text: { type: "string" },
                        },
                        type: "object",
                    },
                },
                {
                    name: "list_memos",
                    description: "SDK tool list_memos",
                    inputSchema: {
                        type: "object",
                        properties: {},
                        additionalProperties: false,
                    },
                },
            ],
        });

        expect(report.status).toBe("pass");
        expect(report.assertions.every((assertion) => assertion.status === "pass")).toBe(true);
        expect(report.expectedToolCount).toBe(2);
        expect(report.observedToolCount).toBe(2);
    });

    it("keeps missing and mutated schema evidence explicit", () => {
        const report = buildToolSchemaRoundTripReport({
            expectedTools: [
                {
                    name: "quote_search",
                    description: "Search quotation data.",
                    parameters: {
                        type: "object",
                        properties: { keyword: { type: "string" } },
                        required: ["keyword"],
                    },
                },
                {
                    name: "warehouse_search",
                    parameters: {
                        type: "object",
                        properties: { sku: { type: "string" } },
                    },
                },
            ],
            observedDynamicTools: [
                {
                    name: "quote_search",
                    description: "Search quotation data.",
                    inputSchema: {
                        type: "object",
                        properties: { keyword: { type: "number" } },
                        required: ["keyword"],
                    },
                },
                {
                    name: "unexpected_tool",
                    description: "Extra.",
                    inputSchema: {},
                },
            ],
        });

        expect(report.status).toBe("fail");
        expect(report.items).toMatchObject([
            { toolName: "quote_search", status: "fail", issues: ["inputSchema mismatch"] },
            { toolName: "warehouse_search", status: "fail", issues: ["dynamic tool is missing"] },
        ]);
        expect(report.assertions.map((assertion) => assertion.status)).toEqual([
            "fail",
            "fail",
            "fail",
        ]);
    });

    it("summarizes tool-call compliance by backend", () => {
        const report = buildToolCallComplianceReport([
            {
                backend: "codex-adapter",
                promptId: "save-marker",
                expectedToolName: "save_memo",
                sdkToolCalls: ["save_memo"],
                nativeToolCalls: [],
                resultStatus: "ok",
            },
            {
                backend: "codex-adapter",
                promptId: "search-quote",
                expectedToolName: "quote_search",
                sdkToolCalls: ["web_search"],
                nativeToolCalls: ["local_shell"],
                resultStatus: "ok",
            },
            {
                backend: "copilot-cli",
                promptId: "save-marker",
                expectedToolName: "save_memo",
                sdkToolCalls: ["save_memo"],
                resultStatus: "ok",
            },
        ]);

        expect(report.status).toBe("fail");
        expect(report.backendAccuracy).toEqual({
            "codex-adapter": { passed: 1, total: 2, accuracy: 0.5 },
            "copilot-cli": { passed: 1, total: 1, accuracy: 1 },
        });
        expect(report.observations[1]).toMatchObject({
            status: "fail",
            issues: ["expected SDK tool was not called", "native tool was called"],
        });
    });

    it("marks compliance as not-run when no benchmark observations exist", () => {
        const report = buildToolCallComplianceReport([]);

        expect(report.status).toBe("not-run");
        expect(report.assertions).toEqual([
            {
                name: "tool-call compliance benchmark produced observations",
                status: "not-run",
                evidence: "observations=0",
            },
        ]);
    });

    it("passes policy readiness when namespace, prompt, description, and multimodal decisions are explicit", () => {
        const report = buildToolPolicyReadinessReport({
            nativeToolNames: ["local_shell", "apply_patch"],
            sideEffectToolNames: ["save_memo"],
            multimodalToolNames: ["show_image"],
            tools: [
                {
                    name: "save_memo",
                    description: "Store a durable memo when the user asks to remember something.",
                },
                {
                    name: "show_image",
                    description:
                        "Return an already-authorized image back to the user conversation.",
                },
            ],
            promptMatrix: [
                {
                    promptId: "save_memo-selection",
                    expectedToolName: "save_memo",
                    prompt: "Dry-run: user asks to remember a note.",
                    executionMode: "dry-run-only",
                },
                {
                    promptId: "show_image-selection",
                    expectedToolName: "show_image",
                    prompt: "Show an authorized image URL.",
                    executionMode: "live-safe",
                },
            ],
            multimodalDecisions: [
                {
                    toolName: "show_image",
                    decision: "user-visible-media",
                    evidence: "The image is sent to the user channel, not back to the LLM.",
                },
            ],
        });

        expect(report.status).toBe("pass");
        expect(report.assertions.every((assertion) => assertion.status === "pass")).toBe(true);
        expect(report.toolCount).toBe(2);
        expect(report.promptCaseCount).toBe(2);
    });

    it("fails policy readiness for native collisions, weak descriptions, unsafe side effects, and missing prompt coverage", () => {
        const report = buildToolPolicyReadinessReport({
            nativeToolNames: ["shell"],
            sideEffectToolNames: ["save_memo"],
            multimodalToolNames: ["show_image"],
            tools: [
                { name: "shell", description: "Run shell" },
                { name: "save_memo", description: "SDK tool save_memo" },
                { name: "show_image", description: "Show an image to the user." },
            ],
            promptMatrix: [
                {
                    promptId: "save_memo-live",
                    expectedToolName: "save_memo",
                    prompt: "Remember this.",
                    executionMode: "live-safe",
                },
                {
                    promptId: "unknown-tool",
                    expectedToolName: "unknown_tool",
                    prompt: "Call unknown.",
                    executionMode: "dry-run-only",
                },
            ],
        });

        expect(report.status).toBe("fail");
        expect(report.namespaceCollisions).toEqual(["shell"]);
        expect(report.uncoveredTools).toEqual(["shell", "show_image"]);
        expect(report.unknownPromptTools).toEqual(["unknown_tool"]);
        expect(report.unsafePromptCases).toEqual(["save_memo-live"]);
        expect(report.multimodalPolicyMissing).toEqual(["show_image"]);
        expect(report.descriptionIssues).toEqual([
            {
                toolName: "shell",
                issues: ["description too short for reliable selection"],
            },
            {
                toolName: "save_memo",
                issues: ["fallback SDK description"],
            },
        ]);
    });
});
