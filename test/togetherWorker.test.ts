import assert from "node:assert/strict";
import test from "node:test";
import { TogetherWorker } from "../src/netease/togetherWorker.js";
import type { PlaybackStateSink } from "../src/netease/playbackState.js";
import type {
  RealtimeChatRoomMessage,
  RealtimePlaybackEvent,
} from "../src/netease/realtimeTransport.js";
import type { PlaybackSnapshot } from "../src/netease/types.js";

test("deduplicates repeated realtime ChatRoom messages by message id", () => {
  const events: Array<{ source: string; text: string }> = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: (source, text) => {
      events.push({ source, text });
    },
  });

  const message: RealtimeChatRoomMessage = {
    type: "chatroom_message",
    category: "text",
    msgType: 0,
    senderId: "12345",
    senderNick: "user",
    text: "hello once",
    messageId: "same-message-id",
    timetagMs: 123456789,
    receivedAtMs: 123456789,
  };

  const handle = (worker as unknown as {
    handleRealtimeChatMessage: (message: RealtimeChatRoomMessage) => void;
  }).handleRealtimeChatMessage.bind(worker);

  handle(message);
  handle({ ...message, receivedAtMs: message.receivedAtMs + 50 });

  assert.deepEqual(events, [{ source: "netease.chatroom", text: "hello once" }]);
});


test("applies realtime playback to state immediately before the next HTTP poll", async () => {
  const events: Array<{ source: string; text: string }> = [];
  const playbackUpdates: PlaybackSnapshot[] = [];
  const stateSink: PlaybackStateSink = {
    enterRoom: () => {},
    leaveRoom: () => {},
    updatePlayback: (snapshot) => {
      playbackUpdates.push({ ...snapshot });
    },
    updateSong: () => {},
    updateLyrics: () => {},
  };
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: (source, text) => {
      events.push({ source, text });
    },
    stateSink,
  });

  const internals = worker as unknown as {
    enterRoom: (roomId: string, chatRoomId?: string | null) => void;
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
  };
  internals.enterRoom("room", "123");
  internals.previousSongId = "song-1";
  internals.previousPlayStatus = "PLAY";

  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 101,
    commandType: "PAUSE",
    songId: "song-1",
    formerSongId: "song-1",
    progressMs: 4321,
    playStatus: "PAUSE",
    receivedAtMs: 123456,
  });

  assert.deepEqual(playbackUpdates, [{
    songId: "song-1",
    playStatus: "PAUSE",
    progressMs: 4321,
    observedAtMs: 123456,
    serverSeq: 101,
  }]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{
    source: "netease.playback",
    text: "一起听暂停了。",
  }]);
  assert.equal(worker.getStatus().playStatus, "PAUSE");
});

test("ignores a stale playback serverSeq after a newer realtime event", () => {
  const playbackUpdates: PlaybackSnapshot[] = [];
  const stateSink: PlaybackStateSink = {
    enterRoom: () => {},
    leaveRoom: () => {},
    updatePlayback: (snapshot) => {
      playbackUpdates.push({ ...snapshot });
    },
    updateSong: () => {},
    updateLyrics: () => {},
  };
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: () => {},
    stateSink,
  });

  const internals = worker as unknown as {
    enterRoom: (roomId: string, chatRoomId?: string | null) => void;
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
  };
  internals.enterRoom("room", "123");
  internals.previousSongId = "song-1";
  internals.previousPlayStatus = "PLAY";

  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 200,
    commandType: "PAUSE",
    songId: "song-1",
    formerSongId: "song-1",
    progressMs: 9000,
    playStatus: "PAUSE",
    receivedAtMs: 20_000,
  });
  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 199,
    commandType: "PLAY",
    songId: "song-1",
    formerSongId: "song-1",
    progressMs: 8500,
    playStatus: "PLAY",
    receivedAtMs: 20_050,
  });

  assert.equal(playbackUpdates.length, 1);
  assert.equal(playbackUpdates[0]?.serverSeq, 200);
  assert.equal(playbackUpdates[0]?.playStatus, "PAUSE");
});

