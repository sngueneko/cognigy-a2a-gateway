/**
 * @fileoverview Agent configuration loader.
 *
 * Reads agents.config.json from disk, substitutes ${ENV_VAR} placeholders
 * with values from process.env, and validates the result.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentsConfigFile, AgentConfig, ResolvedAgentConfig } from '../types/agent.types';

export class ConfigurationError extends Error {
  public readonly field: string;

  constructor(message: string, field: string) {
    super(message);
    this.name = 'ConfigurationError';
    this.field = field;
  }
}

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

function resolveEnvPlaceholders(value: string, fieldPath: string): string {
  return value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const resolved = process.env[varName];
    if (resolved === undefined || resolved === '') {
      throw new ConfigurationError(
        `Missing required environment variable "${varName}" referenced in config field "${fieldPath}"`,
        fieldPath,
      );
    }
    return resolved;
  });
}

function resolveObjectEnv<T>(obj: T, parentPath = ''): T {
  if (typeof obj === 'string') {
    return resolveEnvPlaceholders(obj, parentPath) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item, i) =>
      resolveObjectEnv(item, `${parentPath}[${i}]`),
    ) as unknown as T;
  }
  if (typeof obj === 'object' && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const fieldPath = parentPath ? `${parentPath}.${key}` : key;
      result[key] = resolveObjectEnv(value, fieldPath);
    }
    return result as T;
  }
  return obj;
}

const VALID_ENDPOINT_TYPES = new Set(['REST', 'SOCKET']);

function validateAgent(agent: AgentConfig): void {
  if (!agent.id || typeof agent.id !== 'string') {
    throw new ConfigurationError('Agent "id" must be a non-empty string', 'agents[].id');
  }
  if (!agent.name || typeof agent.name !== 'string') {
    throw new ConfigurationError(
      `Agent "${agent.id}": "name" must be a non-empty string`,
      `agents[${agent.id}].name`,
    );
  }
  if (!VALID_ENDPOINT_TYPES.has(agent.endpointType)) {
    throw new ConfigurationError(
      `Agent "${agent.id}": "endpointType" must be "REST" or "SOCKET", got "${agent.endpointType}"`,
      `agents[${agent.id}].endpointType`,
    );
  }
  if (!agent.endpointUrl || !agent.endpointUrl.startsWith('http')) {
    throw new ConfigurationError(
      `Agent "${agent.id}": "endpointUrl" must be a valid HTTP(S) URL`,
      `agents[${agent.id}].endpointUrl`,
    );
  }
  if (!agent.urlToken) {
    throw new ConfigurationError(
      `Agent "${agent.id}": "urlToken" must not be empty`,
      `agents[${agent.id}].urlToken`,
    );
  }
  if (!Array.isArray(agent.skills) || agent.skills.length === 0) {
    throw new ConfigurationError(
      `Agent "${agent.id}": must define at least one skill`,
      `agents[${agent.id}].skills`,
    );
  }
}

export function loadAgentsConfig(): ReadonlyArray<ResolvedAgentConfig> {
  const configPath = process.env['AGENTS_CONFIG_PATH'] ?? path.join(process.cwd(), 'agents.config.json');
  const absolutePath = path.resolve(configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new ConfigurationError(
      `Agents config file not found at "${absolutePath}".`,
      'AGENTS_CONFIG_PATH',
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(absolutePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigurationError(`Failed to read agents config file: ${msg}`, 'file.read');
  }

  let parsed: AgentsConfigFile;
  try {
    parsed = JSON.parse(raw) as AgentsConfigFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigurationError(`Failed to parse agents config JSON: ${msg}`, 'file.parse');
  }

  if (!Array.isArray(parsed.agents)) {
    throw new ConfigurationError(
      'agents.config.json must have a top-level "agents" array',
      'agents',
    );
  }

  const resolved = parsed.agents.map((agent, index) => {
    let resolvedAgent: AgentConfig;
    try {
      resolvedAgent = resolveObjectEnv(agent, `agents[${index}]`);
    } catch (err) {
      if (err instanceof ConfigurationError) throw err;
      throw new ConfigurationError(String(err), `agents[${index}]`);
    }
    validateAgent(resolvedAgent);
    return resolvedAgent;
  });

  const ids = resolved.map((a) => a.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new ConfigurationError(
      `Duplicate agent IDs found: ${[...new Set(duplicates)].join(', ')}`,
      'agents[].id',
    );
  }

  return resolved;
}
