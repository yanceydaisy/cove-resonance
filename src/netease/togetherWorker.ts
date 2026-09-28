import { NeteaseApiError, NeteaseClient, type AccountProfile } from "./client.js";
import { collectContactUserIds, parseLatestInvite } from "./inviteParser.js";
import { buildFullLyricsModelContext, countAvailableLyricPayloads } from "./lyricsContext.js";
import type { PlaybackStateSink } from "./playbackState.js";
import {
  NeteaseRealtimeTransport,
  type RealtimeChatRoomMessage,
  type RealtimeChatSendResult,
  type RealtimePlaybackEvent,
  type RealtimeTransportStatus,
} from "./realtimeTransport.js";
import type {
  PlayingState,
  SongDetails,
  TogetherInvite,
  TogetherWorkerStatus,
} from "./types.js";

type EventSink = (source: string, text: string, modelContext?: string) => unknown;

type TogetherWorkerOptions = {
  cookie: string;
  enabled: boolean;
  inviterUid?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  playbackReconcileIntervalMs?: number;
  playbackControlTimeoutMs?: number;
  onEvent: EventSink;
  stateSink?: PlaybackStateSink;
};

export type PlaybackControlResult = {
  ok: true;
  confirmed: true;
  commandType: "PLAY" | "PAUSE" | "GOTO";
  roomId: string;
  songId: string;
  playStatus: "PLAY" | "PAUSE";
  progressMs: number;
  clientSeq: number;
  serverSeq: number;
  confirmedAt: string;
};

export type QueueMutationResult = {
  ok: true;
  confirmed: true;
  action: "ENQUEUE_NEXT";
  roomId: string;
  songId: string;
  afterSongId: string;
  version: number;
  confirmedAt: string;
};

