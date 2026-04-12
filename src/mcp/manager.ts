import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const JINA_MCP_URL = 'https://mcp.jina.ai/v1';
const SEARCH_RESULT_LIMIT = 4000;
const READ_RESULT_LIMIT = 6000;

class MCPManager {
  private client: Client | null = null;
  private connecting = false;

  async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) {
      // Wait for ongoing connection
      while (this.connecting) await Bun.sleep(100);
      if (this.client) return this.client;
    }

    this.connecting = true;
    try {
      const apiKey = process.env.JINA_API_KEY;
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      } else {
        console.warn('[mcp] JINA_API_KEY not set, requests may be rate-limited');
      }

      const client = new Client({ name: 'bubblebored', version: '0.1.0' });
      const transport = new StreamableHTTPClientTransport(
        new URL(JINA_MCP_URL),
        { requestInit: { headers } },
      );
      await client.connect(transport);
      this.client = client;
      console.log('[mcp] connected to Jina MCP server');
      return client;
    } catch (e) {
      console.error('[mcp] connection failed:', e);
      throw e;
    } finally {
      this.connecting = false;
    }
  }

  async searchWeb(query: string): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: 'search_web',
      arguments: { query },
    });
    const text = extractText(result.content);
    return text.length > SEARCH_RESULT_LIMIT
      ? text.slice(0, SEARCH_RESULT_LIMIT) + '\n…(已截断)'
      : text;
  }

  async readUrl(url: string): Promise<string> {
    const client = await this.ensureConnected();
    const result = await client.callTool({
      name: 'read_url',
      arguments: { url },
    });
    const text = extractText(result.content);
    return text.length > READ_RESULT_LIMIT
      ? text.slice(0, READ_RESULT_LIMIT) + '\n…(已截断)'
      : text;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      console.log('[mcp] disconnected');
    }
  }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
}

export const mcpManager = new MCPManager();
