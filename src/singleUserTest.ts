import 'dotenv/config'
import { AtpAgent } from "@atproto/api";
import { checkUserAvatar } from './checkUser';

async function main() {

    console.log("Starting user avatar check...");
    const host = process.env.ACCOUNT_HOST || 'https://bsky.social';
    const agent = new AtpAgent({ service: host });

    await agent.login({
        identifier: process.env.ACCOUNT_USERNAME || '',
        password: process.env.ACCOUNT_PASSWORD || '',
    });

    // get input from console
    let did = process.argv[2];
    if (!did) {
        // prompt user for input if not provided as argument
        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        did = await new Promise((resolve) => {
            readline.question('Enter the DID of the user to check: ', (input: string) => {
                readline.close();
                resolve(input);
            });
        });
    }


    const start = performance.now();
    const hasNoAvatar = await checkUserAvatar({ agent, did });
    const elapsed = (performance.now() - start).toFixed(2);

    console.log(`(took ${elapsed}ms)`);
}

main().catch(console.error);