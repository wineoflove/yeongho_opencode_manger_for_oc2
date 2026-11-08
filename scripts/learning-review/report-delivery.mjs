import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openCodeErrorStatus } from "../../shared/src/opencode/index.ts";

const VERIFY_ATTEMPTS = 10;
const VERIFY_DELAY_MS = 1000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Report delivery channels: `prompt` posts into the feedback session (which wakes its agent), `file` only stores the report. */
export const DELIVERY_MODES = ["prompt", "file"];

async function deliverFile(config, messageID, report) {
  const folder = join(config.store, "reviews", "delivered");
  const path = join(folder, `${messageID}.md`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, report, { flag: "wx", mode: 0o600 });
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  if ((await readFile(path, "utf8")) !== report)
    throw new Error("Report ID content mismatch");
}

async function deliveredText(api, sessionID, messageID) {
  try {
    const message = await api.session.message.get({ sessionID, messageID });
    if (message.type !== "user") throw new Error("Report ID content mismatch");
    return message.text;
  } catch (error) {
    if (openCodeErrorStatus(error) === 404) return null;
    throw error;
  }
}

async function deliverPrompt(config, messageID, report, api) {
  const sessionID = config.feedbackSession;
  const existing = await deliveredText(api, sessionID, messageID);
  if (existing === report) return;
  if (existing !== null) throw new Error("Report ID content mismatch");
  try {
    await api.session.prompt({ sessionID, id: messageID, text: report });
  } catch (error) {
    if (openCodeErrorStatus(error) !== 409) throw error;
  }
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    const text = await deliveredText(api, sessionID, messageID);
    if (text === report) return;
    if (text !== null) throw new Error("Report ID content mismatch");
    await delay(VERIFY_DELAY_MS);
  }
  throw new Error("Report delivery not verified");
}

/**
 * Delivers `report` exactly once under `messageID`. A retry with the same ID and text is a no-op, and a different text
 * under an already used ID is rejected. `prompt` delivery uses OpenCode 2's durable prompt IDs, and so wakes the
 * feedback session's agent: OpenCode 2 has no inert user message, and unresumed inputs stay queued into the next turn.
 */
export async function publishExactReport(config, messageID, report, api) {
  if (config.delivery === "file") return deliverFile(config, messageID, report);
  if (config.delivery === "prompt")
    return deliverPrompt(config, messageID, report, api);
  throw new Error("LEARNING_REVIEW_DELIVERY_UNCONFIGURED");
}
