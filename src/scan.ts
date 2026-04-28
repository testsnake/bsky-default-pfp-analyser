import "dotenv/config";
import { AtpAgent } from "@atproto/api";
import { CheckResult, checkUserAvatar } from "./checkUser";
import { AvatarDb, db as defaultDb } from "./db";
import { ListManager } from "./listManager";
import fs from "fs";
import path from "path";

/** The relay that knows about every repo on the network. */
const RELAY_URL = "https://bsky.network";

/** How many repos to request per page (API max is 1 000). */
const PAGE_SIZE = 100;

/** Path where the cursor is persisted so a crashed scan can resume. */
const CURSOR_FILE = process.env.CURSOR_FILE ?? path.join(process.cwd(), ".scan-cursor");

export interface ScanOptions {
    relayUrl?: string;
    concurrency?: number;
    skipExisting?: boolean;
    resumable?: boolean;
    listManager?: ListManager;
    db?: AvatarDb;
    /** Progress callback – fired after every resolved check. */
    onResult?: (did: string, result: CheckResult, stats: ScanStats) => void;
    onError?: (did: string, err: Error) => void;
}

export interface ScanStats {
    seen: number;
    skipped: number;
    checked: number;
    defaultAvatar: number;
    noAvatar: number;
    nonDefault: number;
    errors: number;
}

export class Scanner {
    private readonly agent: AtpAgent;
    private readonly relayUrl: string;
    private readonly concurrency: number;
    private readonly skipExisting: boolean;
    private readonly resumable: boolean;
    private readonly listManager: ListManager | undefined;
    private readonly db: AvatarDb;
    private readonly onResult: NonNullable<ScanOptions["onResult"]>;
    private readonly onError: NonNullable<ScanOptions["onError"]>;

    private stopped = false;
    private stats: ScanStats = {
        seen: 0,
        skipped: 0,
        checked: 0,
        defaultAvatar: 0,
        noAvatar: 0,
        nonDefault: 0,
        errors: 0,
    };

    private inFlight = 0;
    private waiters: Array<() => void> = [];

    constructor(agent: AtpAgent, options: ScanOptions = {}) {
        this.agent = agent;
        this.relayUrl = options.relayUrl ?? RELAY_URL;
        this.concurrency = options.concurrency ?? 10;
        this.skipExisting = options.skipExisting ?? true;
        this.resumable = options.resumable ?? true;
        this.listManager = options.listManager;
        this.db = options.db ?? defaultDb;
        this.onResult = options.onResult ?? (() => {});
        this.onError = options.onError ?? ((did, err) => console.error(`[Scanner] error for ${did}:`, err));
    }

    /** Stop after the current page finishes. */
    stop(): void {
        this.stopped = true;
        console.log("[Scanner] stop requested – will halt after current page");
    }

    getStats(): Readonly<ScanStats> {
        return { ...this.stats };
    }

    async run(): Promise<ScanStats> {
        const relayAgent = new AtpAgent({ service: this.relayUrl });
        let cursor: string | undefined = this.loadCursor();

        if (cursor) {
            console.log(`[Scanner] resuming from cursor ${cursor}`);
        } else {
            console.log("[Scanner] starting fresh scan");
        }

        while (!this.stopped) {
            // wait 10 seconds to avoid rate limiting too hard
            //console.log("[Scanner] waiting 10 seconds before fetching next page…");
            await sleep(10_000);
            // Fetch one page of repos from the relay
            let repos: Array<{ did: string }>;
            let nextCursor: string | undefined;

            try {
                const res = await relayAgent.com.atproto.sync.listRepos({
                    limit: PAGE_SIZE,
                    cursor,
                });

                repos = res.data.repos as Array<{ did: string }>;
                nextCursor = res.data.cursor;
            } catch (err) {
                console.error("[Scanner] failed to fetch repo page:", err);
                // Brief back-off before retrying the same cursor
                await sleep(5_000);
                continue;
            }

            if (repos.length === 0) {
                console.log("[Scanner] reached end of repo list");
                break;
            }

            console.log(
                `[Scanner] page: ${repos.length} repos | ` +
                    `seen=${this.stats.seen} checked=${this.stats.checked} ` +
                    `default=${this.stats.defaultAvatar} errors=${this.stats.errors}`,
            );

            // Dispatch each DID for processing, respecting the concurrency cap
            for (const repo of repos) {
                if (this.stopped) break;
                await this.acquireSlot(); // blocks until a slot is free
                this.process(repo.did); // does NOT await – fires and forgets into the pool
            }

            // Persist cursor and advance
            if (nextCursor) {
                cursor = nextCursor;
                if (this.resumable) this.saveCursor(cursor);
            } else {
                // Last page – clear the cursor so the next full run starts fresh
                if (this.resumable) this.clearCursor();
                break;
            }
        }

        // Wait for all in-flight checks to finish before returning
        await this.drain();

        console.log("[Scanner] finished", this.stats);
        return this.stats;
    }

