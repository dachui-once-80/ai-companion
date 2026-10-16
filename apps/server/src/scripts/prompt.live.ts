if (process.env.COMPANION_LIVE_SKIP_DOTENV !== "1") {
  const dotenv = await import("dotenv");
  dotenv.config({ path: new URL("../../.env", import.meta.url).pathname });
}

if (!process.env.GEMINI_API_KEY?.trim()) {
  console.error("[prompt] live precondition not met: GEMINI_API_KEY is missing");
  process.exit(1);
}

const { runLive } = await import("./prompt.check");
await runLive();
