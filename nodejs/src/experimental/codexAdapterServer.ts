#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import process from "node:process";
import {
    CodexCopilotAdapterServer,
    type CodexAdapterOptions,
    type CodexAdapterSandboxMode,
} from "./codexAdapter.js";

function envString(name: string): string | undefined {
    const value = process.env[name];
    return value && value.trim().length > 0 ? value : undefined;
}

function envInt(name: string): number | undefined {
    const value = envString(name);
    if (!value) {
        return undefined;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be an integer`);
    }
    return parsed;
}

function envBool(name: string): boolean | undefined {
    const value = envString(name);
    if (!value) {
        return undefined;
    }
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function envSandboxMode(name: string): CodexAdapterSandboxMode | undefined {
    return envString(name) as CodexAdapterSandboxMode | undefined;
}

function envProtocolVersion(name: string): 2 | 3 | undefined {
    const value = envInt(name);
    if (value === undefined) {
        return undefined;
    }
    if (value !== 2 && value !== 3) {
        throw new Error(`${name} must be 2 or 3`);
    }
    return value;
}

function buildOptions(): CodexAdapterOptions {
    return {
        codexBin: envString("CODEX_ADAPTER_CODEX_BIN"),
        codexHome: envString("CODEX_ADAPTER_CODEX_HOME"),
        isolateCodexHome: envBool("CODEX_ADAPTER_ISOLATE_CODEX_HOME"),
        host: envString("CODEX_ADAPTER_HOST"),
        port: envInt("CODEX_ADAPTER_PORT"),
        protocolVersion: envProtocolVersion("CODEX_ADAPTER_PROTOCOL_VERSION"),
        model: envString("CODEX_ADAPTER_MODEL"),
        approvalPolicy: envString("CODEX_ADAPTER_APPROVAL_POLICY"),
        approvalsReviewer: envString("CODEX_ADAPTER_APPROVALS_REVIEWER"),
        sandboxMode: envSandboxMode("CODEX_ADAPTER_SANDBOX_MODE"),
        networkAccess: envBool("CODEX_ADAPTER_NETWORK_ACCESS"),
        requestTimeoutMs: envInt("CODEX_ADAPTER_REQUEST_TIMEOUT_MS"),
        clientInfo: {
            name: envString("CODEX_ADAPTER_CLIENT_NAME"),
            title: envString("CODEX_ADAPTER_CLIENT_TITLE"),
            version: envString("CODEX_ADAPTER_CLIENT_VERSION"),
        },
    };
}

function writeSummaryIfRequested(server: CodexCopilotAdapterServer): void {
    const summaryPath = envString("CODEX_ADAPTER_SUMMARY_PATH");
    if (!summaryPath) {
        return;
    }
    writeFileSync(summaryPath, `${JSON.stringify(server.summary(), null, 2)}\n`);
}

const server = new CodexCopilotAdapterServer(buildOptions());

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    try {
        writeSummaryIfRequested(server);
        await server.stop();
        process.stderr.write(`[codex-adapter] stopped signal=${signal}\n`);
        process.exit(0);
    } catch (error) {
        process.stderr.write(
            `[codex-adapter] stop failed signal=${signal} error=${
                error instanceof Error ? error.stack : String(error)
            }\n`
        );
        process.exit(1);
    }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function main(): Promise<void> {
    try {
        const started = await server.start();
        process.stdout.write(
            `${JSON.stringify({
                event: "codex-adapter.listening",
                cliUrl: started.cliUrl,
                port: started.port,
                targetProfiles: server.capabilities().targetProfiles,
            })}\n`
        );
    } catch (error) {
        process.stderr.write(
            `[codex-adapter] start failed error=${
                error instanceof Error ? error.stack : String(error)
            }\n`
        );
        process.exit(1);
    }
}

void main();
