/**
 * @fileoverview Gateway server entry point.
 *
 * Endpoint map
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovery (registry / list)
 *   GET  /.well-known/agents.json               All AgentCards (array)
 *   GET  /agents                                Alias — same payload
 *
 * Per-agent canonical well-known  (A2A spec §3.1 — single AgentCard object)
 *   GET  /agents/:id/.well-known/agent-card.json
 *
 * A2A JSON-RPC
 *   POST /agents/:id/
 *
 * Utility
 *   GET  /health
 * ─────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import express from 'express';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { AgentRegistry } from './registry/AgentRegistry';
import { CognigyAgentExecutor } from './handlers/CognigyAgentExecutor';
import { TaskStoreFactory } from './task/TaskStoreFactory';
import { logger } from './logger';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const log = logger.child({ component: 'Server' });

async function bootstrap(): Promise<void> {
  const app = express();
  app.use(express.json());

  const registry = new AgentRegistry();
  const agentIds = registry.getAgentIds();

  if (agentIds.length === 0) {
    log.error({ event: 'server.no_agents' }, 'No agents configured — exiting');
    process.exit(1);
  }

  // ── Per-agent routes ────────────────────────────────────────────────────────
  for (const agentId of agentIds) {
    const config = registry.getConfig(agentId);
    const agentCard = registry.getAgentCard(agentId);
    if (!config || !agentCard) continue;

    try {
      const executor = new CognigyAgentExecutor(config);
      const taskStore = TaskStoreFactory.createFromEnv();
      const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

      // A2A spec §3.1 — single AgentCard at per-agent well-known path
      app.use(
        `/agents/${agentId}/.well-known/agent-card.json`,
        agentCardHandler({ agentCardProvider: requestHandler }),
      );

      // A2A JSON-RPC endpoint
      app.use(
        `/agents/${agentId}/`,
        jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }),
      );

      log.info(
        { agentId, endpointType: config.endpointType, event: 'agent.registered' },
        `Registered agent: ${agentId}`,
      );
    } catch (err) {
      log.error(
        { agentId, err, event: 'agent.registration_failed' },
        `Failed to register agent: ${agentId}`,
      );
    }
  }

  // ── Fix 1 — root /.well-known/agent-card.json → 404 with guidance ──────────
  app.get('/.well-known/agent-card.json', (_req, res) => {
    res.status(404).json({
      error: 'not_found',
      message:
        'This gateway hosts multiple agents. Use /.well-known/agents.json to list all agents, ' +
        'or /agents/:id/.well-known/agent-card.json for a specific agent.',
      discovery: {
        allAgents: '/.well-known/agents.json',
        perAgent: '/agents/:id/.well-known/agent-card.json',
      },
    });
  });

  // ── Fix 2 — /.well-known/agents.json — gateway registry list ───────────────
  app.get('/.well-known/agents.json', (_req, res) => {
    res.json(registry.getAllAgentCards());
  });

  // ── Fix 3 — /agents — REST-convention alias ─────────────────────────────────
  app.get('/agents', (_req, res) => {
    res.json(registry.getAllAgentCards());
  });

  // ── Utility ─────────────────────────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ status: 'healthy', agents: agentIds.length, timestamp: new Date().toISOString() });
  });

  // ── 404 fallback ─────────────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, () => {
    log.info(
      { port: PORT, agentIds, event: 'server.started' },
      `Cognigy A2A Gateway listening on port ${PORT}`,
    );
  });
}

bootstrap().catch((err) => {
  logger.error({ err, event: 'server.fatal' }, 'Failed to start gateway');
  process.exit(1);
});
