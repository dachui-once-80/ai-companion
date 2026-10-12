import { MemoryStore } from "../memory/MemoryStore";

const store = new MemoryStore();

store.clear();

console.log("[Memory] All memories cleared.");