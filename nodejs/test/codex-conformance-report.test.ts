import { describe, expect, it } from "vitest";
import {
    buildConformanceReportArtifact,
    combineStatusTriplet,
    combineStatuses,
    makeCheck,
    missingProbeStatus,
    statusFromBooleans,
    statusFromOptionalProbe,
    statusTripletFromOptionalProbe,
} from "../conformance/codexConformanceReport.js";
import { type NormalizedLedgerEntry } from "../conformance/codexConformanceLedger.js";

const baseLedgerEntry: NormalizedLedgerEntry = {
    runId: "run-1",
    backend: "copilot-cli",
    source: "sdk",
    target: "copilot",
    method: "session.create",
    direction: "request",
    payloadShape: "object",
    sanitizedPayload: { method: "session.create" },
    timestamp: "2026-06-11T10:00:00.000Z",
    status: "ok",
};

describe("Codex conformance report helpers", () => {
    it("combines statuses with fail taking precedence over not-run and pass", () => {
        expect(combineStatuses("pass", "pass")).toBe("pass");
        expect(combineStatuses("pass", "not-run")).toBe("not-run");
        expect(combineStatuses("pass", "not-run", "fail")).toBe("fail");
    });

    it("converts boolean assertion groups into pass/fail status", () => {
        expect(statusFromBooleans(true, true)).toBe("pass");
        expect(statusFromBooleans(true, false)).toBe("fail");
    });

    it("builds check status from backend, trace, data, and intent assertions", () => {
        const check = makeCheck({
            capability: "core new session",
            profile: "SDK Core Profile",
            backendStatus: {
                copilotCli: "pass",
                codexAdapter: "pass",
            },
            traceParity: "pass",
            dataAssertion: "pass",
            intentAssertion: "not-run",
            evidence: ["adapterEvents=session.start,assistant.message"],
            missing: ["baseline intent not recorded"],
        });

        expect(check.status).toBe("not-run");
        expect(check.missing).toEqual(["baseline intent not recorded"]);
    });

    it("marks configured missing probes as fail only when that backend recorded the scenario", () => {
        expect(missingProbeStatus({ configured: false, backendRecorded: true })).toBe("not-run");
        expect(missingProbeStatus({ configured: true, backendRecorded: false })).toBe("not-run");
        expect(missingProbeStatus({ configured: true, backendRecorded: true })).toBe("fail");
    });

    it("converts optional probe assertions into status triplets", () => {
        expect(
            statusFromOptionalProbe({
                probePresent: true,
                passed: true,
                configured: true,
                backendRecorded: true,
            })
        ).toBe("pass");
        expect(
            statusFromOptionalProbe({
                probePresent: true,
                passed: false,
                configured: true,
                backendRecorded: true,
            })
        ).toBe("fail");
        expect(
            statusFromOptionalProbe({
                probePresent: false,
                passed: true,
                configured: true,
                backendRecorded: true,
            })
        ).toBe("fail");
        expect(
            statusFromOptionalProbe({
                probePresent: false,
                passed: true,
                configured: false,
                backendRecorded: true,
            })
        ).toBe("not-run");
    });

    it("combines trace/data/intent triplets into one backend status", () => {
        expect(combineStatusTriplet({ trace: "pass", data: "pass", intent: "pass" })).toBe("pass");
        expect(combineStatusTriplet({ trace: "pass", data: "not-run", intent: "pass" })).toBe(
            "not-run"
        );
        expect(combineStatusTriplet({ trace: "pass", data: "not-run", intent: "fail" })).toBe(
            "fail"
        );
    });

    it("builds trace/data/intent status triplets from optional probe assertions", () => {
        expect(
            statusTripletFromOptionalProbe({
                probePresent: true,
                configured: true,
                backendRecorded: true,
                tracePassed: true,
                dataPassed: false,
                intentPassed: true,
            })
        ).toEqual({ trace: "pass", data: "fail", intent: "pass" });
        expect(
            statusTripletFromOptionalProbe({
                probePresent: false,
                configured: false,
                backendRecorded: true,
                tracePassed: true,
                dataPassed: true,
                intentPassed: true,
            })
        ).toEqual({ trace: "not-run", data: "not-run", intent: "not-run" });
        expect(
            statusTripletFromOptionalProbe({
                probePresent: false,
                configured: true,
                backendRecorded: true,
                tracePassed: true,
                dataPassed: true,
                intentPassed: true,
            })
        ).toEqual({ trace: "fail", data: "fail", intent: "fail" });
    });

    it("assembles report artifact shape without deciding scenario-specific checks", () => {
        const copilotLedger = [baseLedgerEntry];
        const adapterLedger: NormalizedLedgerEntry[] = [
            {
                ...baseLedgerEntry,
                backend: "codex-adapter",
                source: "sdk",
                target: "adapter",
            },
            {
                ...baseLedgerEntry,
                backend: "codex-adapter",
                source: "adapter",
                target: "codex",
                method: "thread/start",
            },
        ];
        const passingCheck = makeCheck({
            capability: "core new session",
            profile: "SDK Core Profile",
            backendStatus: {
                copilotCli: "pass",
                codexAdapter: "pass",
            },
            traceParity: "pass",
            dataAssertion: "pass",
            intentAssertion: "pass",
            evidence: [],
            missing: [],
        });
        const notRunCheck = makeCheck({
            capability: "resume continuation",
            profile: "SDK Core Profile",
            backendStatus: {
                copilotCli: "not-run",
                codexAdapter: "pass",
            },
            traceParity: "not-run",
            dataAssertion: "not-run",
            intentAssertion: "not-run",
            evidence: [],
            missing: ["baseline resume scenario is not recorded yet"],
        });

        const report = buildConformanceReportArtifact({
            runId: "run-1",
            generatedAt: "2026-06-11T10:01:00.000Z",
            checks: [passingCheck, notRunCheck],
            copilotLedger,
            adapterLedger,
        });

        expect(report.verdict).toBe("not-run");
        expect(report.ledgerCounts).toEqual({ copilotCli: 1, codexAdapter: 2 });
        expect(report.targetProfiles).toEqual(["SDK Core Profile", "Coding Agent Profile"]);
        expect(report.unsupportedProfiles).toEqual([
            "Interactive Profile",
            "Fidelity Profile",
            "Extended CLI Profile",
        ]);
        expect(report.ledgers.codexAdapter).toBe(adapterLedger);
    });
});
