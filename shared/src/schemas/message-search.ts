import { z } from "zod";

export const MessageSearchQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(200),
    directory: z.string().optional(),
    directories: z.array(z.string().min(1)).min(1).max(100).optional(),
    serverId: z.literal("local").optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).max(10000).default(0),
  })
  .strict()
  .refine(
    (query) => query.directory === undefined || query.directories === undefined,
  );

export const MessageSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      sessionId: z.string(),
      sessionTitle: z.string(),
      directory: z.string(),
      archived: z.boolean(),
      messageId: z.string(),
      partId: z.string(),
      role: z.enum(["user", "assistant"]),
      createdAt: z.number(),
      snippet: z.string(),
      highlights: z.array(
        z.object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  hasMore: z.boolean(),
  indexing: z.object({
    complete: z.boolean(),
    indexedRowid: z.number(),
    maxRowid: z.number(),
  }),
});

export type MessageSearchQuery = z.infer<typeof MessageSearchQuerySchema>;
export type MessageSearchResponse = z.infer<typeof MessageSearchResponseSchema>;