test("skips HTTP playback reconcile while realtime is connected and the interval is fresh", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackReconcileIntervalMs: 30_000,
    heartbeatIntervalMs: 10_000,
    onEvent: () => {},
  });

  const now = Date.now();
  let getPlayingCalls = 0;
  const internals = worker as unknown as {
    client: {
      getRoomStatus: () => Promise<{ inRoom: boolean; roomId: string | null; chatRoomId: string | null }>;
      getPlaying: (roomId: string) => Promise<{
        songId: string | null;
        playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
        progress: number;
        serverSeq?: number;
      }>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: null;
      };
    };
    pollOnce: () => Promise<void>;
    roomId: string | null;
    chatRoomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackReconcileAt: number;
    lastHeartbeatAt: number;
  };

  internals.roomId = "room";
  internals.chatRoomId = "123";
  internals.latestPlaying = {
    songId: "song-1",
    playStatus: "PLAY",
    progress: 5_000,
    serverSeq: 10,
  };
  internals.latestPlaybackObservedAtMs = now;
  internals.lastPlaybackReconcileAt = now;
  internals.lastHeartbeatAt = now;

  internals.client.getRoomStatus = async () => ({
    inRoom: true,
    roomId: "room",
    chatRoomId: "123",
  });
  internals.client.getPlaying = async () => {
    getPlayingCalls += 1;
    return {
      songId: "song-1",
      playStatus: "PLAY",
      progress: 5_100,
      serverSeq: 10,
    };
  };
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: true,
    roomId: "room",
    chatRoomId: "123",
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: null,
  });

  await internals.pollOnce();
  assert.equal(getPlayingCalls, 0);
});

test("falls back to HTTP playback reconcile immediately when realtime is disconnected", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackReconcileIntervalMs: 30_000,
    heartbeatIntervalMs: 10_000,
    onEvent: () => {},
  });

  const now = Date.now();
  let getPlayingCalls = 0;
  const internals = worker as unknown as {
    client: {
      getRoomStatus: () => Promise<{ inRoom: boolean; roomId: string | null; chatRoomId: string | null }>;
      getPlaying: (roomId: string) => Promise<{
        songId: string | null;
        playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
        progress: number;
        serverSeq?: number;
      }>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: string | null;
      };
    };
    pollOnce: () => Promise<void>;
    roomId: string | null;
    chatRoomId: string | null;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackReconcileAt: number;
    lastHeartbeatAt: number;
  };

  internals.roomId = "room";
  internals.chatRoomId = null;
  internals.previousSongId = "song-1";
  internals.previousPlayStatus = "PLAY";
  internals.latestPlaying = {
    songId: "song-1",
    playStatus: "PLAY",
    progress: 5_000,
    serverSeq: 10,
  };
  internals.latestPlaybackObservedAtMs = now;
  internals.lastPlaybackReconcileAt = now;
  internals.lastHeartbeatAt = now;

  internals.client.getRoomStatus = async () => ({
    inRoom: true,
    roomId: "room",
    chatRoomId: null,
  });
  internals.client.getPlaying = async () => {
    getPlayingCalls += 1;
    return {
      songId: "song-1",
      playStatus: "PLAY",
      progress: 5_250,
      serverSeq: 11,
    };
  };
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: false,
    roomId: "room",
    chatRoomId: null,
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: "disconnected",
  });

  await internals.pollOnce();
  assert.equal(getPlayingCalls, 1);
});

test("heartbeat advances progress from the latest realtime anchor without another HTTP read", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    heartbeatIntervalMs: 1_000,
    onEvent: () => {},
  });

  const sent: Array<{ songId: string | null; playing: boolean; progress: number }> = [];
  const now = Date.now();
  const internals = worker as unknown as {
    client: {
      sendHeartbeat: (
        roomId: string,
        songId: string | null,
        playing: boolean,
        progress: number,
      ) => Promise<void>;
    };
    maybeHeartbeat: () => Promise<void>;
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastHeartbeatAt: number;
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "song-1",
    playStatus: "PLAY",
    progress: 12_000,
    serverSeq: 20,
  };
  internals.latestPlaybackObservedAtMs = now - 5_000;
  internals.lastHeartbeatAt = 0;
  internals.client.sendHeartbeat = async (_roomId, songId, playing, progress) => {
    sent.push({ songId, playing, progress });
  };

  await internals.maybeHeartbeat();

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.songId, "song-1");
  assert.equal(sent[0]?.playing, true);
  assert.ok((sent[0]?.progress ?? 0) >= 17_000 && (sent[0]?.progress ?? 0) < 18_000);
});

