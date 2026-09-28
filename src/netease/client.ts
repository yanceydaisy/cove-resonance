import { createRequire } from "node:module";
import {
  asRecord,
  readNumber,
  readString,
  type JsonRecord,
  type PlayingState,
  type RawLyrics,
  type RealtimeCredentials,
  type SongDetails,
  type TogetherRoom,
} from "./types.js";

type NcmResponse = {
  status?: number;
  body?: unknown;
};

type NcmFunction = (params: Record<string, unknown>) => Promise<NcmResponse>;
type NcmSdk = Record<string, NcmFunction>;

export type AccountPlaylist = {
  id: string;
  name: string;
  trackCount: number;
  creatorId: string | null;
  owned: boolean;
  privacy: number | null;
};

export type PlayHistoryRecord = {
  song: SongDetails;
  playCount: number;
  score: number | null;
};

export type RecommendedSong = SongDetails & {
  reason: string | null;
};

export type AccountProfile = {
  id: string;
  nickname: string | null;
  avatarUrl: string | null;
  gender: number | null;
};

export type TogetherPlaylistState = {
  displayList: string[];
  randomList: string[];
  playMode: string | null;
  versions: Array<{ userId: string; version: number }>;
};

const require = createRequire(import.meta.url);
const sdk = require("NeteaseCloudMusicApi") as NcmSdk;

const REALTIME_TOKEN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
  + "AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Chrome/124.0.0.0 Safari/537.36";

const REALTIME_CLIENT_COOKIE_KEYS = new Set([
  "os",
  "osver",
  "appver",
  "channel",
  "versioncode",
  "buildver",
  "resolution",
  "requestid",
]);

function realtimeTokenCookie(cookie: string, now = Date.now()): string {
  const preserved = cookie
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const separator = part.indexOf("=");
      const key = (separator >= 0 ? part.slice(0, separator) : part).trim().toLowerCase();
      return !REALTIME_CLIENT_COOKIE_KEYS.has(key);
    });

  const requestId = `${now}_${String(Math.floor(Math.random() * 1000)).padStart(4, "0")}`;
  return [
    ...preserved,
    "osver=15.5",
    "os=osx",
    "appver=3.1.10.5100",
    "channel=netease",
    "versioncode=140",
    `buildver=${Math.floor(now / 1000)}`,
    "resolution=1920x1080",
    `requestId=${requestId}`,
  ].join("; ");
}

function readLyric(body: JsonRecord, field: string): string | null {
  return readString(asRecord(body[field]).lyric);
}

function parseSong(value: unknown): SongDetails | null {
  const song = asRecord(value);
  const id = readString(song.id);
  if (!id) return null;

  const rawArtists = Array.isArray(song.ar)
    ? song.ar
    : Array.isArray(song.artists)
      ? song.artists
      : [];
  const artist = rawArtists
    .map((item) => readString(asRecord(item).name))
    .filter((name): name is string => Boolean(name))
    .join(" / ");

  const coverUrl = readString(asRecord(song.al).picUrl)
    ?? readString(asRecord(song.album).picUrl);

  return {
    id,
    name: readString(song.name) ?? `歌曲 ${id}`,
    artist: artist || "未知歌手",
    durationMs: Math.max(0, readNumber(song.dt) ?? readNumber(song.duration) ?? 0),
    ...(coverUrl ? { coverUrl } : {}),
  };
}

export class NeteaseApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: number | null,
    message?: string,
  ) {
    super(message ?? `${operation} failed${code === null ? "" : ` (${code})`}`);
    this.name = "NeteaseApiError";
  }
}

export class NeteaseClient {
  constructor(private readonly cookie: string) {}