type PendingPlaybackControl = {
  commandType: "PLAY" | "PAUSE" | "GOTO";
  roomId: string;
  songId: string;
  clientSeq: number;
  senderId: string;
  expectedPlayStatus: "PLAY" | "PAUSE";
  baselineServerSeq: number | null;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: PlaybackControlResult) => void;
  reject: (error: Error) => void;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class TogetherWorker {
  private readonly client: NeteaseClient;
  private readonly realtime: NeteaseRealtimeTransport;
  private readonly handledInvites = new Set<string>();
  private readonly handledChatMessageKeys = new Set<string>();
  private running = false;
  private roomId: string | null = null;
  private chatRoomId: string | null = null;
  private previousSongId: string | null = null;
  private previousPlayStatus: PlayingState["playStatus"] = "UNKNOWN";
  private joinedPending = false;
  private lastHeartbeatAt = 0;
  private lastRealtimeAttemptAt = 0;
  private lastPlaybackServerSeq: number | null = null;
  private lastPlaybackReconcileAt = 0;
  private latestPlaying: PlayingState | null = null;
  private latestPlaybackObservedAtMs = 0;
  private nextPlaybackClientSeq = 1;
  private pendingPlaybackControl: PendingPlaybackControl | null = null;
  private queueMutationPending = false;
  private playbackHandlingTail: Promise<void> = Promise.resolve();
  private errorStreak = 0;
  private accountProfile: AccountProfile | null = null;
  private currentLyricsModelContext: string | null = null;
  private status: TogetherWorkerStatus;

  constructor(private readonly options: TogetherWorkerOptions) {
    this.client = new NeteaseClient(options.cookie);
    this.realtime = new NeteaseRealtimeTransport(
      options.enabled,
      (message) => {
        this.handleRealtimeChatMessage(message);
      },
      (event) => {
        this.handleRealtimePlaybackEvent(event);
      },
    );
    this.status = {
      enabled: options.enabled,
      phase: options.enabled ? "starting" : "disabled",
      accountId: null,
      roomId: null,
      currentSong: null,
      playStatus: "UNKNOWN",
      lastPollAt: null,
      lastHeartbeatAt: null,
      lastError: null,
    };
  }

  getStatus(): TogetherWorkerStatus {
    return { ...this.status };
  }

  getRealtimeStatus(): RealtimeTransportStatus {
    return this.realtime.getStatus();
  }

  async sendChatRoomText(text: string): Promise<RealtimeChatSendResult> {
    return await this.realtime.sendChatRoomText(text);
  }

  async leaveTogether(): Promise<{
    ok: true;
    ended: boolean;
    alreadyOut: boolean;
    roomId: string | null;
    confirmedAt: string;
  }> {
    const remote = await this.client.getRoomStatus();
    if (!remote.inRoom || !remote.roomId) {
      this.leaveRoom("一起听已经结束了。我会继续等你的下一次邀请。");
      return {
        ok: true,
        ended: false,
        alreadyOut: true,
        roomId: null,
        confirmedAt: new Date().toISOString(),
      };
    }

    const roomId = remote.roomId;
    await this.client.endRoom(roomId);
    const confirmed = await this.client.getRoomStatus();
    if (confirmed.inRoom) {
      throw new Error("NetEase Together leave was not confirmed by authoritative room status.");
    }

    this.leaveRoom("一起听已退出。我会继续等你的下一次邀请。");
    return {
      ok: true,
      ended: true,
      alreadyOut: false,
      roomId,
      confirmedAt: new Date().toISOString(),
    };
  }

  async pausePlayback(): Promise<PlaybackControlResult> {
    return await this.controlPlayback("PAUSE");
  }

  async resumePlayback(): Promise<PlaybackControlResult> {
    return await this.controlPlayback("PLAY");
  }

  async gotoPlayback(songId: string): Promise<PlaybackControlResult> {
    const targetSongId = songId.trim();
    if (!/^\d+$/.test(targetSongId)) {
      throw new Error("NetEase target songId must be numeric.");
    }
    if (!this.roomId) {
      throw new Error("NetEase Listen Together is not currently in a room.");
    }

    const playlist = await this.client.getTogetherPlaylist(this.roomId);
    if (!playlist.displayList.includes(targetSongId)) {
      throw new Error(
        `NetEase GOTO target is not in the current Together displayList: ${targetSongId}. Enqueue it before GOTO.`,
      );
    }

    return await this.controlPlayback("GOTO", targetSongId);
  }

  async nextPlayback(): Promise<PlaybackControlResult> {
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");
    const currentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (!currentSongId) throw new Error("NetEase current playback state is unavailable.");

    const playlist = await this.client.getTogetherPlaylist(this.roomId);
    if (playlist.playMode !== "ORDER_LOOP") {
      throw new Error(`Unsupported NetEase Together playMode for NEXT: ${playlist.playMode ?? "unknown"}`);
    }
    if (!playlist.displayList.length) {
      throw new Error("NetEase Together displayList is empty.");
    }

    const currentIndex = playlist.displayList.indexOf(currentSongId);
    if (currentIndex < 0) {
      throw new Error(`Current NetEase song is missing from displayList: ${currentSongId}`);
    }

    const stillCurrentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (stillCurrentSongId !== currentSongId) {
      throw new Error("NetEase playback changed while resolving NEXT; retry the command.");
    }

    const targetSongId = playlist.displayList[(currentIndex + 1) % playlist.displayList.length];
    return await this.gotoPlayback(targetSongId);
  }

  async enqueueNext(songId: string): Promise<QueueMutationResult> {
    const targetSongId = songId.trim();
    if (!/^\d+$/.test(targetSongId)) {
      throw new Error("NetEase target songId must be numeric.");
    }
    if (this.queueMutationPending) {
      throw new Error("NetEase queue mutation already pending.");
    }
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");

    const currentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
    if (!currentSongId) throw new Error("NetEase current playback state is unavailable.");
    if (targetSongId === currentSongId) {
      throw new Error("NetEase ENQUEUE_NEXT target cannot be the currently playing song.");
    }

    const accountId = this.status.accountId;
    if (!accountId) throw new Error("NetEase account identity is unavailable.");

    this.queueMutationPending = true;
    try {
      const roomId = this.roomId;
      const playlist = await this.client.getTogetherPlaylist(roomId);
      if (playlist.playMode !== "ORDER_LOOP") {
        throw new Error(`Unsupported NetEase Together playMode for ENQUEUE_NEXT: ${playlist.playMode ?? "unknown"}`);
      }
      if (!playlist.displayList.length) {
        throw new Error("NetEase Together displayList is empty.");
      }

      const currentIndex = playlist.displayList.indexOf(currentSongId);
      if (currentIndex < 0) {
        throw new Error(`Current NetEase song is missing from displayList: ${currentSongId}`);
      }

      const ownVersion = playlist.versions.find((entry) => entry.userId === accountId)?.version ?? 0;
      const nextVersion = ownVersion + 1;
      const nextDisplayList = playlist.displayList.filter((id) => id !== targetSongId);
      const currentIndexAfterRemoval = nextDisplayList.indexOf(currentSongId);
      if (currentIndexAfterRemoval < 0) {
        throw new Error(`Current NetEase song disappeared while building queue: ${currentSongId}`);
      }
      nextDisplayList.splice(currentIndexAfterRemoval + 1, 0, targetSongId);

      const stillCurrentSongId = this.latestPlaying?.songId ?? this.status.currentSong?.id ?? null;
      if (stillCurrentSongId !== currentSongId) {
        throw new Error("NetEase playback changed while resolving ENQUEUE_NEXT; retry the command.");
      }

      await this.client.replaceTogetherPlaylist({
        roomId,
        userId: accountId,
        version: nextVersion,
        displayList: nextDisplayList,
        randomList: playlist.randomList,
      });
      console.log(
        `NetEase queue mutation reported: action=ENQUEUE_NEXT afterSongId=${currentSongId} songId=${targetSongId} version=${nextVersion}`,
      );

      const timeoutMs = this.options.playbackControlTimeoutMs ?? 8_000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(250);
        const confirmed = await this.client.getTogetherPlaylist(roomId);
        const confirmedCurrentIndex = confirmed.displayList.indexOf(currentSongId);
        const confirmedNext = confirmedCurrentIndex >= 0
          ? confirmed.displayList[(confirmedCurrentIndex + 1) % confirmed.displayList.length]
          : null;
        const confirmedVersion = confirmed.versions.find(
          (entry) => entry.userId === accountId,
        )?.version ?? 0;
        if (confirmedNext === targetSongId && confirmedVersion >= nextVersion) {
          console.log(
            `NetEase queue mutation confirmed: action=ENQUEUE_NEXT afterSongId=${currentSongId} songId=${targetSongId} version=${confirmedVersion}`,
          );
          return {
            ok: true,
            confirmed: true,
            action: "ENQUEUE_NEXT",
            roomId,
            songId: targetSongId,
            afterSongId: currentSongId,
            version: confirmedVersion,
            confirmedAt: new Date().toISOString(),
          };
        }
      }

      throw new Error(
        `NetEase ENQUEUE_NEXT timed out waiting for playlist confirmation: target=${targetSongId} version=${nextVersion}`,
      );
    } finally {
      this.queueMutationPending = false;
    }
  }

  start(): void {
    if (this.running || !this.options.enabled) return;
    this.running = true;
    void this.run();
  }

  private async run(): Promise<void> {
    try {
      this.accountProfile = await this.client.getAccountProfile();
      this.status.accountId = this.accountProfile.id;
      this.status.phase = "waiting_invite";
      console.log(`NetEase Together worker ready for account ${this.status.accountId}`);
    } catch (error) {
      this.recordError(error, "Cookie validation failed");
    }

    while (this.running) {
      const startedAt = Date.now();
      try {
        if (!this.status.accountId) {
          this.accountProfile = await this.client.getAccountProfile();
          this.status.accountId = this.accountProfile.id;
        }
        await this.pollOnce();
        this.errorStreak = 0;
        this.status.lastError = null;
      } catch (error) {
        if (error instanceof NeteaseApiError && error.code === 488) {
          this.leaveRoom("房间已经结束了。一起听已退出，继续等待下一次邀请。");
        } else {
          this.recordError(error, "Together poll failed");
        }
      }

      const base = this.options.pollIntervalMs ?? 4000;
      const backoff = this.errorStreak > 0
        ? Math.min(60_000, base * 2 ** Math.min(this.errorStreak, 4))
        : base;
      await sleep(Math.max(250, backoff - (Date.now() - startedAt)));
    }
  }

  private async pollOnce(): Promise<void> {
    this.status.lastPollAt = new Date().toISOString();
    const remote = await this.client.getRoomStatus();

    if (remote.inRoom && remote.roomId) {
      if (this.roomId !== remote.roomId) {
        this.enterRoom(remote.roomId, remote.chatRoomId);
      } else if (remote.chatRoomId && remote.chatRoomId !== this.chatRoomId) {
        this.chatRoomId = remote.chatRoomId;
      }
      if (remote.chatRoomId) await this.ensureRealtime(remote.roomId, remote.chatRoomId);
    } else if (this.roomId) {
      this.leaveRoom("一起听已经结束了。我会继续等你的下一次邀请。");
    }

    if (!this.roomId) {
      this.status.phase = "waiting_invite";
      const invite = await this.findInvite();
      if (!invite) return;
      await this.acceptInvite(invite);
    }

    if (!this.roomId) return;
    this.status.phase = "listening";

    const now = Date.now();
    const realtimeConnected = this.realtime.getStatus().connected;
    let playbackHandling = Promise.resolve();
    if (this.shouldReconcilePlayback(now, realtimeConnected)) {
      const playing = await this.client.getPlaying(this.roomId);
      const observedAtMs = Date.now();
      this.lastPlaybackReconcileAt = observedAtMs;
      playbackHandling = this.applyPlayback(playing, observedAtMs, "http");
    }

    await this.maybeHeartbeat();
    await playbackHandling;
  }

  private async ensureRealtime(roomId: string, chatRoomId: string): Promise<void> {
    const realtimeStatus = this.realtime.getStatus();
    if (
      realtimeStatus.connected
      && realtimeStatus.roomId === roomId
      && realtimeStatus.chatRoomId === chatRoomId
    ) return;

    const now = Date.now();
    if (now - this.lastRealtimeAttemptAt < 10_000) return;
    this.lastRealtimeAttemptAt = now;

    try {
      const credentials = await this.client.getRealtimeCredentials();
      console.log(
        `NetEase NIM realtime credentials acquired for account ${this.status.accountId ?? "unknown"}; addresses=${credentials.addresses.length}`,
      );
      if (!this.accountProfile) {
        this.accountProfile = await this.client.getAccountProfile();
        this.status.accountId = this.accountProfile.id;
      }
      await this.realtime.connect({
        roomId,
        chatRoomId,
        credentials,
        memberProfile: {
          userId: this.accountProfile.id,
          ...(this.accountProfile.nickname ? { nick: this.accountProfile.nickname } : {}),
          ...(this.accountProfile.avatarUrl ? { avatar: this.accountProfile.avatarUrl } : {}),
          ...(this.accountProfile.gender !== null ? { gender: this.accountProfile.gender } : {}),
        },
      });
      console.log(`NetEase NIM realtime connected: roomId=${roomId} chatRoomId=${chatRoomId}`);
    } catch (error) {
      this.realtime.recordConnectionError(error);
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`NetEase NIM realtime connect failed: ${detail}`);
    }
  }

  private async findInvite(): Promise<TogetherInvite | null> {
    const ownId = this.status.accountId;
    if (!ownId) return null;
    let contactIds: string[];

    if (this.options.inviterUid) {
      contactIds = [this.options.inviterUid];
    } else {
      const contacts = await this.client.getRecentContacts();
      contactIds = collectContactUserIds(contacts, ownId);
    }

    for (const uid of contactIds) {
      const history = await this.client.getPrivateHistory(uid);
      const invite = parseLatestInvite(history, uid);
      if (invite && !this.handledInvites.has(invite.roomId)) return invite;
    }
    return null;
  }

  private async acceptInvite(invite: TogetherInvite): Promise<void> {
    this.status.phase = "joining";
    this.handledInvites.add(invite.roomId);
    if (this.handledInvites.size > 50) {
      const oldest = this.handledInvites.values().next().value as string | undefined;
      if (oldest) this.handledInvites.delete(oldest);
    }
    try {
      const accepted = await this.client.acceptInvite(invite.roomId, invite.inviterId);
      this.enterRoom(accepted.roomId ?? invite.roomId, accepted.chatRoomId);
      if (accepted.roomId && accepted.chatRoomId) {
        await this.ensureRealtime(accepted.roomId, accepted.chatRoomId);
      }
    } catch (error) {
      this.handledInvites.delete(invite.roomId);
      throw error;
    }
  }

  private enterRoom(roomId: string, chatRoomId: string | null = null): void {
    const changedRoom = this.roomId !== roomId;
    if (changedRoom) {
      this.rejectPendingPlaybackControl("NetEase Listen Together room changed before playback control confirmation.");
      void this.realtime.disconnect();
      this.nextPlaybackClientSeq = 1;
    }
    this.roomId = roomId;
    this.chatRoomId = chatRoomId;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = true;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.lastPlaybackServerSeq = null;
    this.lastPlaybackReconcileAt = 0;
    this.latestPlaying = null;
    this.latestPlaybackObservedAtMs = 0;
    this.status.roomId = roomId;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "listening";
    this.updateState((sink) => sink.enterRoom(roomId));
  }

  private leaveRoom(message: string): void {
    const wasInRoom = Boolean(this.roomId);
    this.rejectPendingPlaybackControl("NetEase Listen Together ended before playback control confirmation.");
    this.roomId = null;
    this.chatRoomId = null;
    this.previousSongId = null;
    this.previousPlayStatus = "UNKNOWN";
    this.currentLyricsModelContext = null;
    this.joinedPending = false;
    this.lastHeartbeatAt = 0;
    this.lastRealtimeAttemptAt = 0;
    this.lastPlaybackServerSeq = null;
    this.lastPlaybackReconcileAt = 0;
    this.latestPlaying = null;
    this.latestPlaybackObservedAtMs = 0;
    this.status.roomId = null;
    this.status.currentSong = null;
    this.status.playStatus = "UNKNOWN";
    this.status.phase = "waiting_invite";
    void this.realtime.disconnect();
    this.updateState((sink) => sink.leaveRoom());
    if (wasInRoom) this.options.onEvent("netease.together", message);
  }

  private currentPlaybackProgressMs(nowMs = Date.now()): number {
    const playing = this.latestPlaying;
    if (!playing) return 0;

    const elapsedMs = playing.playStatus === "PLAY"
      ? Math.max(0, nowMs - this.latestPlaybackObservedAtMs)
      : 0;
    let progressMs = Math.max(0, playing.progress + elapsedMs);
    const currentSong = this.status.currentSong;
    if (currentSong && currentSong.id === playing.songId) {
      progressMs = Math.min(progressMs, currentSong.durationMs);
    }
    return progressMs;
  }

  private async controlPlayback(
    commandType: "PLAY" | "PAUSE" | "GOTO",
    requestedTargetSongId?: string,
  ): Promise<PlaybackControlResult> {
    if (this.pendingPlaybackControl) {
      throw new Error(
        `NetEase playback control already pending: ${this.pendingPlaybackControl.commandType}`,
      );
    }
    if (!this.roomId) throw new Error("NetEase Listen Together is not currently in a room.");

    const realtimeStatus = this.realtime.getStatus();
    if (!realtimeStatus.connected) {
      throw new Error("NetEase realtime is not connected; refusing unconfirmed playback control.");
    }

    const senderId = this.status.accountId;
    if (!senderId) throw new Error("NetEase account identity is unavailable.");

    const playing = this.latestPlaying;
    const currentSongId = playing?.songId ?? this.status.currentSong?.id ?? null;
    if (!playing || !currentSongId) throw new Error("NetEase current playback state is unavailable.");

    const targetSongId = commandType === "GOTO"
      ? requestedTargetSongId ?? null
      : currentSongId;
    if (!targetSongId) throw new Error("NetEase target songId is unavailable.");

    const expectedPlayStatus: "PLAY" | "PAUSE" = commandType === "PAUSE" ? "PAUSE" : "PLAY";
    const progressMs = commandType === "GOTO" ? 0 : this.currentPlaybackProgressMs();
    const roomId = this.roomId;
    const clientSeq = this.nextPlaybackClientSeq++;
    const baselineServerSeq = this.lastPlaybackServerSeq;
    const timeoutMs = this.options.playbackControlTimeoutMs ?? 8_000;

    let resolveConfirmation!: (result: PlaybackControlResult) => void;
    let rejectConfirmation!: (error: Error) => void;
    const confirmation = new Promise<PlaybackControlResult>((resolve, reject) => {
      resolveConfirmation = resolve;
      rejectConfirmation = reject;
    });

    const timeout = setTimeout(() => {
      if (this.pendingPlaybackControl?.clientSeq !== clientSeq) return;
      this.pendingPlaybackControl = null;
      rejectConfirmation(new Error(
        `NetEase playback control timed out waiting for realtime confirmation: ${commandType} clientSeq=${clientSeq}`,
      ));
    }, timeoutMs);

    this.pendingPlaybackControl = {
      commandType,
      roomId,
      songId: targetSongId,
      clientSeq,
      senderId,
      expectedPlayStatus,
      baselineServerSeq,
      timeout,
      resolve: resolveConfirmation,
      reject: rejectConfirmation,
    };

    try {
      await this.client.reportPlaybackCommand({
        roomId,
        commandType,
        progress: progressMs,
        playStatus: expectedPlayStatus,
        formerSongId: currentSongId,
        targetSongId,
        clientSeq,
      });
      console.log(
        `NetEase playback control reported: command=${commandType} formerSongId=${currentSongId} targetSongId=${targetSongId} progressMs=${Math.floor(progressMs)} clientSeq=${clientSeq}`,
      );
    } catch (error) {
      if (this.pendingPlaybackControl?.clientSeq === clientSeq) {
        clearTimeout(this.pendingPlaybackControl.timeout);
        this.pendingPlaybackControl = null;
      }
      throw error;
    }

    return await confirmation;
  }

  private confirmPendingPlaybackControl(event: RealtimePlaybackEvent): void {
    const pending = this.pendingPlaybackControl;
    if (!pending) return;
    if (event.clientSeq !== pending.clientSeq) return;
    if (event.senderId !== pending.senderId) return;
    if (event.commandType !== pending.commandType) return;
    if (event.songId !== pending.songId) return;
    if (event.playStatus !== pending.expectedPlayStatus) return;
    if (event.serverSeq === null) return;
    if (
      pending.baselineServerSeq !== null
      && event.serverSeq <= pending.baselineServerSeq
    ) return;

    clearTimeout(pending.timeout);
    this.pendingPlaybackControl = null;
    const result: PlaybackControlResult = {
      ok: true,
      confirmed: true,
      commandType: pending.commandType,
      roomId: pending.roomId,
      songId: pending.songId,
      playStatus: event.playStatus,
      progressMs: event.progressMs,
      clientSeq: pending.clientSeq,
      serverSeq: event.serverSeq,
      confirmedAt: new Date(event.receivedAtMs).toISOString(),
    };
    console.log(
      `NetEase playback control confirmed: command=${result.commandType} songId=${result.songId} clientSeq=${result.clientSeq} serverSeq=${result.serverSeq}`,
    );
    pending.resolve(result);
  }

  private rejectPendingPlaybackControl(message: string): void {
    const pending = this.pendingPlaybackControl;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingPlaybackControl = null;
    pending.reject(new Error(message));
  }

  private shouldReconcilePlayback(nowMs: number, realtimeConnected: boolean): boolean {
    if (!this.latestPlaying) return true;
    if (!realtimeConnected) return true;
    const interval = this.options.playbackReconcileIntervalMs ?? 30_000;
    return nowMs - this.lastPlaybackReconcileAt >= interval;
  }

  private async maybeHeartbeat(): Promise<void> {
    const playing = this.latestPlaying;
    if (!this.roomId || !playing) return;

    const interval = this.options.heartbeatIntervalMs ?? 10_000;
    const nowMs = Date.now();
    if (nowMs - this.lastHeartbeatAt < interval) return;

    const progressMs = this.currentPlaybackProgressMs(nowMs);
    await this.client.sendHeartbeat(
      this.roomId,
      playing.songId,
      playing.playStatus === "PLAY",
      progressMs,
    );
    this.lastHeartbeatAt = Date.now();
    this.status.lastHeartbeatAt = new Date(this.lastHeartbeatAt).toISOString();
  }

  private applyPlayback(
    playing: PlayingState,
    observedAtMs: number,
    origin: "http" | "realtime",
  ): Promise<void> {
    const serverSeq = playing.serverSeq;
    if (
      serverSeq !== undefined
      && this.lastPlaybackServerSeq !== null
      && serverSeq < this.lastPlaybackServerSeq
    ) {
      console.log(
        `Together stale playback ignored: origin=${origin} serverSeq=${serverSeq} latest=${this.lastPlaybackServerSeq}`,
      );
      return Promise.resolve();
    }
    if (serverSeq !== undefined) this.lastPlaybackServerSeq = serverSeq;

    this.latestPlaying = { ...playing };
    this.latestPlaybackObservedAtMs = observedAtMs;

    this.updateState((sink) => sink.updatePlayback({
      songId: playing.songId,
      playStatus: playing.playStatus,
      progressMs: playing.progress,
      observedAtMs,
      ...(serverSeq === undefined ? {} : { serverSeq }),
    }));

    const handling = this.playbackHandlingTail.then(() => this.handlePlaying(playing));
    this.playbackHandlingTail = handling.catch(() => {});
    return handling;
  }

  private handleRealtimePlaybackEvent(event: RealtimePlaybackEvent): void {
    if (!this.roomId) return;

    const knownStatus = this.status.playStatus;
    const playStatus = event.playStatus === "UNKNOWN" && knownStatus !== "UNKNOWN"
      ? knownStatus
      : event.playStatus;
    const songId = event.songId ?? this.status.currentSong?.id ?? this.previousSongId;
    const playing: PlayingState = {
      songId,
      playStatus,
      progress: event.progressMs,
      ...(event.serverSeq === null ? {} : { serverSeq: event.serverSeq }),
    };

    void this.applyPlayback(playing, event.receivedAtMs, "realtime")
      .then(() => {
        this.confirmPendingPlaybackControl(event);
      })
      .catch((error) => {
        const detail = error instanceof NeteaseApiError
          ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
          : error instanceof Error ? error.message : "unknown error";
        console.error(`Together realtime playback handling failed: ${detail}`);
      });
  }

  private async handlePlaying(playing: PlayingState): Promise<void> {
    this.status.playStatus = playing.playStatus;
    const statusChanged = this.previousPlayStatus !== playing.playStatus;

    if (playing.songId && playing.songId !== this.previousSongId) {
      const song = await this.client.getSongDetails(playing.songId);
      this.previousSongId = playing.songId;
      this.currentLyricsModelContext = null;
      this.status.currentSong = song;
      this.updateState((sink) => sink.updateSong(song));
      const lyricsContext = await this.loadLyrics(song);

      if (playing.playStatus === "PLAY") {
        const prefix = this.joinedPending
          ? "你把我拉进一起听啦。现在播放"
          : "你换到了";
        this.options.onEvent(
          "netease.music_changed",
          `${prefix}《${song.name}》— ${song.artist}。请结合我们的对话自然回应；如果没必要点评，也可以只安静陪听。`,
          lyricsContext,
        );
        this.joinedPending = false;
      }
    } else if (statusChanged && this.previousPlayStatus !== "UNKNOWN") {
      if (playing.playStatus === "PAUSE") {
        this.options.onEvent(
          "netease.playback",
          "一起听暂停了。",
          this.currentLyricsModelContext ?? undefined,
        );
      } else if (playing.playStatus === "PLAY") {
        const song = this.status.currentSong;
        this.options.onEvent(
          "netease.playback",
          song
            ? `一起听继续播放：《${song.name}》— ${song.artist}。`
            : "一起听继续播放了。",
          this.currentLyricsModelContext ?? undefined,
        );
        this.joinedPending = false;
      }
    }

    this.previousPlayStatus = playing.playStatus;
  }

  private handleRealtimeChatMessage(message: RealtimeChatRoomMessage): void {
    if (message.category !== "text" || !message.text) return;
    const ownAccountId = this.status.accountId;
    if (ownAccountId && message.senderId === ownAccountId) return;

    const roomKey = this.roomId ?? "no-room";
    const messageKey = message.messageId
      ? roomKey + ":" + message.messageId
      : roomKey + ":" + (message.senderId ?? "unknown") + ":" + String(message.timetagMs ?? message.receivedAtMs) + ":" + message.text;
    if (this.handledChatMessageKeys.has(messageKey)) {
      const suffix = message.messageId ? "***" + message.messageId.slice(-6) : "unknown";
      console.warn("NetEase duplicate ChatRoom message suppressed: messageId=" + suffix);
      return;
    }
    this.handledChatMessageKeys.add(messageKey);
    while (this.handledChatMessageKeys.size > 512) {
      const oldest = this.handledChatMessageKeys.values().next().value;
      if (!oldest) break;
      this.handledChatMessageKeys.delete(oldest);
    }

    this.options.onEvent(
      "netease.chatroom",
      message.text,
      this.currentLyricsModelContext ?? undefined,
    );
  }

  private async loadLyrics(song: SongDetails): Promise<string | undefined> {
    try {
      const lyrics = await this.client.getLyrics(song.id);
      this.updateState((sink) => sink.updateLyrics(song.id, lyrics));
      const modelContext = buildFullLyricsModelContext(song, lyrics);
      this.currentLyricsModelContext = modelContext;
      if (modelContext) {
        console.log(
          `Together full lyrics context ready: songId=${song.id} payloads=${countAvailableLyricPayloads(lyrics)} contextChars=${modelContext.length}`,
        );
      }
      return modelContext ?? undefined;
    } catch (error) {
      this.currentLyricsModelContext = null;
      const detail = error instanceof NeteaseApiError
        ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
        : error instanceof Error ? error.message : "unknown error";
      console.error(`Together lyrics load failed: ${detail}`);
      return undefined;
    }
  }

  private updateState(update: (sink: PlaybackStateSink) => void): void {
    if (!this.options.stateSink) return;
    try {
      update(this.options.stateSink);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      console.error(`Together state update failed: ${detail}`);
    }
  }

  private recordError(error: unknown, prefix: string): void {
    this.errorStreak += 1;
    this.status.phase = this.errorStreak >= 3 ? "error" : "backoff";
    const detail = error instanceof NeteaseApiError
      ? `${error.operation}${error.code === null ? "" : ` code=${error.code}`}`
      : error instanceof Error ? error.message : "unknown error";
    this.status.lastError = `${prefix}: ${detail}`;
    console.error(this.status.lastError);
  }
}

