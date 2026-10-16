import type { Express } from "express";
import { Companion } from "./Companion";
import { InvalidNameError } from "./CompanionProfileStore";

export function registerCompanionIdentityRoutes(
  app: Express,
  companion: Companion,
): void {
  app.get("/api/companion/identity", (_req, res) => {
    try {
      res.json(companion.getIdentity());
    } catch (error) {
      console.error("[Identity] read failed:", error);
      res.status(500).json({ error: "Failed to read identity" });
    }
  });

  app.post("/api/companion/rename", (req, res) => {
    const name =
      typeof req.body === "object" &&
      req.body !== null &&
      "name" in req.body
        ? req.body.name
        : undefined;

    if (typeof name !== "string") {
      res.status(400).json({ error: "name must be a string" });
      return;
    }

    try {
      companion.rename(name);
      res.json(companion.getIdentity());
    } catch (error) {
      if (error instanceof InvalidNameError) {
        res.status(400).json({ error: error.message });
        return;
      }

      console.error("[Identity] rename failed:", error);
      res.status(500).json({ error: "Failed to rename" });
    }
  });
}
