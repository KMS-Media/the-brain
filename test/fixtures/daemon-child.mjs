// Child process harness for test/mcp-daemon-shim.test.ts: runs the daemon in
// its own OS process (the real deployment topology — see daemon.ts's docs).
// Native Kuzu teardown is fragile when co-located in the same process as an
// HTTP client hitting it in a tight loop (observed directly while building
// this feature); running the daemon here, separately, avoids that entirely
// and matches how it actually runs in production (its own service process).
process.env.BRAIN_FAKE_EMBED = "1";
const { startDaemon } = await import("../../src/mcp/daemon.ts");

const dir = process.argv[2];
const port = Number(process.argv[3]);
const daemon = await startDaemon(dir, port);

process.on("message", async (msg) => {
  if (msg === "close") {
    await daemon.close();
    process.send?.("closed");
  }
});
process.send?.("ready");
