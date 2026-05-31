import { v4 as uuidv4 } from "uuid";
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export class ConversationStore {
    store = new Map();
    cleanupTimer;
    constructor() {
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    }
    getOrCreate(conversationId) {
        const id = conversationId || uuidv4();
        const entry = this.store.get(id);
        if (entry) {
            entry.lastAccess = Date.now();
            return { id, messages: entry.messages };
        }
        const newEntry = { messages: [], lastAccess: Date.now() };
        this.store.set(id, newEntry);
        return { id, messages: newEntry.messages };
    }
    append(conversationId, ...messages) {
        const entry = this.store.get(conversationId);
        if (entry) {
            entry.messages.push(...messages);
            entry.lastAccess = Date.now();
        }
    }
    reset(conversationId) {
        this.store.delete(conversationId);
    }
    resetAll() {
        this.store.clear();
    }
    cleanup() {
        const now = Date.now();
        for (const [id, entry] of this.store) {
            if (now - entry.lastAccess > CONVERSATION_TTL_MS) {
                this.store.delete(id);
            }
        }
    }
    get size() {
        return this.store.size;
    }
    destroy() {
        clearInterval(this.cleanupTimer);
        this.store.clear();
    }
}