  private async call(operation: string, params: JsonRecord = {}): Promise<JsonRecord> {
    const fn = sdk[operation];
    if (typeof fn !== "function") {
      throw new NeteaseApiError(operation, null, `Unsupported NetEase operation: ${operation}`);
    }

    const response = await fn({ ...params, cookie: this.cookie });
    const body = asRecord(response?.body ?? response);
    const code = readNumber(body.code);
    if (code !== 200) {
      const message = readString(body.message) ?? readString(body.msg) ?? undefined;
      throw new NeteaseApiError(operation, code, message);
    }
    return body;
  }

  async getAccountProfile(): Promise<AccountProfile> {
    const body = await this.call("user_account");
    const account = asRecord(body.account);
    const profile = asRecord(body.profile);
    const id = readString(account.id) ?? readString(profile.userId);
    if (!id) throw new NeteaseApiError("user_account", 200, "Account id missing");
    return {
      id,
      nickname: readString(profile.nickname),
      avatarUrl: readString(profile.avatarUrl),
      gender: readNumber(profile.gender),
    };
  }

  async getAccountId(): Promise<string> {
    return (await this.getAccountProfile()).id;
  }

  async searchSongs(query: string, limit = 10): Promise<SongDetails[]> {
    const body = await this.call("search", {
      keywords: query,
      type: 1,
      limit,
      offset: 0,
    });
    const result = asRecord(body.result);
    const songs = Array.isArray(result.songs) ? result.songs : [];
    return songs
      .map(parseSong)
      .filter((song): song is SongDetails => Boolean(song))
      .slice(0, limit);
  }

  async listOwnPlaylists(limit = 50): Promise<AccountPlaylist[]> {
    const accountId = await this.getAccountId();
    const body = await this.call("user_playlist", {
      uid: accountId,
      limit,
      offset: 0,
    });
    const playlists = Array.isArray(body.playlist) ? body.playlist : [];
    return playlists.map((value) => {
      const playlist = asRecord(value);
      const creatorId = readString(asRecord(playlist.creator).userId);
      return {
        id: readString(playlist.id) ?? "",
        name: readString(playlist.name) ?? "未命名歌单",
        trackCount: Math.max(0, readNumber(playlist.trackCount) ?? 0),
        creatorId,
        owned: creatorId === accountId,
        privacy: readNumber(playlist.privacy),
      };
    }).filter((playlist) => Boolean(playlist.id));
  }

  async getPlaylistTracks(playlistId: string, limit = 50): Promise<SongDetails[]> {
    const body = await this.call("playlist_track_all", {
      id: playlistId,
      limit,
      offset: 0,
    });
    const songs = Array.isArray(body.songs)
      ? body.songs
      : Array.isArray(asRecord(body.playlist).tracks)
        ? asRecord(body.playlist).tracks as unknown[]
        : [];
    return songs
      .map(parseSong)
      .filter((song): song is SongDetails => Boolean(song))
      .slice(0, limit);
  }

  async createPlaylist(name: string, privacy = 0): Promise<{ id: string; name: string; privacy: number }> {
    const body = await this.call("playlist_create", {
      name,
      privacy,
      type: "NORMAL",
    });
    const playlist = asRecord(body.playlist);
    const id = readString(playlist.id) ?? readString(body.id);
    if (!id) throw new NeteaseApiError("playlist_create", 200, "Created playlist id missing");
    return {
      id,
      name: readString(playlist.name) ?? name,
      privacy: readNumber(playlist.privacy) ?? privacy,
    };
  }

  async updatePlaylistTracks(
    playlistId: string,
    songIds: string[],
    operation: "add" | "del",
  ): Promise<void> {
    await this.call("playlist_tracks", {
      op: operation,
      pid: playlistId,
      tracks: songIds.join(","),
    });
  }

  async likeSong(songId: string, like = true): Promise<void> {
    await this.call("like", { id: songId, like });
  }

