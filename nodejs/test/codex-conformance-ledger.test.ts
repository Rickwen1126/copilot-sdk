import { describe, expect, it } from "vitest";
import {
    collectAdapterLedger,
    collectCopilotLedger,
    countLedgerHops,
    hasLedgerHop,
    normalizeTranscript,
} from "../conformance/codexConformanceLedger.js";

describe("Codex conformance ledger helpers", () => {
    it("normalizes transcript endpoints, ids, shapes, and sanitized payload evidence", () => {
        const ledger = normalizeTranscript("run-1", "codex-adapter", [
            {
                at: "2026-06-11T08:00:00.000Z",
                direction: "sdk->adapter.request",
                message: {
                    id: 7,
                    method: "session.create",
                    params: {
                        sessionId: "sdk-session-1",
                        threadId: "codex-thread-1",
                        permissionRequest: { kind: "command" },
                    },
                },
            },
            {
                at: "2026-06-11T08:00:01.000Z",
                direction: "codex->adapter",
                message: {
                    event: { type: "turn.completed" },
                    turn: { id: "codex-turn-1", status: "completed" },
                },
            },
            {
                at: "2026-06-11T08:00:02.000Z",
                direction: "adapter->sdk.response",
                message: {
                    id: "response-1",
                    result: { sessionId: "sdk-session-1" },
                },
            },
            {
                at: "2026-06-11T08:00:03.000Z",
                direction: "codex.stderr",
                message: "runtime warning",
            },
        ]);

        expect(ledger).toHaveLength(4);
        expect(ledger[0]).toMatchObject({
            runId: "run-1",
            backend: "codex-adapter",
            requestId: "7",
            sessionId: "sdk-session-1",
            turnId: "codex-thread-1",
            source: "sdk",
            target: "adapter",
            method: "session.create",
            direction: "request",
            timestamp: "2026-06-11T08:00:00.000Z",
            status: "ok",
        });
        expect(ledger[0]?.sanitizedPayload).toMatchObject({
            id: "7",
            method: "session.create",
            sessionId: "sdk-session-1",
            threadId: "codex-thread-1",
            permissionKind: "command",
            hasResult: false,
            hasError: false,
        });
        expect(ledger[1]).toMatchObject({
            source: "codex",
            target: "adapter",
            method: "turn.completed",
            direction: "notification",
            turnId: "codex-turn-1",
        });
        expect(ledger[2]).toMatchObject({
            source: "adapter",
            target: "sdk",
            method: "adapter->sdk.response",
            direction: "response",
            resultShape: { sessionId: "string" },
        });
        expect(ledger[3]).toMatchObject({
            source: "codex",
            target: "adapter",
            method: "codex.stderr",
            direction: "log",
            sanitizedPayload: {
                type: "string",
                length: "runtime warning".length,
            },
        });
    });

    it("marks direct and nested error payloads as error ledger entries", () => {
        const ledger = normalizeTranscript("run-1", "copilot-cli", [
            {
                at: "2026-06-11T08:01:00.000Z",
                direction: "copilot->sdk.response",
                message: { id: "direct", error: { message: "direct failure" } },
            },
            {
                at: "2026-06-11T08:01:01.000Z",
                direction: "copilot->sdk.response",
                message: { message: { id: "nested", error: { message: "nested failure" } } },
            },
        ]);

        expect(ledger.map((entry) => entry.status)).toEqual(["error", "error"]);
    });

    it("counts and matches normalized ledger hops by method, endpoint, and direction", () => {
        const ledger = normalizeTranscript("run-1", "codex-adapter", [
            {
                at: "2026-06-11T08:02:00.000Z",
                direction: "sdk->adapter.request",
                message: { id: 1, method: "session.send" },
            },
            {
                at: "2026-06-11T08:02:01.000Z",
                direction: "adapter->codex.request",
                message: { id: 2, method: "turn/start" },
            },
            {
                at: "2026-06-11T08:02:02.000Z",
                direction: "adapter->codex.request",
                message: { id: 3, method: "turn/start" },
            },
        ]);

        expect(
            hasLedgerHop(ledger, {
                source: "sdk",
                target: "adapter",
                method: "session.send",
                direction: "request",
            })
        ).toBe(true);
        expect(
            countLedgerHops(ledger, {
                source: "adapter",
                target: "codex",
                method: "turn/start",
                direction: "request",
            })
        ).toBe(2);
        expect(
            hasLedgerHop(ledger, {
                source: "codex",
                target: "adapter",
                method: "turn/start",
            })
        ).toBe(false);
    });

    it("collects Copilot baseline transcripts from legacy and client recordings", () => {
        const ledger = collectCopilotLedger("run-1", {
            connectionRecording: {
                transcripts: [
                    {
                        at: "2026-06-11T08:03:00.000Z",
                        direction: "sdk->copilot.request",
                        message: { id: "legacy", method: "session.create" },
                    },
                    { at: "missing direction", message: { method: "ignored" } },
                ],
            },
            clientRecording: {
                client1: {
                    transcripts: [
                        {
                            at: "2026-06-11T08:03:01.000Z",
                            direction: "sdk->copilot.request",
                            message: { id: "client-1", method: "session.send" },
                        },
                    ],
                },
                client2: {
                    transcripts: [
                        {
                            at: "2026-06-11T08:03:02.000Z",
                            direction: "sdk->copilot.request",
                            message: { id: "client-2", method: "session.destroy" },
                        },
                    ],
                },
            },
        });

        expect(ledger.map((entry) => entry.backend)).toEqual([
            "copilot-cli",
            "copilot-cli",
            "copilot-cli",
        ]);
        expect(ledger.map((entry) => entry.requestId)).toEqual(["legacy", "client-1", "client-2"]);
    });

    it("collects adapter transcripts from adapter, Codex, and client recordings", () => {
        const ledger = collectAdapterLedger("run-1", {
            adapter: {
                transcripts: [
                    {
                        at: "2026-06-11T08:04:00.000Z",
                        direction: "sdk->adapter.request",
                        message: { id: "adapter", method: "session.create" },
                    },
                ],
                codex: {
                    transcripts: [
                        {
                            at: "2026-06-11T08:04:01.000Z",
                            direction: "adapter->codex.request",
                            message: { id: "codex", method: "thread/start" },
                        },
                    ],
                },
            },
            clientRecording: {
                client1: {
                    transcripts: [
                        {
                            at: "2026-06-11T08:04:02.000Z",
                            direction: "adapter->sdk.notification",
                            message: { method: "session.started" },
                        },
                    ],
                },
                client2: {
                    transcripts: [
                        {
                            at: "2026-06-11T08:04:03.000Z",
                            direction: "sdk->adapter.request",
                            message: { id: "client-2", method: "session.destroy" },
                        },
                    ],
                },
            },
        });

        expect(ledger.map((entry) => entry.backend)).toEqual([
            "codex-adapter",
            "codex-adapter",
            "codex-adapter",
            "codex-adapter",
        ]);
        expect(ledger.map((entry) => entry.method)).toEqual([
            "session.create",
            "thread/start",
            "session.started",
            "session.destroy",
        ]);
    });
});