test("playback control waits for a matching realtime confirmation after HTTP report", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackControlTimeoutMs: 500,
    onEvent: () => {},
  });

  const reported: Array<{
    roomId: string;
    commandType: "PLAY" | "PAUSE";
    progress: number;
    playStatus: "PLAY" | "PAUSE";
    formerSongId: string;
    targetSongId: string;
    clientSeq: number;
  }> = [];

  const internals = worker as unknown as {
    client: {
      reportPlaybackCommand: (input: (typeof reported)[number]) => Promise<void>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: null;
      };
    };
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackServerSeq: number | null;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    status: {
      accountId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    };
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "song-1",
    playStatus: "PAUSE",
    progress: 12_345,
    serverSeq: 100,
  };
  internals.latestPlaybackObservedAtMs = Date.now();
  internals.lastPlaybackServerSeq = 100;
  internals.previousSongId = "song-1";
  internals.previousPlayStatus = "PAUSE";
  internals.status.accountId = "cove-account";
  internals.status.playStatus = "PAUSE";
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: true,
    roomId: "room",
    chatRoomId: "123",
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: null,
  });
  internals.client.reportPlaybackCommand = async (input) => {
    reported.push({ ...input });
  };

  let settled = false;
  const control = worker.resumePlayback().then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.commandType, "PLAY");
  assert.equal(reported[0]?.playStatus, "PLAY");
  assert.equal(reported[0]?.clientSeq, 1);
  assert.equal(reported[0]?.targetSongId, "song-1");
  assert.equal(settled, false);

  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 101,
    commandType: "PLAY",
    songId: "song-1",
    formerSongId: "song-1",
    progressMs: 12_400,
    playStatus: "PLAY",
    receivedAtMs: Date.now(),
    clientSeq: 1,
    senderId: "cove-account",
  });

  const result = await control;
  assert.equal(result.confirmed, true);
  assert.equal(result.commandType, "PLAY");
  assert.equal(result.clientSeq, 1);
  assert.equal(result.serverSeq, 101);
  assert.equal(result.songId, "song-1");
});

test("playback control ignores a realtime event from the wrong sender and times out", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackControlTimeoutMs: 40,
    onEvent: () => {},
  });

  const internals = worker as unknown as {
    client: {
      reportPlaybackCommand: (input: unknown) => Promise<void>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: null;
      };
    };
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackServerSeq: number | null;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    status: {
      accountId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    };
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "song-1",
    playStatus: "PLAY",
    progress: 20_000,
    serverSeq: 200,
  };
  internals.latestPlaybackObservedAtMs = Date.now();
  internals.lastPlaybackServerSeq = 200;
  internals.previousSongId = "song-1";
  internals.previousPlayStatus = "PLAY";
  internals.status.accountId = "cove-account";
  internals.status.playStatus = "PLAY";
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: true,
    roomId: "room",
    chatRoomId: "123",
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: null,
  });
  internals.client.reportPlaybackCommand = async () => {};

  const control = worker.pausePlayback();

  await new Promise<void>((resolve) => setImmediate(resolve));
  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 201,
    commandType: "PAUSE",
    songId: "song-1",
    formerSongId: "song-1",
    progressMs: 20_050,
    playStatus: "PAUSE",
    receivedAtMs: Date.now(),
    clientSeq: 1,
    senderId: "somebody-else",
  });

  await assert.rejects(
    control,
    /timed out waiting for realtime confirmation/,
  );
});

