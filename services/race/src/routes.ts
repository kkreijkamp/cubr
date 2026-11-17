import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conflict, forbidden, notFound, parse, rateLimit, rateLimited, type Redis, type makeAuth } from '@cubr/common';
import { isEventId } from '@cubr/cubestats';
import { ROOM_ID_RE, sanitizeText } from './sanitize.js';
import type { RoomStore } from './store.js';

const createRoomSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((s) => sanitizeText(s, 40))
    .refine((s) => s.length > 0, 'name must contain visible characters'),
  event: z.string().refine(isEventId, 'unknown event'),
  isPrivate: z.boolean().optional().default(false),
});

export interface RouteDeps {
  store: RoomStore;
  redis: Redis;
  auth: ReturnType<typeof makeAuth>;
}

export function registerRoutes(app: FastifyInstance, { store, redis, auth }: RouteDeps): void {
  // Public lobby: rooms with recent activity, newest first; players = currently connected.
  app.get('/api/race/rooms', async () => ({ rooms: await store.listPublic(50) }));

  // Create a room (guests allowed). The creator then joins over Socket.IO like everyone else.
  app.post('/api/race/rooms', { preHandler: auth.optionalAuth }, async (req, reply) => {
    const body = parse(createRoomSchema, req.body ?? {});
    if (!(await rateLimit(redis, `race-create:${req.user?.id ?? req.ip}`, 20, 60))) {
      throw rateLimited('Too many rooms created, try again in a minute');
    }
    const room = await store.createRoom({ ...body, createdBy: req.user?.id ?? null });
    return reply.status(201).send({ room: { id: room.id, name: room.name, event: room.event, isPrivate: room.isPrivate } });
  });

  // Delete a room: only the signed-in account that created it, and only while nobody is in it.
  // (Otherwise a room drops out of the lobby after 10 empty minutes and expires 2 hours after its last change.)
  app.delete<{ Params: { id: string } }>('/api/race/rooms/:id', { preHandler: auth.requireAuth }, async (req, reply) => {
    const { id } = req.params;
    if (!ROOM_ID_RE.test(id)) throw notFound('Room not found');
    const result = await store.deleteRoom(id, req.user!.id);
    if (result === 'not_found') throw notFound('Room not found (it may have expired)');
    if (result === 'not_creator') throw forbidden('Only the account that created a room can delete it');
    if (result === 'occupied') throw conflict('Somebody is in the room');
    return reply.status(204).send();
  });
}
