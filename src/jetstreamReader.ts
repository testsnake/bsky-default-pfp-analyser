import { AppBskyActorProfile, AtpAgent } from "@atproto/api";
import { CheckResult, checkUserAvatar } from "./checkUser";
import { AvatarDb, db as defaultDb } from "./db";
import { ListManager } from "./listManager";
import WebSocket from "ws";

const PROFILE_COLLECTION = "app.bsky.actor.profile";

const DEFAULT_JETSTREAM_URL =
    "wss://jetstream2.us-west.bsky.network/subscribe" + `?wantedCollections=${PROFILE_COLLECTION}`;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface JetstreamCommitEvent {
    did: string;
    time_us: number; // microseconds since epoch
    kind: "commit";
    commit: {
        rev: string;
        operation: "create" | "update" | "delete";
        collection: string;
        rkey: string;
        cid?: string;
        record?: Record<string, unknown>;
    };
}

interface JetstreamEvent {
    did: string;
    time_us: number;
    kind: string;
    commit?: JetstreamCommitEvent["commit"];
}

/** Shape of the avatar blob field as it arrives in Jetstream commit records. */
interface AvatarBlobRecord {
    $type?: string;
    size?: number;
    mimeType?: string;
}

export interface JetstreamReaderOptions {
    jetstreamUrl?: string;
    concurrency?: number;
    listManager?: ListManager;
    db?: AvatarDb;
    /** Called once per resolved user check (useful for metrics / logging). */
    onResult?: (did: string, isDefaultOrNoAvatar: boolean) => void;
    /** Called on unrecoverable errors. */
    onError?: (err: Error) => void;
}

export class JetstreamReader {
    private readonly agent: AtpAgent;
    private readonly url: string;
    private readonly concurrency: number;
    private readonly listManager: ListManager | undefined;
    private readonly db: AvatarDb;
    private readonly onResult: NonNullable<JetstreamReaderOptions["onResult"]>;
    private readonly onError: NonNullable<JetstreamReaderOptions["onError"]>;

    private ws: WebSocket | null = null;
    private stopped = false;
    private reconnectAttempt = 0;

    private inFlight = 0;
    private queue: JetstreamCommitEvent[] = [];

    constructor(agent: AtpAgent, options: JetstreamReaderOptions = {}) {
        this.agent = agent;
        this.url = options.jetstreamUrl ?? DEFAULT_JETSTREAM_URL;
        this.concurrency = options.concurrency ?? 5;
        this.listManager = options.listManager;
        this.db = options.db ?? defaultDb;
        this.onResult = options.onResult ?? (() => {});
        this.onError = options.onError ?? ((e) => console.error("[JetstreamReader]", e));
    }

    start(): void {
        if (this.ws) return; // already running
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        this.ws?.close();
        this.ws = null;
        console.log("[JetstreamReader] stopped");
    }

    private connect(): void {
        if (this.stopped) return;

        console.log(`[JetstreamReader] connecting to ${this.url}`);
        const ws = new WebSocket(this.url);
        this.ws = ws;

        ws.on("open", () => {
            console.log("[JetstreamReader] connected");
            this.reconnectAttempt = 0;
        });

        ws.on("message", (data) => {
            let parsed: JetstreamEvent;
            try {
                parsed = JSON.parse(data.toString()) as JetstreamEvent;
            } catch {
                return; // bad frame
            }
            this.handleEvent(parsed);
        });

        ws.on("close", (code, reason) => {
            console.warn(`[JetstreamReader] connection closed (code=${code}), reconnecting…`);
            this.scheduleReconnect();
        });

        ws.on("error", (error) => {
            console.error("[JetstreamReader] WebSocket error:", error);
        });
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
        this.reconnectAttempt++;
        console.log(`[JetstreamReader] reconnecting in ${delay}ms…`);
        setTimeout(() => this.connect(), delay);
    }

    private handleEvent(event: JetstreamEvent): void {
        if (
            event.kind !== "commit" ||
            !event.commit ||
            event.commit.collection !== PROFILE_COLLECTION ||
            event.commit.operation === "delete"
        ) {
            return;
        }

        const commitEvent = event as JetstreamCommitEvent;

        if (this.inFlight < this.concurrency) {
            this.process(commitEvent);
        } else {
            this.queue.push(commitEvent);
        }
    }

    private process(event: JetstreamCommitEvent): void {
        this.inFlight++;

        if (!event.commit.record || event.commit.record.$type !== "app.bsky.actor.profile") {
            console.warn(`[JetstreamReader] unexpected record type ${event.commit.record?.$type} for ${event.did}, skipping`);
            this.inFlight--;
            this.drainQueue();
            return;
        }

        const profileRecord = event.commit.record as AppBskyActorProfile.Record | undefined;

        const did = event.did;
        const avatarBlob = profileRecord?.avatar as AvatarBlobRecord | undefined;
        const incomingSize: number | undefined = avatarBlob?.size;


        const existing = this.db.get(did);

        let work: Promise<void>;

        if (existing) {
            if (existing.checkResult !== CheckResult.defaultAvatar) {
                //console.log(`[JetstreamReader] ${did} already marked non-default, skipping`);
                this.inFlight--;
                this.drainQueue();
                return;
            }

            if (incomingSize !== undefined && incomingSize === existing.avatarSize) {
                //console.log(`[JetstreamReader] ${did} avatar unchanged (size=${incomingSize}), skipping`);
                this.inFlight--;
                this.drainQueue();
                return;
            }

            // avatar size changed, not via onboarding
            // console.log(
            //     `[JetstreamReader] ${did} avatar size changed ` +
            //         `(was ${existing.avatarSize} → now ${incomingSize}), marking non-default`,
            // );

            work = (async () => {
                const rkey = await this.listManager?.listEvent({
                    did,
                    defaultAvatarStatus: CheckResult.nonDefaultViaLogic,
                    prevStatus: existing.checkResult,
                });

                this.db.upsert({
                    did,
                    avatarSize: null,
                    checkResult: CheckResult.nonDefaultViaLogic,
                    rkey: rkey ?? existing?.rkey ?? null,
                });
            })();
        } else {
            work = (async () => {
                const result = await checkUserAvatar({ agent: this.agent, did, user: profileRecord });

                const rkey = await this.listManager?.listEvent({
                    did,
                    defaultAvatarStatus: result.result,
                    prevStatus: null,
                });

                const sizeToStore = result.result === CheckResult.defaultAvatar ? (incomingSize ?? null) : null;

                this.db.upsert({ did, avatarSize: sizeToStore, checkResult: result.result, rkey: rkey ?? null });

                this.onResult(
                    did,
                    result.result === CheckResult.defaultAvatar || result.result === CheckResult.noAvatar,
                );
            })();
        }

        work.catch((err: unknown) => {
            this.onError(err instanceof Error ? err : new Error(`Unknown error for ${did}: ${err}`));
        }).finally(() => {
            this.inFlight--;
            this.drainQueue();
        });
    }

    private drainQueue(): void {
        while (this.queue.length > 0 && this.inFlight < this.concurrency) {
            const next = this.queue.shift()!;
            this.process(next);
        }
    }
}
