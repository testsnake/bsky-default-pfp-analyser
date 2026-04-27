import { AtpAgent } from "@atproto/api";
import { CheckResult } from "./checkUser";
import { create } from "domain";

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
            const res = await this.agent.com.atproto.repo.createRecord({
                repo: this.agent.session.did,
                collection: "app.bsky.graph.listitem",
                record: {
                    $type: "app.bsky.graph.listitem",
                    subject: did,
                    list: this.listId,
                    createdAt: new Date().toISOString(),
                },
            });
            const rkey = res.data.uri.split("/").pop();
            console.log(`[ListManager] Added ${did} to list`);
            return rkey;
        } catch (err) {
            console.error(`[ListManager] Failed to add ${did} to list:`, err);
        }
    }

    // WHY THE FUCK IS THIS SO COMPLICATED
    // may store rkey in future, but depends on how much load this adds
    private async removeFromList(did: string, rkey: string | undefined): Promise<void> {
        try {
            if (!this.agent.session?.did) {
                throw new Error("Agent is not authenticated");
            }

            if (rkey) {
                await this.agent.com.atproto.repo.deleteRecord({
                    repo: this.agent.session.did,
                    collection: "app.bsky.graph.listitem",
                    rkey: rkey,
                });
                console.log(`[ListManager] Removed ${did} from list`);
                return;
            }

            let cursor: string | undefined;
            let targetRkey: string | undefined;

            do {
                const response = await this.agent.app.bsky.graph.getList({
                    list: this.listId,
                    cursor: cursor,
                    limit: 100,
                });

                const foundItem = response.data.items.find((item) => item.subject.did === did);

                if (foundItem) {
                    targetRkey = foundItem.uri.split("/").pop();
                    break;
                }

                cursor = response.data.cursor;
            } while (cursor);

            if (!targetRkey) {
                console.log(`[ListManager] User ${did} is not in the list. Nothing to remove.`);
                return;
            }

            await this.agent.com.atproto.repo.deleteRecord({
                repo: this.agent.session.did,
                collection: "app.bsky.graph.listitem",
                rkey: targetRkey,
            });

            console.log(`[ListManager] Removed ${did} from list`);
        } catch (err) {
            console.error(`[ListManager] Failed to remove ${did} from list:`, err);
        }
    }
}
