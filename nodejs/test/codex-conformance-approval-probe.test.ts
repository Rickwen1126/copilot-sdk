import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
    approvalProbePathForBackend,
    approvalProbePrompt,
    denialProbePathForBackend,
    denialProbePrompt,
    fileApprovalProbePrompt,
    fileDenialProbePrompt,
    fileDenyProbeNameForBackend,
    fileProbeNameForBackend,
    fileProbePath,
    permissionRequestKinds,
    permissionRequestsWithKind,
    promptIntentPass,
    readApprovalProbeResult,
    validateShellPermissionRequest,
    validateWritePermissionRequest,
} from "../conformance/codexConformanceApprovalProbe.js";

describe("Codex conformance approval probe helpers", () => {
    it("builds backend-specific command and file probe fixtures for all-phase runs", () => {
        const commandOptions = { basePath: "/tmp/codex-approval", phase: "all" };
        const fileOptions = { enabled: true, phase: "all", runId: "run-1" };

        expect(approvalProbePathForBackend("copilot-cli", commandOptions)).toBe(
            "/tmp/codex-approval.copilot-cli"
        );
        expect(denialProbePathForBackend("codex-adapter", commandOptions)).toBe(
            "/tmp/codex-approval.deny.codex-adapter"
        );
        expect(fileProbeNameForBackend("copilot-cli", fileOptions)).toBe(
            "codex-file-approval-run-1.copilot-cli.txt"
        );
        expect(fileDenyProbeNameForBackend("codex-adapter", fileOptions)).toBe(
            "codex-file-approval-run-1.deny.codex-adapter.txt"
        );
        expect(fileProbePath("probe.txt", "/workspace")).toBe(join("/workspace", "probe.txt"));
    });

    it("builds shared probe fixture names for single-backend runs", () => {
        const commandOptions = { basePath: "/tmp/codex-approval", phase: "protocol" };
        const fileOptions = { enabled: true, phase: "adapter", runId: "run-2" };

        expect(approvalProbePathForBackend("copilot-cli", commandOptions)).toBe(
            "/tmp/codex-approval"
        );
        expect(denialProbePathForBackend("codex-adapter", commandOptions)).toBe(
            "/tmp/codex-approval.deny"
        );
        expect(fileProbeNameForBackend("copilot-cli", fileOptions)).toBe(
            "codex-file-approval-run-2.txt"
        );
        expect(fileDenyProbeNameForBackend("codex-adapter", fileOptions)).toBe(
            "codex-file-approval-run-2.deny.txt"
        );
        expect(fileProbeNameForBackend("copilot-cli", { ...fileOptions, enabled: false })).toBe(
            undefined
        );
    });

    it("renders prompt contracts and validates prompt intent", () => {
        expect(approvalProbePrompt("/tmp/out")).toContain("printf hello > /tmp/out");
        expect(denialProbePrompt("/tmp/out")).toContain("printf denied > /tmp/out");
        expect(fileApprovalProbePrompt("probe.txt", "hello\n")).toContain("hello\n");
        expect(fileDenialProbePrompt("probe.txt", "denied\n")).toContain("do not retry");
        expect(promptIntentPass("Reply with READY and nothing else.", "READY")).toBe(true);
        expect(promptIntentPass("Reply with READY and nothing else.", "ready")).toBe(false);
        expect(promptIntentPass("Any nonempty answer", " done ")).toBe(true);
    });

    it("summarizes and validates shell permission requests", () => {
        const request = {
            kind: "shell",
            fullCommandText: "printf hello > /tmp/out",
            commands: [{ command: "printf" }],
        };

        expect(permissionRequestKinds([request, { kind: "write" }, "bad"])).toEqual([
            "shell",
            "write",
            "unknown",
        ]);
        expect(permissionRequestsWithKind([request, { kind: "write" }], "shell")).toEqual([
            request,
        ]);
        expect(validateShellPermissionRequest(request, "/tmp/out", "hello")).toEqual([]);
        expect(
            validateShellPermissionRequest(
                { ...request, fullCommandText: "echo hi" },
                "/tmp/out",
                "hello"
            )
        ).toContain("permission request command does not include expected path");
    });

    it("validates write permission requests and reads probe results", () => {
        const workdir = mkdtempSync(join(tmpdir(), "codex-approval-probe-"));
        const probePath = join(workdir, "probe.txt");
        writeFileSync(probePath, "hello", "utf8");

        expect(
            validateWritePermissionRequest({ kind: "write", path: "probe.txt" }, "probe.txt")
        ).toEqual([]);
        expect(
            validateWritePermissionRequest({ kind: "shell", path: "probe.txt" }, "probe.txt")
        ).toContain("permission request kind is shell, expected write");

        expect(
            readApprovalProbeResult({
                path: probePath,
                prompt: "prompt",
                assistantMessage: "done",
                permissionRequests: [{ kind: "write" }],
                permissionAssertionFailures: [],
                preExisting: false,
            })
        ).toMatchObject({
            path: probePath,
            prompt: "prompt",
            assistantMessage: "done",
            permissionRequestKinds: ["write"],
            permissionAssertionFailures: [],
            preExisting: false,
            exists: true,
            contents: "hello",
        });
    });
});
