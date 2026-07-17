import { describe, expect, it } from "vitest";
import {
    codexSandboxPolicy,
    codexThreadSandboxMode,
    dynamicToolsFromDescriptors,
    extractFileChangesFromParams,
    mapCodexCommandApprovalToPermissionRequest,
    mapCodexFileChangeApprovalToPermissionRequest,
    mapCodexModels,
    mapPermissionResultToCodexCommandDecision,
    mapPermissionResultToCodexFileChangeDecision,
    mapSdkToolResultToCodexDynamicToolResponse,
    normalizedSandboxMode,
    toolDescriptorsFromSessionCreateParams,
} from "../src/experimental/codexAdapterMappers.js";

describe("Codex adapter tool descriptor mappers", () => {
    it("normalizes SDK session tools before exposing them to Codex dynamic tools", () => {
        const descriptors = toolDescriptorsFromSessionCreateParams({
            tools: [
                {
                    name: "lookup",
                    description: "Look up source data.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string" },
                        },
                        required: ["query"],
                    },
                    skipPermission: true,
                },
                {
                    description: "Missing a name.",
                    parameters: { type: "object" },
                },
                "not-a-tool",
            ],
        });

        expect(descriptors).toEqual([
            {
                name: "lookup",
                description: "Look up source data.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                    },
                    required: ["query"],
                },
                skipPermission: true,
            },
            {
                name: "unknown_tool",
                description: "Missing a name.",
                parameters: { type: "object" },
                skipPermission: false,
            },
        ]);

        expect(dynamicToolsFromDescriptors(descriptors)).toEqual([
            {
                name: "lookup",
                description: "Look up source data.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                    },
                    required: ["query"],
                },
                deferLoading: false,
            },
        ]);
    });

    it("keeps missing tool evidence explicit with an empty descriptor list", () => {
        expect(toolDescriptorsFromSessionCreateParams({})).toEqual([]);
        expect(dynamicToolsFromDescriptors([{ name: "plain" }])).toEqual([
            {
                name: "plain",
                description: "SDK tool plain",
                inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
                deferLoading: false,
            },
        ]);
    });
});

describe("Codex adapter dynamic tool result mappers", () => {
    it("maps SDK tool errors to failed Codex dynamic tool responses", () => {
        expect(mapSdkToolResultToCodexDynamicToolResponse(undefined, "tool failed")).toEqual({
            contentItems: [{ type: "inputText", text: "tool failed" }],
            success: false,
        });
    });

    it("maps SDK string and object tool results to Codex text content items", () => {
        expect(mapSdkToolResultToCodexDynamicToolResponse("hello", undefined)).toEqual({
            contentItems: [{ type: "inputText", text: "hello" }],
            success: true,
        });

        expect(
            mapSdkToolResultToCodexDynamicToolResponse(
                { textResultForLlm: "not allowed", resultType: "denied" },
                undefined
            )
        ).toEqual({
            contentItems: [{ type: "inputText", text: "not allowed" }],
            success: false,
        });
    });

    it("does not leak arbitrary object tool-result structure to the model", () => {
        expect(
            mapSdkToolResultToCodexDynamicToolResponse(
                {
                    resultType: "success",
                    internalId: "secret-row-123",
                    rawPayload: { nested: "debug-only" },
                },
                undefined
            )
        ).toEqual({
            contentItems: [{ type: "inputText", text: "Tool completed without textResultForLlm." }],
            success: true,
        });
    });

    it("serializes non-string SDK tool results without inventing content", () => {
        expect(mapSdkToolResultToCodexDynamicToolResponse(null, undefined)).toEqual({
            contentItems: [{ type: "inputText", text: "" }],
            success: true,
        });

        expect(mapSdkToolResultToCodexDynamicToolResponse(42, undefined)).toEqual({
            contentItems: [{ type: "inputText", text: "42" }],
            success: true,
        });
    });
});

describe("Codex adapter model mappers", () => {
    it("maps Codex model metadata into SDK model list capability shape", () => {
        expect(
            mapCodexModels({
                data: [
                    {
                        id: "gpt-5.4",
                        displayName: "GPT 5.4",
                        inputModalities: ["text", "image"],
                        supportedReasoningEfforts: [
                            { reasoningEffort: "low" },
                            { reasoningEffort: "high" },
                            { ignored: true },
                        ],
                        defaultReasoningEffort: "high",
                    },
                ],
            })
        ).toEqual([
            {
                id: "gpt-5.4",
                name: "GPT 5.4",
                capabilities: {
                    supports: {
                        vision: true,
                        reasoningEffort: true,
                    },
                    limits: {
                        max_context_window_tokens: 0,
                    },
                },
                supportedReasoningEfforts: ["low", "high"],
                defaultReasoningEffort: "high",
            },
        ]);
    });

    it("returns an empty model list when Codex evidence is missing", () => {
        expect(mapCodexModels(undefined)).toEqual([]);
        expect(mapCodexModels({ data: "not-an-array" })).toEqual([]);
    });
});

describe("Codex adapter sandbox mappers", () => {
    it("normalizes SDK-facing sandbox aliases into Codex thread sandbox modes", () => {
        expect(normalizedSandboxMode("danger-full-access")).toBe("dangerFullAccess");
        expect(normalizedSandboxMode("workspaceWrite")).toBe("workspaceWrite");
        expect(normalizedSandboxMode("read-only")).toBe("readOnly");

        expect(codexThreadSandboxMode("dangerFullAccess")).toBe("danger-full-access");
        expect(codexThreadSandboxMode("workspaceWrite")).toBe("workspace-write");
        expect(codexThreadSandboxMode("readOnly")).toBe("read-only");
    });

    it("maps SDK-facing sandbox aliases into Codex turn sandbox policy objects", () => {
        expect(codexSandboxPolicy("danger-full-access", true)).toEqual({
            type: "dangerFullAccess",
        });

        expect(codexSandboxPolicy("workspaceWrite", true)).toEqual({
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });

        expect(codexSandboxPolicy("readOnly", false)).toEqual({
            type: "readOnly",
            networkAccess: false,
        });
    });
});

