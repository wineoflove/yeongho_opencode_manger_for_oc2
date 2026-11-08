import { Hono } from "hono";
import {
  MessageSearchQuerySchema,
  type MessageSearchQuery,
  type MessageSearchResponse,
} from "@opencode-manager/shared/schemas";
import { logger } from "../utils/logger";

export function createMessageSearchRoutes(source: {
  readonly search: (
    query: MessageSearchQuery,
  ) => Promise<MessageSearchResponse>;
}) {
  const app = new Hono();
  app.get("/search", async (context) => {
    const parsed = MessageSearchQuerySchema.safeParse({
      ...context.req.query(),
      directories: context.req.queries("directories"),
    });
    if (!parsed.success)
      return context.json({ error: "Invalid search query" }, 400);
    try {
      return context.json(await source.search(parsed.data));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      logger.error("Message search unavailable");
      return context.json({ error: "Message search unavailable" }, 503);
    }
  });
  return app;
}
