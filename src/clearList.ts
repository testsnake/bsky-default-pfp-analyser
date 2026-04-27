import 'dotenv/config';
import { AtpAgent } from "@atproto/api";

async function main() {
    console.log("Starting list clearing process...");
    
    const host = process.env.ACCOUNT_HOST ?? "https://bsky.social";
    const agent = new AtpAgent({ service: host });

    await agent.login({
        identifier: process.env.ACCOUNT_LIST_MANAGER_USERNAME ?? process.env.ACCOUNT_USERNAME ?? "",
        password: process.env.ACCOUNT_LIST_MANAGER_PASSWORD ?? process.env.ACCOUNT_PASSWORD ?? "",
    });

    if (!agent.session?.did) {
        throw new Error("Agent failed to authenticate.");
    }

    const listId = process.env.LIST_ID ?? "";
    if (!listId) {
        throw new Error("LIST_ID not set in .env file");
    }

    const listUri = listId.startsWith("at://") 
        ? listId 
        : `at://${agent.session.did}/app.bsky.graph.list/${listId}`;

    let cursor: string | undefined;
    let deletedCount = 0;

    console.log(`Fetching items for list: ${listUri}`);

    do {
        const response = await agent.app.bsky.graph.getList({
            list: listUri,
            cursor: cursor,
            limit: 100, // Fetch max allowed per page
        });

        const items = response.data.items;
        
        if (items.length === 0) {
            break;
        }

        console.log(`Found ${items.length} items in this batch. Deleting...`);

        for (const item of items) {
            const rkey = item.uri.split("/").pop();
            
            if (!rkey) {
                console.warn(`Could not parse rkey for ${item.subject.did}, skipping.`);
                continue;
            }

            try {
                await agent.com.atproto.repo.deleteRecord({
                    repo: agent.session.did,
                    collection: "app.bsky.graph.listitem",
                    rkey: rkey,
                });
                deletedCount++;
                
                if (deletedCount % 100 === 0) {
                    console.log(`...deleted ${deletedCount} records so far`);
                }
            } catch (err) {
                console.error(`Failed to delete item ${item.subject.did}:`, err);
            }
        }

        cursor = response.data.cursor;
    } while (cursor);

    console.log(`Finished clearing list! Total records deleted: ${deletedCount}`);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});