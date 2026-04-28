import "dotenv/config";
import { AtpAgent, AtpSessionEvent, AtpSessionData, AppBskyActorDefs, AppBskyActorProfile } from "@atproto/api";
import sharp from "sharp";
import avatarModel from "./avatarModel";
import path from "path";
import fs from "fs/promises";

const SAVE_AVATARS = process.env.SAVE_AVATARS === "true";
const SAVE_DIR = process.env.AVATAR_SAVE_DIR ?? path.join(process.cwd(), "avatars");
const SAVE_DIR_DEFAULT = path.join(SAVE_DIR, "default");
const SAVE_DIR_CUSTOM = path.join(SAVE_DIR, "custom");

async function saveAvatar(did: string, buffer: Buffer, isDefault: boolean): Promise<void> {
    const dir = isDefault ? SAVE_DIR_DEFAULT : SAVE_DIR_CUSTOM;
    await fs.mkdir(dir, { recursive: true });
    const safeDid = did.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = path.join(dir, `${safeDid}.jpg`);
    await fs.writeFile(filePath, buffer);
    console.log(`Saved avatar for ${did} to ${filePath}`);
}

const MAX_AVATAR_SIZE = 163840; // KiB
const ALLOWED_RESOLUTIONS = [225, 750, 1500, 2250]; // resolutions seen of default pfps
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png"]; // mime types seen of default pfps

interface userSearchParam {
    agent: AtpAgent;
    did: string;
    user?: AppBskyActorProfile.Record;
}

interface resultWithStats {
    did: string;
    result: CheckResult;
    size: number | null;
}

enum CheckResult {
    noAvatar = 0,
    defaultAvatar = 1,
    nonDefaultViaLogic = 2,
    nonDefaultViaAvatarModel = 3,
}

async function checkUserAvatar(param: userSearchParam): Promise<resultWithStats> {
    if (!param.user) {
        param.user = await getProfileRecord(param);
    }

    // user has no avatar set
    if (!param.user.avatar) {
        //console.log(`User ${param.did} has no avatar set`);
        return {
            did: param.did,
            result: CheckResult.noAvatar,
            size: null,
        };
    }

    // avatar is larger than largest known default avatar
    if (param.user.avatar.size > MAX_AVATAR_SIZE) {
        //console.log(`User ${param.did} has avatar larger than max default avatar size`);
        return {
            did: param.did,
            result: CheckResult.nonDefaultViaLogic,
            size: param.user.avatar.size,
        };
    }

    // avatar has a mime type that is not seen in default pfps
    if (!ALLOWED_MIME_TYPES.includes(param.user.avatar.mimeType)) {
        //console.log(
        //    `User ${param.did} has avatar with mime type ${param.user.avatar.mimeType} which is not an allowed mime type`,
        //);
        return {
            did: param.did,
            result: CheckResult.nonDefaultViaLogic,
            size: param.user.avatar.size,
        };
    }

    // avatar cannot be denoted from checks
    // download avatar for further checks
    const avatarBuffer = await getAvatar(param, param.user);

    // check avatar resolution is not seen in default pfps
    const metadata = await sharp(avatarBuffer).metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error(`Failed to get avatar metadata for user ${param.did}`);
    }

    if (!ALLOWED_RESOLUTIONS.includes(metadata.width) || !ALLOWED_RESOLUTIONS.includes(metadata.height)) {
        if (SAVE_AVATARS) await saveAvatar(param.did, avatarBuffer, false);
        return {
            did: param.did,
            result: CheckResult.nonDefaultViaLogic,
            size: param.user.avatar.size,
        };
    }

    const avatarCheck = await avatarModel({
        imageBuffer: avatarBuffer,
        resolution: metadata.width,
        iconColor: [255, 255, 255],
        did: param.did,
    });
    if (!avatarCheck) {
        //console.log(`User ${param.did} has avatar that failed the avatar model check`);
        if (SAVE_AVATARS) await saveAvatar(param.did, avatarBuffer, false);
        return {
            did: param.did,
            result: CheckResult.nonDefaultViaAvatarModel,
            size: param.user.avatar.size,
        };
    }

    //console.log(`User ${param.did} has a default avatar`);
    if (SAVE_AVATARS) await saveAvatar(param.did, avatarBuffer, true);
    return {
        did: param.did,
        result: CheckResult.defaultAvatar,
        size: param.user.avatar.size,
    };
}

async function getPdsFromDid(did: string): Promise<string> {
    const didDoc = await fetch(`https://plc.directory/${did}`).then((r) => r.json());
    const pdsService = didDoc.service?.find((s: any) => s.id === "#atproto_pds");
    if (!pdsService) throw new Error(`No PDS found for DID: ${did}`);
    return pdsService.serviceEndpoint;
}

async function getAvatar(param: userSearchParam, record: AppBskyActorProfile.Record): Promise<Buffer> {
    

    const pdsUrl = await getPdsFromDid(param.did);
    const pdsAgent = new AtpAgent({ service: pdsUrl });

    const itemcid = record.avatar?.ref.$link?.toString() ?? record.avatar?.ref.toString() ?? "";

    //console.log(`Downloading avatar for user ${param.did} from blob ref ${itemcid} at PDS ${pdsUrl}`);

    const avatarBlob = await pdsAgent.com.atproto.sync.getBlob({
        did: param.did,
        cid: itemcid,
    });

    if (!avatarBlob.success) {
        throw new Error(`Failed to download avatar blob for user ${param.did}`);
    }

    return Buffer.from(avatarBlob.data);
}

async function getProfileRecord(param: userSearchParam): Promise<AppBskyActorProfile.Record> {
    const MAX_RETRIES = 5;
    const BASE_DELAY_MS = 30_000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { data } = await param.agent.com.atproto.repo.getRecord({
                repo: param.did,
                collection: "app.bsky.actor.profile",
                rkey: "self",
            });

            return data.value as AppBskyActorProfile.Record;
        } catch (err: any) {
            // check if rate limited
            if (err?.status === 429) {
                if (attempt === MAX_RETRIES) {
                    console.error(`[RateLimit] Exhausted retries for ${param.did}`);
                    throw err;
                }

                const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);

                const resetHeader = err.headers?.["ratelimit-reset"];
                const timeToWait = resetHeader
                    ? Math.max(waitMs, parseInt(resetHeader) * 1000 - Date.now() + 1000)
                    : waitMs;

                console.warn(
                    `[RateLimit] Hit 429 for ${param.did}. Waiting ${Math.round(timeToWait / 1000)}s before retry ${attempt}...`,
                );

                await new Promise((resolve) => setTimeout(resolve, timeToWait));
                continue;
            } else if (err?.status === 400) {
                // caused by account not haveing app.bsky.actor.profile record, treat as no avatar
                return {} as AppBskyActorProfile.Record;
            } else if (err?.status === 1) {
                // network error, retry after delay
                if (attempt === MAX_RETRIES) {
                    console.error(`[NetworkError] Exhausted retries for ${param.did}`);
                    throw err;
                }

                console.warn(`[NetworkError] Failed to fetch profile for ${param.did}. Retrying in ${BASE_DELAY_MS / 1000}s...`);
                await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS));
                continue;
            }

            console.error(`Failed to fetch profile record for user ${param.did}`);
            throw err;
        }
    }

    throw new Error(`Unreachable code reached in getProfileRecord for ${param.did}`);
}

export { userSearchParam, CheckResult, checkUserAvatar, getAvatar, getProfileRecord };