  async getPlayHistory(limit = 30, allTime = false): Promise<PlayHistoryRecord[]> {
    const accountId = await this.getAccountId();
    const body = await this.call("user_record", {
      uid: accountId,
      type: allTime ? 0 : 1,
    });
    const records = allTime
      ? (Array.isArray(body.allData) ? body.allData : [])
      : (Array.isArray(body.weekData) ? body.weekData : []);

    return records.slice(0, limit).flatMap((value) => {
      const record = asRecord(value);
      const song = parseSong(record.song);
      if (!song) return [];
      return [{
        song,
        playCount: Math.max(0, readNumber(record.playCount) ?? 0),
        score: readNumber(record.score),
      }];
    });
  }

  async getDailyRecommendations(limit = 30): Promise<RecommendedSong[]> {
    const body = await this.call("recommend_songs");
    const data = asRecord(body.data);
    const songs = Array.isArray(data.dailySongs) ? data.dailySongs : [];
    return songs.slice(0, limit).flatMap((value) => {
      const raw = asRecord(value);
      const song = parseSong(raw);
      if (!song) return [];
      return [{ ...song, reason: readString(raw.reason) }];
    });
  }

  async getRoomStatus(): Promise<TogetherRoom> {
    const body = await this.call("listentogether_status");
    const data = asRecord(body.data);
    const roomInfo = asRecord(data.roomInfo ?? body.roomInfo);
    const inRoom = data.inRoom === true || body.inRoom === true;
    return {
      inRoom,
      roomId: readString(roomInfo.roomId) ?? readString(data.roomId),
      chatRoomId: readString(roomInfo.chatRoomId) ?? readString(data.chatRoomId),
    };
  }

  async getRecentContacts(): Promise<JsonRecord> {
    return this.call("msg_recentcontact");
  }

  async getPrivateHistory(uid: string): Promise<JsonRecord> {
    return this.call("msg_private_history", { uid, limit: 8 });
  }

  async acceptInvite(roomId: string, inviterId: string): Promise<TogetherRoom> {
    const body = await this.call("listentogether_accept", { roomId, inviterId });
    const data = asRecord(body.data);
    const roomInfo = asRecord(data.roomInfo);
    return {
      inRoom: true,
      roomId: readString(roomInfo.roomId) ?? roomId,
      chatRoomId: readString(roomInfo.chatRoomId) ?? null,
    };
  }

  async endRoom(roomId: string): Promise<void> {
    await this.call("listentogether_end", { roomId });
  }

  async getRealtimeCredentials(): Promise<RealtimeCredentials> {
    const operation = "middle_im_token_get";
    const url = new URL("https://interface3.music.163.com/api/middle/im/token/get");
    url.searchParams.set("bizName", "music_listenTogether");

    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: {
          cookie: realtimeTokenCookie(this.cookie),
          accept: "application/json",
          "accept-language": "zh-CN,zh;q=0.9",
          "user-agent": REALTIME_TOKEN_USER_AGENT,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      throw new NeteaseApiError(operation, null, message);
    }

    let body: JsonRecord;
    try {
      body = asRecord(await response.json());
    } catch {
      throw new NeteaseApiError(operation, response.status, "Invalid JSON response");
    }

    const code = readNumber(body.code) ?? response.status;
    if (!response.ok || code !== 200) {
      const message = readString(body.message) ?? readString(body.msg) ?? undefined;
      throw new NeteaseApiError(operation, code, message);
    }

    const data = asRecord(body.data);
    const accId = readString(data.accId);
    const token = readString(data.token);
    const addresses = Array.isArray(data.addr)
      ? data.addr.map(readString).filter((value): value is string => Boolean(value))
      : [];

    if (!accId || !token) {
      throw new NeteaseApiError(operation, 200, "Realtime credentials missing accId/token");
    }

    return { accId, token, addresses };
  }

  async getPlaying(roomId: string): Promise<PlayingState> {
    const body = await this.call("listentogether_sync_playlist_get", { roomId });
    const data = asRecord(body.data);
    const command = asRecord(data.playCommand);
    const rawStatus = readString(command.playStatus)?.toUpperCase();
    const serverSeq = readNumber(command.serverSeq);
    return {
      songId: readString(command.targetSongId),
      playStatus: rawStatus === "PLAY" || rawStatus === "PAUSE" ? rawStatus : "UNKNOWN",
      progress: Math.max(0, readNumber(command.progress) ?? 0),
      ...(serverSeq === null ? {} : { serverSeq }),
    };
  }

