import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
export class MCPManager {
    servers = new Map();
    toolToServer = new Map();
    async initialize(configPath) {
        const config = await this.loadConfig(configPath);
        const serverEntries = Object.entries(config);
        if (serverEntries.length === 0) {
            console.log("[MCP] No MCP servers configured");
            return;
        }
        console.log(`[MCP] Connecting to ${serverEntries.length} server(s)...`);
        const results = await Promise.allSettled(serverEntries.map(([name, cfg]) => this.connectServer(name, cfg)));
        for (let i = 0; i < results.length; i++) {
            if (results[i].status === "rejected") {
                console.error(`[MCP] Failed to connect to "${serverEntries[i][0]}": ${results[i].reason}`);
            }
        }
        console.log(`[MCP] Connected to ${this.servers.size}/${serverEntries.length} servers, ${this.toolToServer.size} tools discovered`);
    }
    async loadConfig(configPath) {
        const paths = [
            configPath,
            process.env.MCP_CONFIG_PATH,
            join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        ].filter(Boolean);
        for (const path of paths) {
            try {
                const raw = await readFile(path, "utf-8");
                const parsed = JSON.parse(raw);
                const servers = parsed.mcpServers || {};
                if (Object.keys(servers).length > 0) {
                    console.log(`[MCP] Loaded config from ${path}`);
                    return servers;
                }
            }
            catch {
                // Try next
            }
        }
        console.log("[MCP] No MCP config found");
        return {};
    }
    async connectServer(name, config) {
        let client;
        if (config.url) {
            client = await this.connectRemoteServer(name, config);
        }
        else if (config.command) {
            client = await this.connectStdioServer(name, config);
        }
        else {
            throw new Error(`Server "${name}" has no command or url configured`);
        }
        const toolsResponse = await client.listTools();
        const tools = (toolsResponse.tools || []).map((t) => ({
            serverName: name,
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
        }));
        this.servers.set(name, {
            name,
            client,
            tools,
            type: config.url ? "remote" : "stdio",
        });
        for (const tool of tools) {
            this.toolToServer.set(tool.name, name);
        }
        console.log(`[MCP] "${name}" connected — ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);
    }
    async connectRemoteServer(name, config) {
        const url = new URL(config.url);
        const headers = config.headers ? { ...config.headers } : {};
        try {
            const client = new Client({ name: "claude-gateway", version: "2.0.0" }, { capabilities: {} });
            await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
            return client;
        }
        catch {
            const client = new Client({ name: "claude-gateway", version: "2.0.0" }, { capabilities: {} });
            await client.connect(new SSEClientTransport(url, { requestInit: { headers } }));
            return client;
        }
    }
    async connectStdioServer(name, config) {
        const client = new Client({ name: "claude-gateway", version: "2.0.0" }, { capabilities: {} });
        await client.connect(new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: { ...process.env, ...config.env },
        }));
        return client;
    }
    async invokeTool(toolName, args) {
        const serverName = this.toolToServer.get(toolName);
        if (!serverName)
            throw new Error(`Unknown tool: ${toolName}`);
        const server = this.servers.get(serverName);
        if (!server)
            throw new Error(`Server "${serverName}" not connected`);
        return await server.client.callTool({ name: toolName, arguments: args });
    }
    getToolsForClaude() {
        const tools = [];
        for (const server of this.servers.values()) {
            for (const tool of server.tools) {
                tools.push({
                    name: tool.name,
                    description: tool.description || "",
                    input_schema: tool.inputSchema,
                });
            }
        }
        return tools;
    }
    getServerNames() {
        return Array.from(this.servers.keys());
    }
    getToolCount() {
        return this.toolToServer.size;
    }
    async shutdown() {
        for (const [name, server] of this.servers) {
            try {
                await server.client.close();
            }
            catch (err) {
                console.error(`[MCP] Error disconnecting "${name}": ${err}`);
            }
        }
        this.servers.clear();
        this.toolToServer.clear();
    }
}
