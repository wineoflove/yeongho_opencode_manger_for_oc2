import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { MessageSearchResponseSchema } from "@opencode-manager/shared/schemas";
import { MessageSearchService } from "../../src/services/message-search";
import { MessageSearchEngine } from "../../src/services/message-search-engine";
import { MESSAGE_SEARCH_PROJECTION } from "../../src/services/message-search-projection";
import { createMessageSearchRoutes } from "../../src/routes/message-search";

test("searches OC2 inline and normalized text through the actual worker and rejects remote scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-message-search-"));
  const sourcePath = join(root, "source.db");
  const source = new Database(sourcePath);
  const options = {
    sourcePath,
    indexPath: join(root, "index.db"),
    projection: MESSAGE_SEARCH_PROJECTION,
  };
  const service = new MessageSearchService(options);
  try {
    source.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,title TEXT,time_archived INTEGER);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,time_updated INTEGER,data TEXT,PRIMARY KEY(message_id,ordinal));
      INSERT INTO session_v2 VALUES ('root',NULL,'/fixture','Root',NULL),('child','root','/fixture','Child',NULL),('other',NULL,'/other','Other',123);`);
    const add = source.query(
      "INSERT INTO session_message VALUES (?,?,?,?,?,?)",
    );
    add.run(
      "older",
      "root",
      "user",
      50,
      50,
      JSON.stringify({ text: "검색 older" }),
    );
    add.run(
      "user",
      "root",
      "user",
      100,
      100,
      JSON.stringify({ text: "검색 사용자 본문" }),
    );
    add.run(
      "inline",
      "root",
      "assistant",
      200,
      200,
      JSON.stringify({
        content: [
          { type: "reasoning", text: "검색 hidden reasoning" },
          { type: "text", text: "검색 inline 본문" },
        ],
      }),
    );
    add.run(
      "normalized",
      "root",
      "assistant",
      300,
      300,
      JSON.stringify({ content: [{ type: "text", text: "stale inline" }] }),
    );
    add.run(
      "synthetic",
      "root",
      "synthetic",
      400,
      400,
      JSON.stringify({ text: "검색 hidden synthetic" }),
    );
    add.run(
      "child",
      "child",
      "user",
      500,
      500,
      JSON.stringify({ text: "검색 child" }),
    );
    add.run(
      "other",
      "other",
      "user",
      600,
      600,
      JSON.stringify({ text: "검색 archived" }),
    );
    source
      .query("INSERT INTO session_part VALUES (?,?,?,?,?,?)")
      .run(
        "normalized",
        "root",
        0,
        "text",
        300,
        JSON.stringify({ type: "text", text: "검색 current" }),
      );
    const app = new Hono().route(
      "/messages",
      createMessageSearchRoutes(service),
    );
    const response = await app.request(
      "/messages/search?q=검색&directory=/fixture",
    );
    expect(response.status).toBe(200);
    const result = MessageSearchResponseSchema.parse(await response.json());
    expect(
      result.results.map((hit: { messageId: string }) => hit.messageId),
    ).toEqual(["normalized", "inline", "user"]);
    expect(result.results[0]?.snippet).toBe("검색 current");
    expect(result.results[0]?.highlights).toEqual([{ start: 0, end: 2 }]);
    const firstPage = await service.search({ q: "검색", limit: 2, offset: 0 });
    expect(firstPage.results.map((hit) => hit.messageId)).toEqual([
      "other",
      "normalized",
    ]);
    expect(firstPage.hasMore).toBe(true);
    const secondPage = await service.search({ q: "검색", limit: 2, offset: 2 });
    expect(secondPage.results.map((hit) => hit.messageId)).toEqual([
      "inline",
      "user",
    ]);
    expect(secondPage.hasMore).toBe(false);
    expect(
      (await app.request("/messages/search?q=current&serverId=remote")).status,
    ).toBe(400);
    const fts = await service.search({ q: "current", limit: 20, offset: 0 });
    const scopedResponse = await app.request(
      "/messages/search?q=검색&directories=/fixture&directories=/other",
    );
    expect(scopedResponse.status).toBe(200);
    const scoped = MessageSearchResponseSchema.parse(
      await scopedResponse.json(),
    );
    expect(scoped.results.map((hit) => hit.messageId)).toEqual([
      "other",
      "normalized",
      "inline",
      "user",
    ]);
    expect(
      (
        await service.search({
          q: "검색",
          directories: ["/absent"],
          limit: 20,
          offset: 0,
        })
      ).results,
    ).toEqual([]);
    expect(
      (
        await app.request(
          "/messages/search?q=검색&directory=/fixture&directories=/other",
        )
      ).status,
    ).toBe(400);
    expect(
      (await service.search({ q: "stale", limit: 20, offset: 0 })).results,
    ).toEqual([]);
    expect(fts.results.map((hit) => hit.messageId)).toEqual(["normalized"]);
    source.query("DELETE FROM session_message WHERE id=?").run("normalized");
    expect(
      (await service.search({ q: "current", limit: 20, offset: 0 })).results,
    ).toEqual([]);
    const archived = await service.search({
      q: "archived",
      directory: "/other",
      limit: 20,
      offset: 0,
    });
    expect(archived.results.map((hit) => hit.archived)).toEqual([true]);
  } finally {
    try {
      await service.stop();
    } finally {
      source.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("returns a safe unavailable response when the source cannot be opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-message-unavailable-"));
  const service = new MessageSearchService({
    sourcePath: join(root, "missing-private-source.db"),
    indexPath: join(root, "index.db"),
    projection: MESSAGE_SEARCH_PROJECTION,
  });
  try {
    const app = new Hono().route(
      "/messages",
      createMessageSearchRoutes(service),
    );
    const response = await app.request("/messages/search?q=missing");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Message search unavailable",
    });
  } finally {
    try {
      await service.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("refreshes changed text and never returns stale matches before refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocm-message-refresh-"));
  const sourcePath = join(root, "source.db");
  const source = new Database(sourcePath);
  let engine: MessageSearchEngine | undefined;
  try {
    source.exec(`CREATE TABLE session_v2(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,title TEXT,time_archived INTEGER);
      CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
      CREATE TABLE session_part(message_id TEXT,session_id TEXT,ordinal INTEGER,type TEXT,time_updated INTEGER,data TEXT);
      INSERT INTO session_v2 VALUES ('root',NULL,'/fixture','Root',NULL);`);
    source
      .query("INSERT INTO session_message VALUES (?,?,?,?,?,?)")
      .run("user", "root", "user", 1, 1, JSON.stringify({ text: "original" }));
    engine = new MessageSearchEngine(Database, {
      sourcePath,
      indexPath: join(root, "index.db"),
      projection: MESSAGE_SEARCH_PROJECTION,
    });
    await engine.refresh();
    expect(
      engine.search({ q: "original", limit: 20, offset: 0 }).results,
    ).toHaveLength(1);
    source
      .query("UPDATE session_message SET time_updated=?,data=? WHERE id=?")
      .run(Date.now(), JSON.stringify({ text: "changed" }), "user");
    expect(
      engine.search({ q: "original", limit: 20, offset: 0 }).results,
    ).toEqual([]);
    await engine.refresh();
    expect(
      engine
        .search({ q: "changed", limit: 20, offset: 0 })
        .results.map((hit) => hit.messageId),
    ).toEqual(["user"]);
    engine.close();
    engine = undefined;
    source
      .query("UPDATE session_message SET time_updated=1,data=? WHERE id=?")
      .run(JSON.stringify({ text: "restored" }), "user");
    engine = new MessageSearchEngine(Database, {
      sourcePath,
      indexPath: join(root, "index.db"),
      projection: MESSAGE_SEARCH_PROJECTION,
    });
    await engine.refresh();
    expect(
      engine
        .search({ q: "restored", limit: 20, offset: 0 })
        .results.map((hit) => hit.messageId),
    ).toEqual(["user"]);
    const insertMany = source.query(
      "INSERT INTO session_message VALUES (?,?,?,?,?,?)",
    );
    source.transaction(() => {
      for (let index = 0; index < 300; index++) {
        insertMany.run(
          `bulk-${index}`,
          "root",
          "user",
          2,
          Date.now(),
          JSON.stringify({ text: "bulk fixture" }),
        );
      }
    })();
    await engine.refresh();
    source.query("DELETE FROM session_message").run();
    await engine.refresh();
    expect(
      engine.search({ q: "changed", limit: 20, offset: 0 }).results,
    ).toEqual([]);
    const index = new Database(join(root, "index.db"), { readonly: true });
    try {
      expect(
        index.query("SELECT count(*) AS count FROM content").get(),
      ).toEqual({ count: 0 });
    } finally {
      index.close();
    }
  } finally {
    engine?.close();
    source.close();
    await rm(root, { recursive: true, force: true });
  }
});
