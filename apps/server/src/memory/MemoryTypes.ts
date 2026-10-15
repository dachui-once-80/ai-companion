export type MemoryCategory =
  | "identity"
  | "preference"
  | "fact"
  | "event"
  | "relationship"
  | "episode"
  | "impression"
  | "note"
  | "between";

export type MemoryImportance = "low" | "medium" | "high";

export type MemoryStatus = "current" | "historical";

export type MemorySource = "user" | "companion";

export type Memory = { id: string; category: MemoryCategory; key: string; content: string; importance: MemoryImportance; status: MemoryStatus; source: MemorySource; createdAt: string; updatedAt: string; };