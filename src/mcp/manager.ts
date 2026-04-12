// MCP Manager placeholder
// Will integrate @modelcontextprotocol/sdk when ready

export class MCPManager {
  async connectConfiguredServers(): Promise<void> {
    // TODO: Read MCP server configs and connect
    console.log('[mcp] manager initialized (no servers configured)');
  }

  async getToolsForBot(_botId: string): Promise<any[]> {
    return [];
  }
}

export const mcpManager = new MCPManager();
