import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listenerWakeHub } from "../listenerWake.js";
import type { InMemoryEventQueue } from "../queue.js";
import { normalizeReplyBubbles } from "../replyBubbles.js";
import type { BridgeEvent } from "../types.js";
import type { PlaybackStateStore } from "./playbackState.js";
import type { TogetherWorker } from "./togetherWorker.js";

export function registerNeteaseTogetherTools(
  server: McpServer,
  playbackState: PlaybackStateStore,
  togetherWorker: TogetherWorker,
  queue: InMemoryEventQueue,
  eventFilter: (event: BridgeEvent) => boolean,
): void {
  server.registerTool(
    "netease_together_now",
    {
      title: "NetEase Together now",
      description: "Read the latest cached NetEase Listen Together playback state and nearby lyrics.",
      inputSchema: {},
      outputSchema: {
        inRoom: z.boolean(),
        roomId: z.string().optional(),
        playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
        song: z.object({
          id: z.string(),
          name: z.string(),
          artist: z.string(),
          durationMs: z.number(),
          coverUrl: z.string().optional(),
        }).optional(),
        progressMs: z.number(),
        durationMs: z.number(),
        progressRatio: z.number(),
        lyric: z.object({
          previous: z.string().optional(),
          current: z.string().optional(),
          next: z.string().optional(),
        }).optional(),
        observedAt: z.string().nullable(),
        stateUpdatedAt: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = playbackState.getCurrentState();
      return {
        structuredContent: state,
        content: [{ type: "text", text: JSON.stringify(state) }],
      };
    },
  );

  server.registerTool(
    "netease_together_realtime_status",
    {
      title: "NetEase Together realtime status",
      description: "Read the NIM realtime connection status plus the latest cached playback event and ChatRoom message. Never returns NetEase credentials.",
      inputSchema: {},
      outputSchema: {
        enabled: z.boolean(),
        connected: z.boolean(),
        roomId: z.string().nullable(),
        chatRoomId: z.string().nullable(),
        credentialsReady: z.boolean(),
        lastPlaybackEvent: z.object({
          type: z.literal("playback"),
          serverSeq: z.number().nullable(),
          commandType: z.string().nullable(),
          songId: z.string().nullable(),
          formerSongId: z.string().nullable(),
          progressMs: z.number(),
          playStatus: z.enum(["PLAY", "PAUSE", "UNKNOWN"]),
          receivedAtMs: z.number(),
          clientSeq: z.number().optional(),
          senderId: z.string().optional(),
        }).nullable(),
        lastChatMessage: z.object({
          type: z.literal("chatroom_message"),
          category: z.enum(["text", "custom", "robot", "notification", "other"]),
          msgType: z.number().nullable(),
          senderId: z.string().nullable(),
          senderNick: z.string().nullable(),
          text: z.string().nullable(),
          messageId: z.string().nullable(),
          timetagMs: z.number().nullable(),
          receivedAtMs: z.number(),
        }).nullable(),
        lastError: z.string().nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      const state = togetherWorker.getRealtimeStatus();
      return {
        structuredContent: state,
        content: [{ type: "text", text: JSON.stringify(state) }],
      };
    },
  );

  server.registerTool(
    "netease_together_leave",
    {
      title: "Leave NetEase Together",
      description:
        "End Cove's current NetEase Listen Together room, confirm authoritative room exit, "
        + "disconnect realtime state, and return the worker to waiting for invitations. "
        + "If Cove is already out of Together, this is a confirmed no-op.",
      inputSchema: {},
      outputSchema: {
        ok: z.literal(true),
        ended: z.boolean(),
        alreadyOut: z.boolean(),
        roomId: z.string().nullable(),
        confirmedAt: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: true,
      },
    },
    async () => {
      const result = await togetherWorker.leaveTogether();
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  const playbackControlOutputSchema = {
    ok: z.literal(true),
    confirmed: z.literal(true),
    commandType: z.enum(["PLAY", "PAUSE", "GOTO"]),
    roomId: z.string(),
    songId: z.string(),
    playStatus: z.enum(["PLAY", "PAUSE"]),
    progressMs: z.number(),
    clientSeq: z.number(),
    serverSeq: z.number(),
    confirmedAt: z.string(),
  };

  server.registerTool(
    "netease_together_pause",
    {
      title: "Pause NetEase Together playback",
      description: "Pause the current NetEase Listen Together playback from Cove's account. Success is returned only after a matching NIM realtime confirmation is observed; an HTTP report alone is not treated as success.",
      inputSchema: {},
      outputSchema: playbackControlOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async () => {
      const result = await togetherWorker.pausePlayback();
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_together_resume",
    {
      title: "Resume NetEase Together playback",
      description: "Resume the current NetEase Listen Together playback from Cove's account. Success is returned only after a matching NIM realtime confirmation is observed; an HTTP report alone is not treated as success.",
      inputSchema: {},
      outputSchema: playbackControlOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async () => {
      const result = await togetherWorker.resumePlayback();
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_together_goto",
    {
      title: "Go to a NetEase Together song",
      description: "Switch NetEase Listen Together playback to a specific numeric songId and start playing from the beginning. Success is returned only after a matching NIM realtime GOTO confirmation is observed.",
      inputSchema: {
        songId: z.string().trim().regex(/^\d+$/),
      },
      outputSchema: playbackControlOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ songId }) => {
      const result = await togetherWorker.gotoPlayback(songId);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_together_next",
    {
      title: "Play the next NetEase Together song",
      description: "Resolve the next song from the current NetEase Listen Together ORDER_LOOP displayList, then switch via a realtime-confirmed GOTO command.",
      inputSchema: {},
      outputSchema: playbackControlOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async () => {
      const result = await togetherWorker.nextPlayback();
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  const queueMutationOutputSchema = {
    ok: z.literal(true),
    confirmed: z.literal(true),
    action: z.literal("ENQUEUE_NEXT"),
    roomId: z.string(),
    songId: z.string(),
    afterSongId: z.string(),
    version: z.number(),
    confirmedAt: z.string(),
  };

  server.registerTool(
    "netease_together_enqueue_next",
    {
      title: "Enqueue a NetEase Together song next",
      description: "Move or insert a numeric songId immediately after the currently playing song in the ORDER_LOOP displayList. Uses the documented REPLACE queue command and returns success only after authoritative playlist reread confirms both adjacency and Cove's queue version.",
      inputSchema: {
        songId: z.string().trim().regex(/^\d+$/),
      },
      outputSchema: queueMutationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ songId }) => {
      const result = await togetherWorker.enqueueNext(songId);
      return {
        structuredContent: result,
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  server.registerTool(
    "netease_together_send_message",
    {
      title: "Send NetEase Together room message",
      description: "Send one ordinary text message from Cove's NetEase account to the currently connected Listen Together ChatRoom. This is primarily for manual/proactive sends. If a required Cove Bridge reply is currently outstanding, the Bridge will automatically bind this send to that event and complete its reply route so the listener cannot deadlock.",
      inputSchema: { text: z.string().trim().min(1).max(500) },
      outputSchema: {
        ok: z.literal(true),
        roomId: z.string(),
        chatRoomId: z.string(),
        messageId: z.string(),
        text: z.string(),
        code: z.number(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async ({ text }) => {
      const normalized = text.trim();
      const outstanding = queue.getOutstandingRequiredReplyEvent(eventFilter);

      if (!outstanding) {
        const result = await togetherWorker.sendChatRoomText(normalized);
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      }

      if (outstanding.replyRoute !== "netease.chatroom") {
        throw new Error(`Outstanding reply route is not supported by this tool: ${outstanding.replyRoute ?? "none"}`);
      }

      const bubbles = normalizeReplyBubbles([normalized]);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({
          eventId: outstanding.id,
          route: outstanding.replyRoute,
          messages: bubbles,
        }))
        .digest("hex");
      const claim = queue.claimReply(outstanding.id, fingerprint);
      if (claim.state === "in_progress") {
        throw new Error(`Routed reply is already in progress: ${outstanding.id}`);
      }
      if (claim.state === "already_completed") {
        throw new Error(`Routed reply is already completed: ${outstanding.id}`);
      }

      try {
        let result = null;
        for (let index = claim.sentCount; index < bubbles.length; index += 1) {
          result = await togetherWorker.sendChatRoomText(bubbles[index]);
          queue.markReplyMessageSent(outstanding.id, fingerprint);
          if (index < bubbles.length - 1) {
            await new Promise<void>((resolve) => setTimeout(resolve, 350));
          }
        }
        if (!result) throw new Error("Routed reply has no unsent bubble to deliver.");
        queue.markReplyCompleted(outstanding.id, fingerprint);
        listenerWakeHub.wake("reply-completed");
        console.warn(
          `Cove Bridge compatibility route completed via netease_together_send_message: eventId=${outstanding.id} messages=${bubbles.length}`,
        );
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      } catch (error) {
        queue.releaseReply(outstanding.id, fingerprint);
        throw error;
      }
    },
  );
}
