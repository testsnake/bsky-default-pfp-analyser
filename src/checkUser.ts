import { AtpAgent, AtpSessionEvent, AtpSessionData, AppBskyActorDefs, AppBskyActorProfile} from "@atproto/api";
import sharp from "sharp";
import avatarModel from "./avatarModel";


const MAX_AVATAR_SIZE = 163840 // KiB
const ALLOWED_RESOLUTIONS = [
    225,
    750,
    1500,
    2250
] // resolutions seen of default pfps
const ALLOWED_MIME_TYPES = [
    'image/jpeg',
    'image/png'
] // mime types seen of default pfps

// pixels are relative to the 750x750 resolution version images, and are scaled accordingly
const BACKGROUND_PIXEL_LOCATIONS = [
    [
        [10,10], // top left
        [10, 375], // middle left
        [10, 740], // bottom left
        [375, 10], // top middle
        [375, 740], // bottom middle
        [740, 10], // top right
        [740, 375], // middle right
        [740, 740] // bottom right
    ], // outside edges
]


interface userSearchParam {
    agent: AtpAgent,
    did: string
} 



async function checkUserHasNoAvatar(param: userSearchParam): Promise<boolean> {
    const user = await getProfileRecord(param);

    // user has no avatar set
    if (!user.avatar) {
        console.log(`User ${param.did} has no avatar set`);
        return true;
    }

    // avatar is larger than largest known default avatar
    if (user.avatar.size > MAX_AVATAR_SIZE) {
        console.log(`User ${param.did} has avatar larger than max default avatar size`);
        return false;
    }

    // avatar has a mime type that is not seen in default pfps
    if (!ALLOWED_MIME_TYPES.includes(user.avatar.mimeType)) {
        console.log(`User ${param.did} has avatar with mime type ${user.avatar.mimeType} which is not an allowed mime type`);
        return false;
    }

    // avatar cannot be denoted from checks
    // download avatar for further checks
    const avatarBuffer = await getAvatar(param, user);

    // check avatar resolution is not seen in default pfps
    const metadata = await sharp(avatarBuffer).metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error(`Failed to get avatar metadata for user ${param.did}`);
    }
    
    if (!ALLOWED_RESOLUTIONS.includes(metadata.width) || !ALLOWED_RESOLUTIONS.includes(metadata.height)) {
        return false;
    }

    const avatarCheck = await avatarModel({
        imageBuffer: avatarBuffer,
        resolution: metadata.width,
        iconColor: [255,255,255]
    });
    if (!avatarCheck) {
        console.log(`User ${param.did} has avatar that failed the avatar model check`);
        return false;
    }
    
    console.log(`User ${param.did} has a default avatar`);
    return true;

    
}

async function getPdsFromDid(did: string): Promise<string> {
    const didDoc = await fetch(`https://plc.directory/${did}`).then(r => r.json());
    const pdsService = didDoc.service?.find((s: any) => s.id === '#atproto_pds');
    if (!pdsService) throw new Error(`No PDS found for DID: ${did}`);
    return pdsService.serviceEndpoint;
}

async function getAvatar(param: userSearchParam, record: AppBskyActorProfile.Record): Promise<Buffer> {
    console.log(`Downloading avatar for user ${param.did} from blob ref ${record.avatar?.ref.toString()}`);

    const pdsUrl = await getPdsFromDid(param.did);
    const pdsAgent = new AtpAgent({ service: pdsUrl });

    const avatarBlob = await pdsAgent.com.atproto.sync.getBlob({
        did: param.did,
        cid: record.avatar?.ref.toString() || '',
    });

    if (!avatarBlob.success) {
        throw new Error(`Failed to download avatar blob for user ${param.did}`);
    }

    return Buffer.from(avatarBlob.data);
}
    

async function getProfileRecord(param: userSearchParam): Promise<AppBskyActorProfile.Record> {
  const { data } = await param.agent.com.atproto.repo.getRecord({
    repo: param.did,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
  })

  return data.value as AppBskyActorProfile.Record
}

export default checkUserHasNoAvatar;