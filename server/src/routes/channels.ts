import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import type { Config } from "../config.js";
import { requireAuth } from "../auth.js";
import {
  clampHistoryLimit,
  createChannel,
  getChannelById,
  getChannelMessages,
  nextChannelPosition,
  normalizeChannelName,
} from "../channels.js";
import { toPublicChannel, toPublicMessage } from "../types.js";

interface ChannelRoutesOptions {
  config: Config;
}

const createChannelSchema = {
  body: {
    type: "object",
    required: ["name", "type"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 64 },
      type: { type: "string", enum: ["text"] },
    },
    additionalProperties: false,
  },
} as const;

const messageHistorySchema = {
  params: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  querystring: {
    type: "object",
    properties: {
      before: { type: "integer", minimum: 1 },
      limit: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Channel REST endpoints (SPEC.md §9). `POST /api/channels` creates a text channel
 * and broadcasts `channel.create`; `GET /api/channels/:id/messages` returns a
 * keyset history page (newest-first). Both are Bearer-guarded via {@link requireAuth}
 * and read the shared `app.db`; thin adapters over the story-001 accessors.
 */
const channelRoutes: FastifyPluginAsync<ChannelRoutesOptions> = async (
  app: FastifyInstance,
  opts: ChannelRoutesOptions,
) => {
  const { config } = opts;
  const db = app.db;

  app.post<{ Body: { name: string; type: "text" } }>(
    "/api/channels",
    { schema: createChannelSchema, preHandler: requireAuth },
    async (request, reply) => {
      // Spaces aren't allowed in channel names — collapse them to hyphens (SPEC.md §9).
      const name = normalizeChannelName(request.body.name);
      if (name.length === 0) {
        return reply.code(400).send({ error: "channel_name_invalid" });
      }

      const position = nextChannelPosition(db);
      const row = createChannel(db, {
        name,
        type: "text",
        position,
        createdBy: request.user!.id,
      });
      const channel = toPublicChannel(row);

      request.server.broadcast({ op: "channel.create", d: { channel } });
      return reply.code(201).send(channel);
    },
  );

  app.get<{ Params: { id: number }; Querystring: { before?: number; limit?: number } }>(
    "/api/channels/:id/messages",
    { schema: messageHistorySchema, preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params;
      if (!getChannelById(db, id)) {
        return reply.code(404).send({ error: "channel_not_found" });
      }

      const limit = clampHistoryLimit(request.query.limit, {
        defaultLimit: config.messageHistoryDefaultLimit,
        maxLimit: config.messageHistoryMaxLimit,
      });
      const rows = getChannelMessages(db, id, { before: request.query.before, limit });
      return reply.send(rows.map((r) => toPublicMessage(r.message, r.attachment)));
    },
  );
};

export default channelRoutes;
