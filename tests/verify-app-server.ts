import { CodexAppServerClient } from "../src/app-server/client.js";
import { AppServerEventMapper } from "../src/app-server/events.js";
import { startThread } from "../src/app-server/thread.js";
import { interruptTurn, startTurn } from "../src/app-server/turn.js";

const argumentsList = process.argv.slice(2);
const verifyTurn = argumentsList.includes("--turn");
const command = argumentsList.find((argument) => argument !== "--turn") ?? "codex";
const client = new CodexAppServerClient({
  command,
  args: ["app-server", "--stdio"],
  requestTimeoutMs: 15_000,
});

client.onStderr((line) => console.error(`[app-server] ${line}`));
client.onError((error) => console.error(`[app-server-error] ${error.message}`));

try {
  await client.start();
  console.log(`Codex App Server handshake: ${client.getStatus()}`);
  const threadId = await startThread(client, { cwd: process.cwd() });
  console.log(`Codex App Server thread/start: ${threadId}`);
  if (verifyTurn) {
    const mapper = new AppServerEventMapper();
    mapper.registerThread("verification", threadId);
    let text = "";
    let resolveCompletion = (_success: boolean): void => {};
    const completion = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    const unsubscribe = client.onNotification((notification) => {
      for (const event of mapper.map(notification)) {
        if (event.type === "text_delta") text += event.text;
        if (event.type === "turn_completed") resolveCompletion(event.success);
        if (event.type === "error") resolveCompletion(false);
      }
    });
    const turnId = await startTurn(client, {
      threadId,
      cwd: process.cwd(),
      input: [{ type: "text", text: "Reply exactly PONG. Do not use tools or modify files." }],
    });
    let verificationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const success = await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          verificationTimer = setTimeout(() => reject(new Error("Turn verification timed out")), 60_000);
        }),
      ]);
      console.log(`Codex App Server turn/start: ${turnId} (${success ? "completed" : "failed"})`);
      console.log(`Codex App Server text delta: ${text.trim()}`);
      if (!success) process.exitCode = 1;
    } catch (error) {
      await interruptTurn(client, threadId, turnId).catch(() => {});
      throw error;
    } finally {
      if (verificationTimer) clearTimeout(verificationTimer);
      unsubscribe();
    }
  }
} finally {
  await client.stop();
}
