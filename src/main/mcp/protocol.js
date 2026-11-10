'use strict';

// The Model Context Protocol subset Keywright serves: lifecycle, ping and tools.
// Messages are JSON-RPC 2.0 objects; the transport (httpServer.js) only moves them.
// https://modelcontextprotocol.io/specification

/** Newest first. A client asking for an unknown version gets the newest. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** A failure the model should read and act on, returned as a tool result with isError. */
class ToolError extends Error {}

/**
 * Checks tool arguments against the small JSON Schema subset the tools declare:
 * object properties, required, type, enum and array item types.
 * @returns {string | null} the first problem found
 */
function checkArguments(schema, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args))
    return 'Arguments must be an object.';
  for (const name of schema.required || []) {
    if (args[name] === undefined || args[name] === null)
      return `Missing required argument "${name}".`;
  }
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    if (!property) {
      if (schema.additionalProperties === false)
        return `Unknown argument "${name}".`;
      continue;
    }
    if (value === undefined || value === null)
      continue;
    const problem = checkValue(property, value);
    if (problem)
      return `Argument "${name}" ${problem}`;
  }
  return null;
}

function checkValue(property, value) {
  const type = property.type;
  const ok = {
    string: () => typeof value === 'string',
    number: () => typeof value === 'number' && Number.isFinite(value),
    integer: () => Number.isInteger(value),
    boolean: () => typeof value === 'boolean',
    array: () => Array.isArray(value),
    object: () => typeof value === 'object' && !Array.isArray(value),
  }[type];
  if (ok && !ok())
    return `must be ${type === 'integer' || type === 'array' || type === 'object' ? 'an' : 'a'} ${type}.`;
  if (property.enum && !property.enum.includes(value))
    return `must be one of: ${property.enum.join(', ')}.`;
  if (type === 'array' && property.items) {
    for (const item of value) {
      const problem = checkValue(property.items, item);
      if (problem)
        return `items ${problem.replace(/^must/, 'must each')}`;
    }
  }
  return null;
}

/** Turns what a tool handler returned into an MCP tool result. */
function toolResult(value) {
  if (value && typeof value === 'object' && Array.isArray(value.content))
    return value;
  if (Array.isArray(value))
    return { content: value };
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return { content: [{ type: 'text', text }] };
}

class McpProtocol {
  /**
   * @param {{ name: string, version: string, title?: string, instructions?: string,
   *           tools: Array<{ name: string, title?: string, description: string, inputSchema: object,
   *                          annotations?: object, handler: (args: object) => unknown }>,
   *           onInitialize?: (clientInfo: object) => void,
   *           onToolCall?: (name: string, args: object) => void }} options
   */
  constructor(options) {
    this.options = options;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /**
   * @param {unknown} message a parsed JSON-RPC message
   * @returns {Promise<object | null>} the response, null for notifications and responses
   */
  async handle(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0')
      return errorResponse(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message.');
    const hasId = message.id !== undefined && message.id !== null;
    if (typeof message.method !== 'string') {
      // A response to a server request; Keywright sends none, so there is nothing to match.
      return hasId && !('result' in message || 'error' in message)
        ? errorResponse(message.id, INVALID_REQUEST, 'Missing method.') : null;
    }
    if (!hasId)
      return null; // notifications/initialized, notifications/cancelled, ...
    try {
      const result = await this._dispatch(message.method, message.params || {});
      return { jsonrpc: '2.0', id: message.id, result };
    } catch (error) {
      if (error instanceof RpcError)
        return errorResponse(message.id, error.code, error.message);
      return errorResponse(message.id, INTERNAL_ERROR, error.message || String(error));
    }
  }

  async _dispatch(method, params) {
    switch (method) {
      case 'initialize': {
        const requested = params.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        this.options.onInitialize?.(params.clientInfo || {});
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.options.name, title: this.options.title, version: this.options.version },
          ...(this.options.instructions ? { instructions: this.options.instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return {
          tools: [...this.tools.values()].map(({ name, title, description, inputSchema, annotations }) => ({
            name, ...(title ? { title } : {}), description, inputSchema, ...(annotations ? { annotations } : {}),
          })),
        };
      case 'tools/call':
        return this._call(params);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async _call(params) {
    const tool = this.tools.get(params.name);
    if (!tool)
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
    const args = params.arguments ?? {};
    const problem = checkArguments(tool.inputSchema, args);
    if (problem)
      return { content: [{ type: 'text', text: problem }], isError: true };
    this.options.onToolCall?.(tool.name, args);
    try {
      return toolResult(await tool.handler(args));
    } catch (error) {
      // Tool failures go back to the model, which can correct its call (spec: tool execution errors).
      const text = error instanceof ToolError ? error.message : `${tool.name} failed: ${error.message || error}`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  }
}

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

module.exports = { McpProtocol, ToolError, checkArguments, toolResult, errorResponse, PROTOCOL_VERSIONS, PARSE_ERROR, INVALID_REQUEST };
