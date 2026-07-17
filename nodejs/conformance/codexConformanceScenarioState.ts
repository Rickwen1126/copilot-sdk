export type ObservedEvent = {
    type: string;
    data?: unknown;
};

export type ScenarioEventKey =
    | "client1"
    | "client2"
    | "approvalProbe"
    | "denialProbe"
    | "fileApprovalProbe"
    | "fileDenialProbe"
    | "toolProbe"
    | "toolFailureProbe";

export type ScenarioEventBuckets = Record<ScenarioEventKey, ObservedEvent[]>;

export type ObservedEventTypeSummary = Record<ScenarioEventKey, string[]> & {
    history?: string[];
};

export function createScenarioEventBuckets(): ScenarioEventBuckets {
    return {
        client1: [],
        client2: [],
        approvalProbe: [],
        denialProbe: [],
        fileApprovalProbe: [],
        fileDenialProbe: [],
        toolProbe: [],
        toolFailureProbe: [],
    };
}

export function recordScenarioEvent(
    buckets: ScenarioEventBuckets,
    key: ScenarioEventKey
): (event: ObservedEvent) => void {
    return (event) => buckets[key].push({ type: event.type, data: event.data });
}

export function summarizeScenarioEventTypes(
    buckets: ScenarioEventBuckets,
    history: ObservedEvent[] = []
): ObservedEventTypeSummary {
    return {
        client1: eventTypes(buckets.client1),
        client2: eventTypes(buckets.client2),
        approvalProbe: eventTypes(buckets.approvalProbe),
        denialProbe: eventTypes(buckets.denialProbe),
        fileApprovalProbe: eventTypes(buckets.fileApprovalProbe),
        fileDenialProbe: eventTypes(buckets.fileDenialProbe),
        toolProbe: eventTypes(buckets.toolProbe),
        toolFailureProbe: eventTypes(buckets.toolFailureProbe),
        history: eventTypes(history),
    };
}

function eventTypes(events: ObservedEvent[]): string[] {
    return events.map((event) => event.type);
}