describe("Codex adapter command approval mappers", () => {
    it("maps Codex command approval requests into SDK shell permission requests", () => {
        const request = mapCodexCommandApprovalToPermissionRequest({
            itemId: "item-1",
            reason: "Need to write the approval probe.",
            command: "zsh -lc 'echo hello > /tmp/probe'",
            commandActions: [{ command: "zsh -lc 'echo hello > /tmp/probe'" }],
            availableDecisions: ["accept", "acceptForSession"],
        });

        expect(request).toEqual({
            kind: "shell",
            toolCallId: "item-1",
            intention: "Need to write the approval probe.",
            canOfferSessionApproval: true,
            fullCommandText: "zsh -lc 'echo hello > /tmp/probe'",
            hasWriteFileRedirection: true,
            commands: [{ identifier: "zsh", readOnly: false }],
            possiblePaths: [],
            possibleUrls: [],
        });
    });

    it("falls back to a default shell permission shape when command details are sparse", () => {
        const request = mapCodexCommandApprovalToPermissionRequest({
            availableDecisions: [{ acceptWithExecpolicyAmendment: {} }],
        });

        expect(request).toMatchObject({
            kind: "shell",
            intention: "Execute a shell command outside the current approval boundary.",
            canOfferSessionApproval: true,
            fullCommandText: "",
            hasWriteFileRedirection: false,
            commands: [{ identifier: "command", readOnly: false }],
        });
    });

    it("maps approved SDK permission results to the most specific Codex command decision", () => {
        expect(
            mapPermissionResultToCodexCommandDecision(
                { kind: "approved" },
                {
                    availableDecisions: ["accept"],
                }
            )
        ).toBe("accept");

        expect(
            mapPermissionResultToCodexCommandDecision(
                { kind: "approved" },
                {
                    availableDecisions: ["acceptWithExecpolicyAmendment"],
                    proposedExecpolicyAmendment: ["zsh", "-lc", "echo hello"],
                }
            )
        ).toEqual({
            acceptWithExecpolicyAmendment: {
                execpolicy_amendment: ["zsh", "-lc", "echo hello"],
            },
        });

        expect(
            mapPermissionResultToCodexCommandDecision(
                { kind: "approved" },
                {
                    availableDecisions: ["applyNetworkPolicyAmendment"],
                    proposedNetworkPolicyAmendments: [{ action: "allow", host: "example.com" }],
                }
            )
        ).toEqual({
            applyNetworkPolicyAmendment: {
                network_policy_amendment: { action: "allow", host: "example.com" },
            },
        });
    });

    it("maps denied or unknown SDK permission results to Codex decline", () => {
        expect(mapPermissionResultToCodexCommandDecision({ kind: "denied" }, {})).toBe("decline");
        expect(mapPermissionResultToCodexCommandDecision(undefined, {})).toBe("decline");
    });
});

describe("Codex adapter file approval mappers", () => {
    it("extracts file changes from either top-level changes or nested item changes", () => {
        const topLevelChanges = [{ path: "/tmp/top-level.txt" }];
        const nestedChanges = [{ path: "/tmp/nested.txt" }];

        expect(extractFileChangesFromParams({ changes: topLevelChanges })).toBe(topLevelChanges);
        expect(extractFileChangesFromParams({ item: { changes: nestedChanges } })).toBe(
            nestedChanges
        );
        expect(extractFileChangesFromParams({ item: {} })).toEqual([]);
        expect(extractFileChangesFromParams(undefined)).toEqual([]);
    });

    it("maps Codex file approval requests into SDK write permission requests", () => {
        const changes = [
            { path: "/tmp/allowed.txt", kind: "write" },
            { path: "/tmp/second.txt", kind: "write" },
            { kind: "metadata-without-path" },
        ];

        const request = mapCodexFileChangeApprovalToPermissionRequest(
            {
                itemId: "file-item-1",
                reason: "Apply approved file edits.",
                grantRoot: "/tmp",
            },
            changes
        );

        expect(request).toEqual({
            kind: "write",
            toolCallId: "file-item-1",
            intention: "Apply approved file edits.",
            canOfferSessionApproval: false,
            diff: "",
            fileName: "/tmp/allowed.txt",
            grantRoot: "/tmp",
            paths: ["/tmp/allowed.txt", "/tmp/second.txt"],
            possiblePaths: ["/tmp/allowed.txt", "/tmp/second.txt"],
            changes,
        });
    });

    it("keeps missing file approval evidence visible in the permission request", () => {
        const request = mapCodexFileChangeApprovalToPermissionRequest({}, []);

        expect(request).toEqual({
            kind: "write",
            toolCallId: undefined,
            intention: "Apply file changes outside the current approval boundary.",
            canOfferSessionApproval: false,
            diff: "",
            fileName: "",
            grantRoot: undefined,
            paths: [],
            possiblePaths: [],
            changes: [],
        });
    });

    it("maps SDK file permission results into Codex file change decisions", () => {
        expect(mapPermissionResultToCodexFileChangeDecision({ kind: "approved" })).toBe("accept");
        expect(mapPermissionResultToCodexFileChangeDecision({ kind: "denied" })).toBe("decline");
        expect(mapPermissionResultToCodexFileChangeDecision(undefined)).toBe("decline");
    });
});