  async getTogetherPlaylist(roomId: string): Promise<TogetherPlaylistState> {
    const body = await this.call("listentogether_sync_playlist_get", { roomId });
    const playlist = asRecord(asRecord(body.data).playlist);
    const displayListRaw = asRecord(playlist.displayList).result;
    const randomListRaw = asRecord(playlist.randomList).result;
    const displayList = Array.isArray(displayListRaw)
      ? displayListRaw.map(readString).filter((value): value is string => Boolean(value))
      : [];
    const randomList = Array.isArray(randomListRaw)
      ? randomListRaw.map(readString).filter((value): value is string => Boolean(value))
      : [];
    const versionsRaw = Array.isArray(playlist.version) ? playlist.version : [];
    const versions = versionsRaw.flatMap((item) => {
      const raw = asRecord(item);
      const userId = readString(raw.userId);
      const version = readNumber(raw.version);
      return userId && version !== null ? [{ userId, version }] : [];
    });
    return {
      displayList,
      randomList,
      playMode: readString(playlist.playMode),
      versions,
    };
  }

  async replaceTogetherPlaylist(input: {
    roomId: string;
    userId: string;
    version: number;
    displayList: string[];
    randomList: string[];
  }): Promise<void> {
    await this.call("listentogether_sync_list_command", {
      roomId: input.roomId,
      commandType: "REPLACE",
      userId: input.userId,
      version: input.version,
      displayList: input.displayList.join(","),
      randomList: input.randomList.join(","),
    });
  }

  async reportPlaybackCommand(input: {
    roomId: string;
    commandType: "PLAY" | "PAUSE" | "GOTO";
    progress: number;
    playStatus: "PLAY" | "PAUSE";
    formerSongId: string;
    targetSongId: string;
    clientSeq: number;
  }): Promise<void> {
    await this.call("listentogether_play_command", {
      roomId: input.roomId,
      commandType: input.commandType,
      progress: Math.max(0, Math.floor(input.progress)),
      playStatus: input.playStatus,
      formerSongId: input.formerSongId,
      targetSongId: input.targetSongId,
      clientSeq: input.clientSeq,
    });
  }

  async getSongDetails(songId: string): Promise<SongDetails> {
    const body = await this.call("song_detail", { ids: songId });
    const songs = Array.isArray(body.songs) ? body.songs : [];
    const song = parseSong(songs[0]);
    if (!song) {
      return { id: songId, name: `歌曲 ${songId}`, artist: "未知歌手", durationMs: 0 };
    }
    return song;
  }

  async getLyrics(songId: string): Promise<RawLyrics> {
    let body: JsonRecord;
    let usedLegacyApi = false;
    try {
      body = await this.call("lyric_new", { id: songId });
    } catch {
      body = await this.call("lyric", { id: songId });
      usedLegacyApi = true;
    }
    if (!usedLegacyApi && !readLyric(body, "lrc")) {
      body = await this.call("lyric", { id: songId });
    }

    return {
      lrc: readLyric(body, "lrc"),
      tlyric: readLyric(body, "tlyric"),
      romalrc: readLyric(body, "romalrc"),
      klyric: readLyric(body, "klyric"),
      yrc: readLyric(body, "yrc"),
      ytlrc: readLyric(body, "ytlrc"),
      yromalrc: readLyric(body, "yromalrc"),
      raw: body,
    };
  }

  async sendHeartbeat(
    roomId: string,
    songId: string | null,
    isPlaying: boolean,
    progress: number,
  ): Promise<void> {
    await this.call("listentogether_heatbeat", {
      roomId,
      songId: songId ?? "0",
      playStatus: isPlaying,
      progress,
    });
  }
}