    // -------------------------------------------------------------------------
    // Per-user processing (mirrors JetstreamReader.process)
    // -------------------------------------------------------------------------

    private process(did: string): void {
        this.stats.seen++;

        const existing = this.db.get(did);

        // Skip users we've already classified as non-default – they can't revert
        if (this.skipExisting && existing && existing.checkResult !== CheckResult.defaultAvatar) {
            this.stats.skipped++;
            this.releaseSlot();
            return;
        }

        // Kick off the async work
        (async () => {
            try {
                const result = await checkUserAvatar({ agent: this.agent, did });

                const rkey = await this.listManager?.listEvent({
                    did,
                    defaultAvatarStatus: result.result,
                    prevStatus: existing?.checkResult ?? null,
                });

                this.db.upsert({
                    did,
                    avatarSize: result.size, // size not available from repo-list scan
                    checkResult: result.result,
                    rkey: rkey ?? existing?.rkey ?? null, // preserve existing rkey if present
                });

                // Update stats
                this.stats.checked++;
                if (result.result === CheckResult.defaultAvatar) this.stats.defaultAvatar++;
                else if (result.result === CheckResult.noAvatar) this.stats.noAvatar++;
                else this.stats.nonDefault++;

                this.onResult(did, result.result, this.getStats());
            } catch (err) {
                this.stats.errors++;
                this.onError(did, err instanceof Error ? err : new Error(`Unknown error: ${err}`));
            } finally {
                this.releaseSlot();
            }
        })();
    }

    private acquireSlot(): Promise<void> {
        if (this.inFlight < this.concurrency) {
            this.inFlight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.waiters.push(() => {
                resolve();
            });
        });
    }

    private releaseSlot(): void {
        const next = this.waiters.shift();
        if (next) {
            next();
        } else {
            this.inFlight--;
        }
    }

    private drain(): Promise<void> {
        if (this.inFlight === 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (this.inFlight === 0) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
    }

    private loadCursor(): string | undefined {
        if (!this.resumable) return undefined;
        try {
            return fs.readFileSync(CURSOR_FILE, "utf8").trim() || undefined;
        } catch {
            return undefined;
        }
    }

    private saveCursor(cursor: string): void {
        try {
            fs.writeFileSync(CURSOR_FILE, cursor, "utf8");
        } catch (err) {
            console.warn("[Scanner] failed to save cursor:", err);
        }
    }

    private clearCursor(): void {
        try {
            fs.unlinkSync(CURSOR_FILE);
        } catch {}
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
    const host = process.env.ACCOUNT_HOST ?? "https://bsky.social";
    const agent = new AtpAgent({ service: host });

    await agent.login({
        identifier: process.env.ACCOUNT_USERNAME ?? "",
        password: process.env.ACCOUNT_PASSWORD ?? "",
    });

    console.log("[Scanner] logged in");

    let scanner: Scanner;

    const concurrency = Number(process.env.SCAN_CONCURRENCY ?? 10);

    scanner = new Scanner(agent, {
        concurrency,
        skipExisting: true,
        resumable: true,
        onResult: (did, result, stats) => {
            if (stats.checked % 500 === 0) {
                console.log(
                    `[Scanner] progress | checked=${stats.checked} ` +
                        `default=${stats.defaultAvatar} noAvatar=${stats.noAvatar} ` +
                        `nonDefault=${stats.nonDefault} errors=${stats.errors}`,
                );
            }
        },
        onError: (did, err) => {
            console.error(`[Scanner] ${did} →`, err.message);
        },
    });

    process.on("SIGINT", () => {
        console.log("\n[Scanner] SIGINT received – stopping after current page…");
        scanner.stop();
    });

    const stats = await scanner.run();

    console.log("[Scanner] done", stats);
    process.exit(0);
}

if (require.main === module) {
    main().catch((err) => {
        console.error("[Scanner] fatal:", err);
        process.exit(1);
    });
}
