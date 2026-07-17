import { type NormalizedLedgerEntry } from "./codexConformanceLedger.js";

export type ConformanceStatus = "pass" | "fail" | "not-run";

export type ConformanceProfile = "SDK Core Profile" | "Coding Agent Profile";

export type ConformanceCheck = {
    capability: string;
    profile: ConformanceProfile;
    status: ConformanceStatus;
    backendStatus: {
        copilotCli: ConformanceStatus;
        codexAdapter: ConformanceStatus;
    };
    traceParity: ConformanceStatus;
    dataAssertion: ConformanceStatus;
    intentAssertion: ConformanceStatus;
    evidence: string[];
    missing: string[];
};

export type ConformanceReport = {
    runId: string;
    generatedAt: string;
    targetProfiles: string[];
    verdict: ConformanceStatus;
    checks: ConformanceCheck[];
    ledgerCounts: {
        copilotCli: number;
        codexAdapter: number;
    };
    ledgers: {
        copilotCli: NormalizedLedgerEntry[];
        codexAdapter: NormalizedLedgerEntry[];
    };
    unsupportedProfiles: string[];
};

export type ConformanceStatusTriplet = {
    trace: ConformanceStatus;
    data: ConformanceStatus;
    intent: ConformanceStatus;
};

export function statusFromBooleans(...checks: boolean[]): ConformanceStatus {
    return checks.every(Boolean) ? "pass" : "fail";
}

export function combineStatuses(...statuses: ConformanceStatus[]): ConformanceStatus {
    if (statuses.includes("fail")) {
        return "fail";
    }
    if (statuses.includes("not-run")) {
        return "not-run";
    }
    return "pass";
}

export function makeCheck(input: Omit<ConformanceCheck, "status">): ConformanceCheck {
    return {
        ...input,
        status: combineStatuses(
            input.backendStatus.copilotCli,
            input.backendStatus.codexAdapter,
            input.traceParity,
            input.dataAssertion,
            input.intentAssertion
        ),
    };
}

export function missingProbeStatus(input: {
    configured: boolean;
    backendRecorded: boolean;
}): ConformanceStatus {
    if (!input.configured) {
        return "not-run";
    }
    return input.backendRecorded ? "fail" : "not-run";
}

export function statusFromOptionalProbe(input: {
    probePresent: boolean;
    passed: boolean;
    configured: boolean;
    backendRecorded: boolean;
}): ConformanceStatus {
    return input.probePresent
        ? statusFromBooleans(input.passed)
        : missingProbeStatus({
              configured: input.configured,
              backendRecorded: input.backendRecorded,
          });
}

export function combineStatusTriplet(input: ConformanceStatusTriplet): ConformanceStatus {
    return combineStatuses(input.trace, input.data, input.intent);
}

export function statusTripletFromOptionalProbe(input: {
    probePresent: boolean;
    configured: boolean;
    backendRecorded: boolean;
    tracePassed: boolean;
    dataPassed: boolean;
    intentPassed: boolean;
}): ConformanceStatusTriplet {
    return {
        trace: statusFromOptionalProbe({
            probePresent: input.probePresent,
            passed: input.tracePassed,
            configured: input.configured,
            backendRecorded: input.backendRecorded,
        }),
        data: statusFromOptionalProbe({
            probePresent: input.probePresent,
            passed: input.dataPassed,
            configured: input.configured,
            backendRecorded: input.backendRecorded,
        }),
        intent: statusFromOptionalProbe({
            probePresent: input.probePresent,
            passed: input.intentPassed,
            configured: input.configured,
            backendRecorded: input.backendRecorded,
        }),
    };
}

export function buildConformanceReportArtifact(input: {
    runId: string;
    generatedAt: string;
    checks: ConformanceCheck[];
    copilotLedger: NormalizedLedgerEntry[];
    adapterLedger: NormalizedLedgerEntry[];
    targetProfiles?: string[];
    unsupportedProfiles?: string[];
}): ConformanceReport {
    return {
        runId: input.runId,
        generatedAt: input.generatedAt,
        targetProfiles: input.targetProfiles ?? ["SDK Core Profile", "Coding Agent Profile"],
        verdict: combineStatuses(...input.checks.map((check) => check.status)),
        checks: input.checks,
        ledgerCounts: {
            copilotCli: input.copilotLedger.length,
            codexAdapter: input.adapterLedger.length,
        },
        ledgers: {
            copilotCli: input.copilotLedger,
            codexAdapter: input.adapterLedger,
        },
        unsupportedProfiles: input.unsupportedProfiles ?? [
            "Interactive Profile",
            "Fidelity Profile",
            "Extended CLI Profile",
        ],
    };
}
