import { describe, expect, it } from "vitest";
import {
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
});