test("GOTO reports the target song from progress zero and waits for realtime confirmation", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackControlTimeoutMs: 500,
    onEvent: () => {},
  });

  const reported: Array<{
    roomId: string;
    commandType: "PLAY" | "PAUSE" | "GOTO";
    progress: number;
    playStatus: "PLAY" | "PAUSE";
    formerSongId: string;
    targetSongId: string;
    clientSeq: number;
  }> = [];

  const internals = worker as unknown as {
    client: {
      getTogetherPlaylist: (roomId: string) => Promise<{
        displayList: string[];
        randomList: string[];
        playMode: string | null;
        versions: Array<{ userId: string; version: number }>;
      }>;
      reportPlaybackCommand: (input: (typeof reported)[number]) => Promise<void>;
      getSongDetails: (songId: string) => Promise<{
        id: string;
        name: string;
        artist: string;
        durationMs: number;
      }>;
      getLyrics: (songId: string) => Promise<Record<string, unknown>>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: null;
      };
    };
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackServerSeq: number | null;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    status: {
      accountId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    };
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "old-song",
    playStatus: "PAUSE",
    progress: 42_000,
    serverSeq: 300,
  };
  internals.latestPlaybackObservedAtMs = Date.now();
  internals.lastPlaybackServerSeq = 300;
  internals.previousSongId = "old-song";
  internals.previousPlayStatus = "PAUSE";
  internals.status.accountId = "cove-account";
  internals.status.playStatus = "PAUSE";
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: true,
    roomId: "room",
    chatRoomId: "123",
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: null,
  });
  internals.client.getTogetherPlaylist = async () => ({
    displayList: ["old-song", "123456"],
    randomList: [],
    playMode: "ORDER_LOOP",
    versions: [{ userId: "cove-account", version: 1 }],
  });
  internals.client.reportPlaybackCommand = async (input) => {
    reported.push({ ...input });
  };
  internals.client.getSongDetails = async (songId) => ({
    id: songId,
    name: "target",
    artist: "artist",
    durationMs: 180_000,
  });
  internals.client.getLyrics = async () => ({});

  let settled = false;
  const control = worker.gotoPlayback("123456").then((result) => {
    settled = true;
    return result;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.commandType, "GOTO");
  assert.equal(reported[0]?.formerSongId, "old-song");
  assert.equal(reported[0]?.targetSongId, "123456");
  assert.equal(reported[0]?.progress, 0);
  assert.equal(reported[0]?.playStatus, "PLAY");
  assert.equal(settled, false);

  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 301,
    commandType: "GOTO",
    songId: "123456",
    formerSongId: "123456",
    progressMs: 0,
    playStatus: "PLAY",
    receivedAtMs: Date.now(),
    clientSeq: 1,
    senderId: "cove-account",
  });

  const result = await control;
  assert.equal(result.confirmed, true);
  assert.equal(result.commandType, "GOTO");
  assert.equal(result.songId, "123456");
  assert.equal(result.playStatus, "PLAY");
  assert.equal(result.progressMs, 0);
  assert.equal(result.serverSeq, 301);
});

