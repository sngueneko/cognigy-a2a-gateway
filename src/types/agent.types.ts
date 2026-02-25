/**
 * @fileoverview Agent type definitions for the Cognigy A2A Gateway.
 *
 * Defines the configuration schema loaded from agents.config.json and
 * the types used to generate A2A-compliant AgentCards.
 */

// ─── Endpoint Types ───────────────────────────────────────────────────────────

/**
 * Cognigy endpoint type.
 * - REST: Synchronous HTTP POST, max ~8s, no persistent connection.
 * - SOCKET: Persistent Socket.IO connection via SocketConnectionPool,
 *           supports long-running agentic flows.
 */
export type CognigyEndpointType = 'REST' | 'SOCKET';

// ─── Agent Config (agents.config.json schema) ─────────────────────────────────

/**
 * A single skill entry in the agent configuration.
 * Maps to an A2A AgentSkill in the generated AgentCard.
 */
export interface AgentSkillConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: ReadonlyArray<string>;
}

/**
 * Single agent entry in agents.config.json.
 * All string values prefixed with `${...}` are resolved from environment variables.
 */
export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly endpointType: CognigyEndpointType;
  readonly endpointUrl: string;
  readonly urlToken: string;
  readonly skills: ReadonlyArray<AgentSkillConfig>;
}

/**
 * Root shape of agents.config.json.
 */
export interface AgentsConfigFile {
  readonly agents: ReadonlyArray<AgentConfig>;
}

/**
 * Resolved agent record after ENV substitution.
 */
export type ResolvedAgentConfig = AgentConfig;

// ─── A2A AgentCard types ──────────────────────────────────────────────────────

export interface A2AAgentSkill {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: ReadonlyArray<string>;
}

export interface A2AAgentCapabilities {
  readonly streaming: boolean;
  readonly pushNotifications: boolean;
  readonly stateTransitionHistory: boolean;
}
