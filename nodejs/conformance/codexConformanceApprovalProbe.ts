import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ApprovalProbeBackend = "copilot-cli" | "codex-adapter";

export type ApprovalProbeResult = {
    path: string;
    prompt: string;
    assistantMessage?: string;
    permissionRequests: unknown[];
    permissionRequestKinds: string[];
    permissionAssertionFailures: string[];
    preExisting: boolean;
    exists: boolean;
    contents?: string;
};

export type ApprovalProbePathOptions = {
    basePath: string | undefined;
    phase: string;
};

export type FileProbeNameOptions = {
    enabled: boolean;
    phase: string;
    runId: string;
};

export function approvalProbePathForBackend(
    backend: ApprovalProbeBackend,
    options: ApprovalProbePathOptions
): string | undefined {
    if (!options.basePath) {
        return undefined;
    }
    if (options.phase === "all") {
        return `${options.basePath}.${backend}`;
    }
    return options.basePath;
}

export function denialProbePathForBackend(
    backend: ApprovalProbeBackend,
    options: ApprovalProbePathOptions
): string | undefined {
    if (!options.basePath) {
        return undefined;
    }
    if (options.phase === "all") {
        return `${options.basePath}.deny.${backend}`;
    }
    return `${options.basePath}.deny`;
}

export function fileProbeNameForBackend(
    backend: ApprovalProbeBackend,
    options: FileProbeNameOptions
): string | undefined {
    if (!options.enabled) {
        return undefined;
    }
    if (options.phase === "all") {
        return `codex-file-approval-${options.runId}.${backend}.txt`;
    }
    return `codex-file-approval-${options.runId}.txt`;
}

export function fileDenyProbeNameForBackend(
    backend: ApprovalProbeBackend,
    options: FileProbeNameOptions
): string | undefined {
    if (!options.enabled) {
        return undefined;
    }
    if (options.phase === "all") {
        return `codex-file-approval-${options.runId}.deny.${backend}.txt`;
    }
    return `codex-file-approval-${options.runId}.deny.txt`;
}

export function fileProbePath(fileName: string | undefined, workdir: string): string | undefined {
    return fileName ? join(workdir, fileName) : undefined;
}

export function approvalProbePrompt(path: string): string {
    return `Use a shell command to write exactly hello to ${path}. The shell command should be: printf hello > ${path}. Do not use any other method.`;
}

export function denialProbePrompt(path: string): string {
    return `Use a shell command to write exactly denied to ${path}. The shell command should be: printf denied > ${path}. Do not use any other method.`;
}

export function fileApprovalProbePrompt(fileName: string, contents: string): string {
    return [
        `Use the file editing tool, not a shell command, to create a file named ${fileName} in the current working directory.`,
        "The complete file contents must be exactly:",
        contents,
        "Do not use shell commands.",
    ].join("\n");
}

export function fileDenialProbePrompt(fileName: string, contents: string): string {
    return [
        `Use the file editing tool, not a shell command, to create a file named ${fileName} in the current working directory.`,
        "The complete file contents must be exactly:",
        contents,
        "Do not use shell commands.",
        "If the file edit is denied, do not retry and do not use another method; report that the edit was denied.",
    ].join("\n");
}

export function permissionRequestKinds(requests: unknown[]): string[] {
    return requests.map((request) => {
        if (isRecord(request) && typeof request.kind === "string") {
            return request.kind;
        }
        return "unknown";
    });
}

export function permissionRequestsWithKind(requests: unknown[], kind: string): unknown[] {
    return requests.filter((request) => isRecord(request) && request.kind === kind);
}

export function validateShellPermissionRequest(
    request: unknown,
    expectedPath: string,
    expectedContents: string
): string[] {
    const failures: string[] = [];
    if (!isRecord(request)) {
        return ["permission request is not an object"];
    }

    if (request.kind !== "shell") {
        failures.push(`permission request kind is ${String(request.kind)}, expected shell`);
    }

    const fullCommandText =
        typeof request.fullCommandText === "string" ? request.fullCommandText : "";
    if (!fullCommandText.includes(expectedPath)) {
        failures.push("permission request command does not include expected path");
    }
    if (!fullCommandText.includes(`printf ${expectedContents}`)) {
        failures.push("permission request command does not include expected printf contents");
    }
    if (!fullCommandText.includes(">")) {
        failures.push("permission request command does not include a write redirection");
    }

    const commands = Array.isArray(request.commands) ? request.commands : [];
    if (commands.length === 0) {
        failures.push("permission request has no command metadata");
    }

    return failures;
}

export function validateWritePermissionRequest(
    request: unknown,
    expectedFileName: string
): string[] {
    const failures: string[] = [];
    if (!isRecord(request)) {
        return ["permission request is not an object"];
    }

    if (request.kind !== "write") {
        failures.push(`permission request kind is ${String(request.kind)}, expected write`);
    }

    const serialized = JSON.stringify(request);
    if (!serialized.includes(expectedFileName)) {
        failures.push("permission request does not include expected file name");
    }

    return failures;
}

export function readApprovalProbeResult(input: {
    path: string;
    prompt: string;
    assistantMessage: string | undefined;
    permissionRequests: unknown[];
    permissionAssertionFailures: string[];
    preExisting: boolean;
}): ApprovalProbeResult {
    const exists = existsSync(input.path);
    return {
        path: input.path,
        prompt: input.prompt,
        assistantMessage: input.assistantMessage,
        permissionRequests: input.permissionRequests,
        permissionRequestKinds: permissionRequestKinds(input.permissionRequests),
        permissionAssertionFailures: input.permissionAssertionFailures,
        preExisting: input.preExisting,
        exists,
        contents: exists ? readFileSync(input.path, "utf8") : undefined,
    };
}

export function promptIntentPass(prompt: string, assistantMessage: string | undefined): boolean {
    if (!assistantMessage) {
        return false;
    }
    if (prompt === "Reply with READY and nothing else.") {
        return assistantMessage.trim() === "READY";
    }
    return assistantMessage.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