test("NEXT resolves the following ORDER_LOOP displayList song and confirms via GOTO", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackControlTimeoutMs: 500,
    onEvent: () => {},
  });

  const reported: Array<{
    roomId: string;
    commandType: "PLAY" | "PAUSE" | "GOTO";
    progress: number;
    playStatus: "PLAY" | "PAUSE";
    formerSongId: string;
    targetSongId: string;
    clientSeq: number;
  }> = [];

  const internals = worker as unknown as {
    client: {
      getTogetherPlaylist: (roomId: string) => Promise<{
        displayList: string[];
        randomList: string[];
        playMode: string | null;
      }>;
      reportPlaybackCommand: (input: (typeof reported)[number]) => Promise<void>;
      getSongDetails: (songId: string) => Promise<{
        id: string;
        name: string;
        artist: string;
        durationMs: number;
      }>;
      getLyrics: (songId: string) => Promise<Record<string, unknown>>;
    };
    realtime: {
      getStatus: () => {
        enabled: boolean;
        connected: boolean;
        roomId: string | null;
        chatRoomId: string | null;
        credentialsReady: boolean;
        lastPlaybackEvent: null;
        lastChatMessage: null;
        lastError: null;
      };
    };
    handleRealtimePlaybackEvent: (event: RealtimePlaybackEvent) => void;
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    latestPlaybackObservedAtMs: number;
    lastPlaybackServerSeq: number | null;
    previousSongId: string | null;
    previousPlayStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    status: {
      accountId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
    };
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "22",
    playStatus: "PLAY",
    progress: 10_000,
    serverSeq: 400,
  };
  internals.latestPlaybackObservedAtMs = Date.now();
  internals.lastPlaybackServerSeq = 400;
  internals.previousSongId = "22";
  internals.previousPlayStatus = "PLAY";
  internals.status.accountId = "cove-account";
  internals.status.playStatus = "PLAY";
  internals.realtime.getStatus = () => ({
    enabled: true,
    connected: true,
    roomId: "room",
    chatRoomId: "123",
    credentialsReady: true,
    lastPlaybackEvent: null,
    lastChatMessage: null,
    lastError: null,
  });
  internals.client.getTogetherPlaylist = async () => ({
    displayList: ["11", "22", "33"],
    randomList: [],
    playMode: "ORDER_LOOP",
  });
  internals.client.reportPlaybackCommand = async (input) => {
    reported.push({ ...input });
  };
  internals.client.getSongDetails = async (songId) => ({
    id: songId,
    name: "next",
    artist: "artist",
    durationMs: 180_000,
  });
  internals.client.getLyrics = async () => ({});

  const control = worker.nextPlayback();

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.commandType, "GOTO");
  assert.equal(reported[0]?.formerSongId, "22");
  assert.equal(reported[0]?.targetSongId, "33");
  assert.equal(reported[0]?.progress, 0);
  assert.equal(reported[0]?.playStatus, "PLAY");

  internals.handleRealtimePlaybackEvent({
    type: "playback",
    serverSeq: 401,
    commandType: "GOTO",
    songId: "33",
    formerSongId: "33",
    progressMs: 0,
    playStatus: "PLAY",
    receivedAtMs: Date.now(),
    clientSeq: 1,
    senderId: "cove-account",
  });

  const result = await control;
  assert.equal(result.confirmed, true);
  assert.equal(result.commandType, "GOTO");
  assert.equal(result.songId, "33");
  assert.equal(result.serverSeq, 401);
});

test("ENQUEUE_NEXT rewrites ORDER_LOOP displayList and confirms adjacency plus version", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    playbackControlTimeoutMs: 1_000,
    onEvent: () => {},
  });

  const replacements: Array<{
    roomId: string;
    userId: string;
    version: number;
    displayList: string[];
    randomList: string[];
  }> = [];
  let playlistReads = 0;

  const internals = worker as unknown as {
    client: {
      getTogetherPlaylist: (roomId: string) => Promise<{
        displayList: string[];
        randomList: string[];
        playMode: string | null;
        versions: Array<{ userId: string; version: number }>;
      }>;
      replaceTogetherPlaylist: (input: (typeof replacements)[number]) => Promise<void>;
    };
    roomId: string | null;
    latestPlaying: {
      songId: string | null;
      playStatus: "PLAY" | "PAUSE" | "UNKNOWN";
      progress: number;
      serverSeq?: number;
    } | null;
    status: {
      accountId: string | null;
    };
  };

  internals.roomId = "room";
  internals.latestPlaying = {
    songId: "22",
    playStatus: "PLAY",
    progress: 10_000,
    serverSeq: 500,
  };
  internals.status.accountId = "cove-account";

  internals.client.getTogetherPlaylist = async () => {
    playlistReads += 1;
    if (playlistReads === 1) {
      return {
        displayList: ["11", "22", "33", "44"],
        randomList: ["44", "11"],
        playMode: "ORDER_LOOP",
        versions: [{ userId: "cove-account", version: 2 }],
      };
    }
    return {
      displayList: ["11", "22", "44", "33"],
      randomList: ["44", "11"],
      playMode: "ORDER_LOOP",
      versions: [{ userId: "cove-account", version: 3 }],
    };
  };
  internals.client.replaceTogetherPlaylist = async (input) => {
    replacements.push({
      ...input,
      displayList: [...input.displayList],
      randomList: [...input.randomList],
    });
  };

  const result = await worker.enqueueNext("44");

  assert.equal(replacements.length, 1);
  assert.equal(replacements[0]?.roomId, "room");
  assert.equal(replacements[0]?.userId, "cove-account");
  assert.equal(replacements[0]?.version, 3);
  assert.deepEqual(replacements[0]?.displayList, ["11", "22", "44", "33"]);
  assert.deepEqual(replacements[0]?.randomList, ["44", "11"]);
  assert.equal(result.confirmed, true);
  assert.equal(result.action, "ENQUEUE_NEXT");
  assert.equal(result.songId, "44");
  assert.equal(result.afterSongId, "22");
  assert.equal(result.version, 3);
});

