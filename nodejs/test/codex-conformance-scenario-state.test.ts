import { describe, expect, it } from "vitest";
import {
    createScenarioEventBuckets,
    recordScenarioEvent,
    summarizeScenarioEventTypes,
} from "../conformance/codexConformanceScenarioState.js";

describe("Codex conformance scenario state helpers", () => {
    it("creates stable event buckets for every scenario channel", () => {
        expect(createScenarioEventBuckets()).toEqual({
            client1: [],
            client2: [],
            approvalProbe: [],
            denialProbe: [],
            fileApprovalProbe: [],
            fileDenialProbe: [],
            toolProbe: [],
            toolFailureProbe: [],
        });
    });

    it("records event type and payload data into the selected bucket", () => {
        const buckets = createScenarioEventBuckets();
        const recordClient1 = recordScenarioEvent(buckets, "client1");
        const recordToolProbe = recordScenarioEvent(buckets, "toolProbe");

        recordClient1({ type: "session.start", data: { sessionId: "s1" } });
        recordToolProbe({ type: "tool.call" });

        expect(buckets.client1).toEqual([{ type: "session.start", data: { sessionId: "s1" } }]);
        expect(buckets.toolProbe).toEqual([{ type: "tool.call", data: undefined }]);
    });

    it("summarizes bucket event types with optional history", () => {
        const buckets = createScenarioEventBuckets();
        recordScenarioEvent(buckets, "client1")({ type: "session.start" });
        recordScenarioEvent(buckets, "approvalProbe")({ type: "permission.requested" });

        expect(
            summarizeScenarioEventTypes(buckets, [
                { type: "user.message" },
                { type: "assistant.message" },
            ])
        ).toMatchObject({
            client1: ["session.start"],
            approvalProbe: ["permission.requested"],
            history: ["user.message", "assistant.message"],
        });
    });
});
