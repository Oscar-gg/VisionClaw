import Anthropic from "@anthropic-ai/sdk";
const MAX_TOOL_ITERATIONS = 10;
export class ClaudeClient {
    anthropic;
    mcpManager;
    config;
    constructor(mcpManager, config) {
        this.anthropic = new Anthropic();
        this.mcpManager = mcpManager;
        this.config = config;
    }
    updateConfig(updates) {
        Object.assign(this.config, updates);
    }
    getConfig() {
        return { ...this.config };
    }
    async chat(history, text, images) {
        const content = [];
        if (images && images.length > 0) {
            for (const base64 of images) {
                content.push({
                    type: "image",
                    source: { type: "base64", media_type: "image/jpeg", data: base64 },
                });
            }
        }
        if (text) {
            content.push({ type: "text", text });
        }
        const messages = [...history, { role: "user", content }];
        const tools = this.mcpManager.getToolsForClaude();
        const allToolCalls = [];
        let currentMessages = messages;
        for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
            const response = await this.anthropic.messages.create({
                model: this.config.model,
                max_tokens: this.config.maxTokens,
                system: this.config.systemPrompt,
                messages: currentMessages,
                ...(tools.length > 0 ? { tools } : {}),
            });
            const toolUseBlocks = response.content.filter((block) => block.type === "tool_use");
            if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
                const responseText = response.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join("\n");
                return { responseText, toolCalls: allToolCalls };
            }
            const assistantMessage = { role: "assistant", content: response.content };
            const toolResults = [];
            for (const toolUse of toolUseBlocks) {
                console.log(`[Claude] Tool call: ${toolUse.name}`);
                try {
                    const result = await this.mcpManager.invokeTool(toolUse.name, toolUse.input);
                    allToolCalls.push({ name: toolUse.name, result });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: JSON.stringify(result),
                    });
                }
                catch (err) {
                    const errorMsg = err instanceof Error ? err.message : "Unknown error";
                    console.error(`[Claude] Tool error (${toolUse.name}): ${errorMsg}`);
                    allToolCalls.push({ name: toolUse.name, result: { error: errorMsg } });
                    toolResults.push({
                        type: "tool_result",
                        tool_use_id: toolUse.id,
                        content: JSON.stringify({ error: errorMsg }),
                        is_error: true,
                    });
                }
            }
            currentMessages = [
                ...currentMessages,
                assistantMessage,
                { role: "user", content: toolResults },
            ];
        }
        return {
            responseText: "Reached maximum tool iterations. Please try a simpler request.",
            toolCalls: allToolCalls,
        };
    }
}