test("GOTO rejects a target outside the current Together displayList before reporting", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: () => {},
  });

  let reported = false;
  const internals = worker as unknown as {
    client: {
      getTogetherPlaylist: (roomId: string) => Promise<{
        displayList: string[];
        randomList: string[];
        playMode: string | null;
        versions: Array<{ userId: string; version: number }>;
      }>;
      reportPlaybackCommand: (input: unknown) => Promise<void>;
    };
    roomId: string | null;
  };

  internals.roomId = "room";
  internals.client.getTogetherPlaylist = async () => ({
    displayList: ["111", "222"],
    randomList: [],
    playMode: "ORDER_LOOP",
    versions: [],
  });
  internals.client.reportPlaybackCommand = async () => {
    reported = true;
  };

  await assert.rejects(
    worker.gotoPlayback("33075107"),
    /not in the current Together displayList/,
  );
  assert.equal(reported, false);
});

test("leaveTogether ends the authoritative room and clears local room state after confirmation", async () => {
  const events: Array<{ source: string; text: string }> = [];
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: (source, text) => events.push({ source, text }),
  });

  let statusReads = 0;
  let endedRoomId: string | null = null;
  const internals = worker as unknown as {
    enterRoom: (roomId: string, chatRoomId?: string | null) => void;
    client: {
      getRoomStatus: () => Promise<{ inRoom: boolean; roomId: string | null; chatRoomId: string | null }>;
      endRoom: (roomId: string) => Promise<void>;
    };
  };
  internals.enterRoom("host-room", "chat-room");
  internals.client.getRoomStatus = async () => {
    statusReads += 1;
    return statusReads === 1
      ? { inRoom: true, roomId: "host-room", chatRoomId: "chat-room" }
      : { inRoom: false, roomId: null, chatRoomId: null };
  };
  internals.client.endRoom = async (roomId) => {
    endedRoomId = roomId;
  };

  const result = await worker.leaveTogether();

  assert.equal(endedRoomId, "host-room");
  assert.equal(statusReads, 2);
  assert.equal(result.ok, true);
  assert.equal(result.ended, true);
  assert.equal(result.alreadyOut, false);
  assert.equal(result.roomId, "host-room");
  assert.equal(worker.getStatus().roomId, null);
  assert.equal(worker.getStatus().phase, "waiting_invite");
  assert.deepEqual(events, [{
    source: "netease.together",
    text: "一起听已退出。我会继续等你的下一次邀请。",
  }]);
});

test("leaveTogether is a confirmed no-op when authoritative status is already out", async () => {
  const worker = new TogetherWorker({
    cookie: "",
    enabled: false,
    onEvent: () => {},
  });

  let endCalls = 0;
  const internals = worker as unknown as {
    client: {
      getRoomStatus: () => Promise<{ inRoom: boolean; roomId: string | null; chatRoomId: string | null }>;
      endRoom: (roomId: string) => Promise<void>;
    };
  };
  internals.client.getRoomStatus = async () => ({
    inRoom: false,
    roomId: null,
    chatRoomId: null,
  });
  internals.client.endRoom = async () => {
    endCalls += 1;
  };

  const result = await worker.leaveTogether();

  assert.equal(endCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.ended, false);
  assert.equal(result.alreadyOut, true);
  assert.equal(result.roomId, null);
  assert.equal(worker.getStatus().phase, "waiting_invite");
});
