import { type TranscriptEntry } from "./codexConformanceLedger.js";

export type ProtocolRecorder = {
    summary(): {
        requestMethods: string[];
        notificationKinds: string[];
        transcripts: TranscriptEntry[];
    };
};

export type ProtocolRecorderClient = {
    connection?: {
        sendRequest: (method: string, ...args: unknown[]) => Promise<unknown>;
    };
    start?: () => Promise<void>;
    connectToServer?: () => Promise<void>;
    handleSessionEventNotification?: (notification: unknown) => unknown;
    handleSessionLifecycleNotification?: (notification: unknown) => unknown;
};

export function summarizeUnknownError(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
        };
    }

    return {
        name: "Error",
        message: typeof error === "string" ? error : JSON.stringify(error),
    };
}

export function attachClientProtocolRecorder(
    client: unknown,
    options: { now?: () => string } = {}
): ProtocolRecorder {
    const now = options.now ?? (() => new Date().toISOString());
    const recorderClient = client as ProtocolRecorderClient;
    const transcripts: TranscriptEntry[] = [];
    const connection = recorderClient.connection;
    if (!connection) {
        throw new Error("Client connection not available for protocol recording");
    }

    const originalSendRequest = connection.sendRequest.bind(connection);
    connection.sendRequest = async (method: string, ...args: unknown[]) => {
        const params = args[0];
        transcripts.push({
            at: now(),
            direction: "sdk->copilot.request",
            message: { method, params },
        });
        try {
            const result = await originalSendRequest(method, ...args);
            transcripts.push({
                at: now(),
                direction: "copilot->sdk.response",
                message: { method, result },
            });
            return result;
        } catch (error) {
            transcripts.push({
                at: now(),
                direction: "copilot->sdk.response",
                message: { method, error: summarizeUnknownError(error) },
            });
            throw error;
        }
    };

    patchNotificationHandler(recorderClient, transcripts, now, "handleSessionEventNotification");
    patchNotificationHandler(
        recorderClient,
        transcripts,
        now,
        "handleSessionLifecycleNotification"
    );

    return {
        summary() {
            return {
                requestMethods: transcripts
                    .filter((entry) => entry.direction === "sdk->copilot.request")
                    .map((entry) =>
                        isRecord(entry.message) && "method" in entry.message
                            ? String(entry.message.method)
                            : "unknown"
                    ),
                notificationKinds: transcripts
                    .filter((entry) => entry.direction.startsWith("copilot->sdk.notification"))
                    .map((entry) => entry.direction),
                transcripts,
            };
        },
    };
}

export async function startClientWithRecorder(
    client: unknown,
    options: { now?: () => string } = {}
): Promise<ProtocolRecorder> {
    const recorderClient = client as ProtocolRecorderClient;
    const originalConnectToServer = recorderClient.connectToServer;
    if (typeof originalConnectToServer !== "function") {
        throw new Error("CopilotClient.connectToServer is not available for recorder hook");
    }
    if (typeof recorderClient.start !== "function") {
        throw new Error("CopilotClient.start is not available for recorder hook");
    }

    let recorder: ProtocolRecorder | undefined;

    recorderClient.connectToServer = async () => {
        await originalConnectToServer.call(recorderClient);
        recorder = attachClientProtocolRecorder(recorderClient, options);
        recorderClient.connectToServer = originalConnectToServer;
    };

    try {
        await recorderClient.start();
    } catch (error) {
        recorderClient.connectToServer = originalConnectToServer;
        throw error;
    }

    if (!recorder) {
        recorder = attachClientProtocolRecorder(recorderClient, options);
    }

    return recorder;
}

function patchNotificationHandler(
    client: ProtocolRecorderClient,
    transcripts: TranscriptEntry[],
    now: () => string,
    name: "handleSessionEventNotification" | "handleSessionLifecycleNotification"
) {
    const current = client[name];
    if (typeof current !== "function") {
        return;
    }
    client[name] = (notification: unknown) => {
        transcripts.push({
            at: now(),
            direction:
                name === "handleSessionEventNotification"
                    ? "copilot->sdk.notification.session.event"
                    : "copilot->sdk.notification.session.lifecycle",
            message: notification,
        });
        return current.call(client, notification);
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object";
}
