import "dotenv/config";
import { AtpAgent } from "@atproto/api";
import { ListManager } from "./listManager";
import { Scanner } from "./scan";
import { JetstreamReader } from "./jetstreamReader";

async function main(runScan: boolean): Promise<void> {
    const agent = await createAgent();
    const listManager = await createListManager();

    
    const reader = new JetstreamReader(agent, {
        listManager: listManager ?? undefined,
    });
    reader.start();
    if (runScan) {
        const scanner = new Scanner(agent, {
            listManager: listManager ?? undefined,
        });
        await scanner.run();
    }
}

async function createListManager(): Promise<ListManager | null> {
    console.log("Initializing list manager...");
    const host = process.env.ACCOUNT_HOST ?? "https://bsky.social";
    const listAgent = new AtpAgent({ service: host });
    await listAgent.login({
        identifier: process.env.ACCOUNT_LIST_MANAGER_USERNAME ?? "",
        password: process.env.ACCOUNT_LIST_MANAGER_PASSWORD ?? "",
    });

    const listId = process.env.LIST_ID ?? "";
    if (!listId) {
        console.warn("LIST_ID not set, list manager will be disabled");
        return null;
    }

    return new ListManager(listAgent, listId);
}

async function createAgent(): Promise<AtpAgent> {
    console.log("Logging in to agent...");
    const host = process.env.ACCOUNT_HOST ?? "https://bsky.social";
    const agent = new AtpAgent({ service: host });

    await agent.login({
        identifier: process.env.ACCOUNT_USERNAME ?? "",
        password: process.env.ACCOUNT_PASSWORD ?? "",
    });

    return agent;
}

const shouldRunScan = process.argv.includes("--scan");

main(shouldRunScan).catch((error) => {
    console.error("Fatal error during execution:", error);
    process.exit(1);
});
