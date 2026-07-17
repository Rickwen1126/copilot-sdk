import { describe, expect, it } from "vitest";
import {
    attachClientProtocolRecorder,
    startClientWithRecorder,
    summarizeUnknownError,
    type ProtocolRecorderClient,
} from "../conformance/codexConformanceProtocolRecorder.js";

describe("Codex conformance protocol recorder", () => {
    it("records SDK requests, Copilot responses, and notifications", async () => {
        const calls: unknown[] = [];
        const notifications: unknown[] = [];
        const client: ProtocolRecorderClient = {
            connection: {
                sendRequest: async (method: string, params: unknown) => {
                    calls.push({ method, params });
                    return { ok: true };
                },
            },
            handleSessionEventNotification(notification: unknown) {
                notifications.push(notification);
            },
        };
        const recorder = attachClientProtocolRecorder(client, {
            now: () => "2026-06-11T00:00:00Z",
        });

        await expect(
            client.connection?.sendRequest("session.create", { model: "gpt" })
        ).resolves.toEqual({ ok: true });
        client.handleSessionEventNotification?.({ type: "session.start" });

        expect(calls).toEqual([{ method: "session.create", params: { model: "gpt" } }]);
        expect(notifications).toEqual([{ type: "session.start" }]);
        expect(recorder.summary()).toMatchObject({
            requestMethods: ["session.create"],
            notificationKinds: ["copilot->sdk.notification.session.event"],
        });
        expect(recorder.summary().transcripts).toHaveLength(3);
    });

    it("records response errors and rethrows them", async () => {
        const client: ProtocolRecorderClient = {
            connection: {
                sendRequest: async () => {
                    throw new Error("boom");
                },
            },
        };
        const recorder = attachClientProtocolRecorder(client, { now: () => "now" });

        await expect(client.connection?.sendRequest("session.send", {})).rejects.toThrow("boom");
        expect(recorder.summary().transcripts[1]).toMatchObject({
            direction: "copilot->sdk.response",
            message: {
                method: "session.send",
                error: {
                    name: "Error",
                    message: "boom",
                },
            },
        });
    });

    it("attaches during client start and restores connectToServer", async () => {
        let connectCalls = 0;
        const client: ProtocolRecorderClient = {
            connection: {
                sendRequest: async () => ({ ok: true }),
            },
            async connectToServer() {
                connectCalls += 1;
            },
            async start() {
                await this.connectToServer?.();
            },
        };
        const originalConnectToServer = client.connectToServer;

        const recorder = await startClientWithRecorder(client, { now: () => "now" });
        await client.connection?.sendRequest("session.create", {});

        expect(connectCalls).toBe(1);
        expect(client.connectToServer).toBe(originalConnectToServer);
        expect(recorder.summary().requestMethods).toEqual(["session.create"]);
    });

    it("restores connectToServer when start fails", async () => {
        const client: ProtocolRecorderClient = {
            connection: {
                sendRequest: async () => ({ ok: true }),
            },
            async connectToServer() {},
            async start() {
                throw new Error("start failed");
            },
        };
        const originalConnectToServer = client.connectToServer;

        await expect(startClientWithRecorder(client)).rejects.toThrow("start failed");
        expect(client.connectToServer).toBe(originalConnectToServer);
    });

    it("summarizes non-error throws without leaking object structure assumptions", () => {
        expect(summarizeUnknownError("bad")).toEqual({ name: "Error", message: "bad" });
        expect(summarizeUnknownError({ code: "BAD" })).toEqual({
            name: "Error",
            message: '{"code":"BAD"}',
        });
    });
});
