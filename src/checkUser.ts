import { AtpAgent, AtpSessionEvent, AtpSessionData, AppBskyActorDefs, AppBskyActorProfile} from "@atproto/api";
import sharp from "sharp";


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

interface userSearchParam {
    agent: AtpAgent,
    did: string
} 



async function checkUserHasNoAvatar(param: userSearchParam): Promise<boolean> {
    const user = await getProfileRecord(param);

    // user has no avatar set
    if (!user.avatar) {
        return false;
    }

    // avatar is larger than largest known default avatar
    if (user.avatar.size > MAX_AVATAR_SIZE) {
        return false;
    }

    // avatar has a mime type that is not seen in default pfps
    if (!ALLOWED_MIME_TYPES.includes(user.avatar.mimeType)) {
        return false;
    }

    // avatar cannot be denoted from checks
    // download avatar for further checks
    const avatarBlob = await param.agent.com.atproto.sync.getBlob({
        did: param.did,
        cid: user.avatar.ref.toString(),
    });
    
    if (!avatarBlob.success) {
        throw new Error(`Failed to download avatar blob for user ${param.did}`);
    }

    const avatarBuffer = Buffer.from(avatarBlob.data);

    // check avatar resolution is not seen in default pfps
    const metadata = await sharp(avatarBuffer).metadata();
    if (!metadata.width || !metadata.height) {
        throw new Error(`Failed to get avatar metadata for user ${param.did}`);
    }
    
    if (!ALLOWED_RESOLUTIONS.includes(metadata.width) || !ALLOWED_RESOLUTIONS.includes(metadata.height)) {
        return false;
    }



    
}

async function getAvatar()

async function getProfileRecord(param: userSearchParam): Promise<AppBskyActorProfile.Record> {
  const { data } = await param.agent.com.atproto.repo.getRecord({
    repo: param.did,
    collection: 'app.bsky.actor.profile',
    rkey: 'self',
  })

  return data.value as AppBskyActorProfile.Record
}