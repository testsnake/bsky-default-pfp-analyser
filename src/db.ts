import Database from "better-sqlite3";
import { CheckResult } from "./checkUser";
import path from "path";

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "avatars.db");

export interface DbRecord {
    did: string;
    avatarSize: number | null;
    checkResult: CheckResult;
    rkey?: string | null;
}

export class AvatarDb {
    private readonly db: Database.Database;

    constructor(dbPath: string = DB_PATH) {
        this.db = new Database(dbPath);
        this.init();
    }

    private init(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS avatars (
        did          TEXT    PRIMARY KEY,
        avatar_size  INTEGER,             -- nullable; only set for defaultAvatar records
        check_result INTEGER NOT NULL,
        rkey         TEXT                 -- nullable; optional record key
      )
    `);
    }

    get(did: string): DbRecord | null {
        const row = this.db
            .prepare<
                [string],
                { did: string; avatar_size: number | null; check_result: number; rkey: string | null }
            >("SELECT did, avatar_size, check_result, rkey FROM avatars WHERE did = ?")
            .get(did);

        if (!row) return null;

        return {
            did: row.did,
            avatarSize: row.avatar_size,
            checkResult: row.check_result as CheckResult,
            rkey: row.rkey,
        };
    }

    upsert(record: DbRecord): void {
        this.db
            .prepare<{ did: string; avatarSize: number | null; checkResult: number; rkey: string | null }>(
                `INSERT INTO avatars (did, avatar_size, check_result, rkey)
         VALUES (@did, @avatarSize, @checkResult, @rkey)
         ON CONFLICT(did) DO UPDATE SET
           avatar_size  = excluded.avatar_size,
           check_result = excluded.check_result,
           rkey         = excluded.rkey`,
            )
            .run({
                did: record.did,
                avatarSize: record.avatarSize,
                checkResult: record.checkResult,
                rkey: record.rkey ?? null,
            });
    }

    close(): void {
        this.db.close();
    }
}

export const db = new AvatarDb();
