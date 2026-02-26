/**
 * @fileoverview AgentRegistry — central registry for all configured Cognigy agents.
 *
 * Loads agent configuration at startup, generates A2A-compliant AgentCards,
 * and provides O(1) lookup by agent ID.
 *
 * AgentCards are served at: GET /.well-known/agent-card.json?agentId=<id>
 * A2A requests are routed to: POST /agents/<id>/
 */

import type { AgentCard } from '@a2a-js/sdk';
import { loadAgentsConfig } from '../config/loader';
import type { ResolvedAgentConfig } from '../types/agent.types';
import { logger } from '../logger';

const log = logger.child({ component: 'AgentRegistry' });

/**
 * AgentRegistry — singleton that holds all resolved agent configurations
 * and their corresponding A2A AgentCards.
 */
export class AgentRegistry {
  private readonly agents: ReadonlyMap<string, ResolvedAgentConfig>;
  private readonly agentCards: ReadonlyMap<string, AgentCard>;

  constructor() {
    const configs = loadAgentsConfig();
    const agentMap = new Map<string, ResolvedAgentConfig>();
    const cardMap = new Map<string, AgentCard>();

    for (const config of configs) {
      agentMap.set(config.id, config);
      cardMap.set(config.id, this.buildAgentCard(config));
    }

    this.agents = agentMap;
    this.agentCards = cardMap;

    log.info(
      { agentIds: [...agentMap.keys()], event: 'registry.loaded' },
      `AgentRegistry loaded ${agentMap.size} agent(s)`,
    );
  }

  /**
   * Returns the resolved config for the given agent ID, or undefined if not found.
   */
  getConfig(agentId: string): ResolvedAgentConfig | undefined {
    return this.agents.get(agentId);
  }

  /**
   * Returns the A2A AgentCard for the given agent ID, or undefined if not found.
   */
  getAgentCard(agentId: string): AgentCard | undefined {
    return this.agentCards.get(agentId);
  }

  /**
   * Returns all registered AgentCards.
   */
  getAllAgentCards(): ReadonlyArray<AgentCard> {
    return [...this.agentCards.values()];
  }

  /**
   * Returns all registered agent IDs.
   */
  getAgentIds(): ReadonlyArray<string> {
    return [...this.agents.keys()];
  }

  /**
   * Returns true if an agent with the given ID is registered.
   */
  hasAgent(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Builds an A2A-compliant AgentCard from a resolved agent configuration.
   * Protocol version matches @a2a-js/sdk v0.3.10 (spec v0.3.0).
   */
  private buildAgentCard(config: ResolvedAgentConfig): AgentCard {
    const baseUrl = process.env['GATEWAY_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? 3000}`;

    return {
      name: config.name,
      description: config.description,
      protocolVersion: '0.3.0',
      version: config.version,
      url: `${baseUrl}/agents/${config.id}/`,
      capabilities: {
        streaming: config.endpointType === 'SOCKET',
        pushNotifications: false,
        stateTransitionHistory: false,
      },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: config.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        tags: [...skill.tags],
      })),
    };
  }
}