export function createTogetherWorker(
  onEvent: EventSink,
  stateSink?: PlaybackStateSink,
): TogetherWorker {
  const cookie = process.env.NETEASE_COOKIE?.trim() ?? "";
  const explicitlyDisabled = /^(0|false|off|no)$/i.test(
    process.env.TOGETHER_ENABLED?.trim() ?? "",
  );
  const enabled = Boolean(cookie) && !explicitlyDisabled;
  const parseInterval = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value >= 1000 ? value : fallback;
  };

  if (cookie && !cookie.includes("MUSIC_U=")) {
    console.warn("NETEASE_COOKIE is set but MUSIC_U is missing; Together worker may not authenticate.");
  }

  return new TogetherWorker({
    cookie,
    enabled,
    inviterUid: process.env.NETEASE_INVITER_UID?.trim() || undefined,
    pollIntervalMs: parseInterval("TOGETHER_POLL_INTERVAL_MS", 4000),
    heartbeatIntervalMs: parseInterval("TOGETHER_HEARTBEAT_INTERVAL_MS", 10_000),
    playbackReconcileIntervalMs: parseInterval("TOGETHER_PLAYBACK_RECONCILE_INTERVAL_MS", 30_000),
    playbackControlTimeoutMs: parseInterval("TOGETHER_PLAYBACK_CONTROL_TIMEOUT_MS", 8_000),
    onEvent,
    stateSink,
  });
}
