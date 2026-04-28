import { AtpAgent } from "@atproto/api";
import { CheckResult } from "./checkUser";

const TEST_MODE = process.env.TEST_MODE === "true";

interface ListManagerResult {
    did: string;
    defaultAvatarStatus: CheckResult;
    prevStatus: CheckResult | null;
    rkey?: string;
}

export class ListManager {
    private readonly agent: AtpAgent;
    private readonly listId: string;

    constructor(agent: AtpAgent, listId: string) {
        this.agent = agent;
        this.listId = listId;
    }

    async listEvent(param: ListManagerResult): Promise<void | string> {
        if (TEST_MODE) {
            console.log(`[ListManager] TEST MODE: would process event for ${param.did} with status ${param.defaultAvatarStatus}`);
            return;
        }
        const { did, defaultAvatarStatus, prevStatus } = param;

        // only add to list if user has default avatar, remove otherwise
        if (defaultAvatarStatus === CheckResult.defaultAvatar) {
            return this.addToList(did);
        } else if (prevStatus === CheckResult.defaultAvatar) {
            return this.removeFromList(did, param.rkey);
        }
    }

    private async addToList(did: string): Promise<void | string> {
        try {
            if (!this.agent.session?.did) {
                throw new Error("Agent is not authenticated");
            }
            
            const res = await this.executeWithRetry(
                () => this.agent.com.atproto.repo.createRecord({
                    repo: this.agent.session!.did, // Asserted non-null due to check above
                    collection: "app.bsky.graph.listitem",
                    record: {
                        $type: "app.bsky.graph.listitem",
                        subject: did,
                        list: this.listId,
                        createdAt: new Date().toISOString(),
                    },
                }),
                did,
                "addToList"
            );

            const rkey = res.data.uri.split("/").pop();
            //console.log(`[ListManager] Added ${did} to list`);
            return rkey;
        } catch (err) {
            console.error(`[ListManager] Failed to add ${did} to list:`, err);
        }
    }

    private async removeFromList(did: string, rkey: string | undefined): Promise<void> {
        try {
            if (!this.agent.session?.did) {
                throw new Error("Agent is not authenticated");
            }

            if (rkey) {
                await this.executeWithRetry(
                    () => this.agent.com.atproto.repo.deleteRecord({
                        repo: this.agent.session!.did,
                        collection: "app.bsky.graph.listitem",
                        rkey: rkey,
                    }),
                    did,
                    "removeFromList (fast path)"
                );
                //console.log(`[ListManager] Removed ${did} from list`);
                return;
            }

            let cursor: string | undefined;
            let targetRkey: string | undefined;

            do {
                const response = await this.executeWithRetry(
                    () => this.agent.app.bsky.graph.getList({
                        list: this.listId,
                        cursor: cursor,
                        limit: 100,
                    }),
                    did,
                    "getList"
                );

                const foundItem = response.data.items.find((item) => item.subject.did === did);

                if (foundItem) {
                    targetRkey = foundItem.uri.split("/").pop();
                    break;
                }

                cursor = response.data.cursor;
            } while (cursor);

            if (!targetRkey) {
                //console.log(`[ListManager] User ${did} is not in the list. Nothing to remove.`);
                return;
            }

            await this.executeWithRetry(
                () => this.agent.com.atproto.repo.deleteRecord({
                    repo: this.agent.session!.did,
                    collection: "app.bsky.graph.listitem",
                    rkey: targetRkey,
                }),
                did,
                "removeFromList (slow path)"
            );

            //console.log(`[ListManager] Removed ${did} from list`);
        } catch (err) {
            console.error(`[ListManager] Failed to remove ${did} from list:`, err);
        }
    }

    private async executeWithRetry<T>(operation: () => Promise<T>, did: string, context: string): Promise<T> {
        const MAX_RETRIES = 5;
        const BASE_DELAY_MS = 10_000;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await operation();
            } catch (err: any) {
                if (err?.status === 429) {
                    if (attempt === MAX_RETRIES) {
                        console.error(`[RateLimit] Exhausted retries for ${context} on ${did}`);
                        throw err;
                    }

                    const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                    const resetHeader = err.headers?.['ratelimit-reset'];
                    const timeToWait = resetHeader 
                        ? Math.max(waitMs, (parseInt(resetHeader) * 1000) - Date.now() + 1000) 
                        : waitMs;

                    console.warn(`[RateLimit] Hit 429 in ${context} for ${did}. Waiting ${Math.round(timeToWait / 1000)}s before retry ${attempt}...`);
                    
                    await new Promise(resolve => setTimeout(resolve, timeToWait));
                    continue;
                }
                
                throw err;
            }
        }
        
        throw new Error("Unreachable");
    }
}