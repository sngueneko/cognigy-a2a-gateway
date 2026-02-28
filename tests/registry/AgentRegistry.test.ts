/**
 * @fileoverview Tests for AgentRegistry.
 */

import { AgentRegistry } from '../../src/registry/AgentRegistry';
import * as loader from '../../src/config/loader';

const MOCK_CONFIG_SINGLE = {
  id: 'test-agent',
  name: 'Test Agent',
  description: 'A test agent',
  version: '1.0.0',
  endpointType: 'REST' as const,
  endpointUrl: 'https://api.cognigy.example/endpoint/abc123',
  urlToken: 'abc123',
  skills: [
    {
      id: 'greet',
      name: 'Greeting',
      description: 'Say hello',
      tags: ['greeting'],
    },
  ],
};

const MOCK_CONFIG_SECOND = {
  id: 'second-agent',
  name: 'Second Agent',
  description: 'Another test agent',
  version: '2.0.0',
  endpointType: 'SOCKET' as const,
  endpointUrl: 'https://socket.cognigy.example',
  urlToken: 'tok999',
  skills: [
    {
      id: 'book',
      name: 'Booking',
      description: 'Book things',
      tags: ['booking', 'travel'],
    },
  ],
};

jest.mock('../../src/config/loader');
const mockLoadAgentsConfig = loader.loadAgentsConfig as jest.MockedFunction<typeof loader.loadAgentsConfig>;

beforeEach(() => {
  jest.resetAllMocks();
  delete process.env['GATEWAY_BASE_URL'];
  delete process.env['PORT'];
});

describe('AgentRegistry', () => {

  describe('constructor', () => {
    it('loads all agents from config', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE, MOCK_CONFIG_SECOND]);
      const registry = new AgentRegistry();
      expect(registry.getAgentIds()).toHaveLength(2);
    });

    it('loads zero agents gracefully', () => {
      mockLoadAgentsConfig.mockReturnValue([]);
      const registry = new AgentRegistry();
      expect(registry.getAgentIds()).toHaveLength(0);
    });
  });

  describe('getConfig()', () => {
    it('returns resolved config for known agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      expect(registry.getConfig('test-agent')).toEqual(MOCK_CONFIG_SINGLE);
    });

    it('returns undefined for unknown agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      expect(registry.getConfig('nope')).toBeUndefined();
    });
  });

  describe('getAgentCard()', () => {
    it('returns an AgentCard for known agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent');
      expect(card).toBeDefined();
      expect(card?.name).toBe('Test Agent');
    });

    it('returns undefined for unknown agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      expect(registry.getAgentCard('nobody')).toBeUndefined();
    });
  });

  describe('getAllAgentCards()', () => {
    it('returns all cards', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE, MOCK_CONFIG_SECOND]);
      const registry = new AgentRegistry();
      const cards = registry.getAllAgentCards();
      expect(cards).toHaveLength(2);
    });

    it('returns empty array when no agents', () => {
      mockLoadAgentsConfig.mockReturnValue([]);
      const registry = new AgentRegistry();
      expect(registry.getAllAgentCards()).toHaveLength(0);
    });
  });

  describe('getAgentIds()', () => {
    it('returns IDs for all registered agents', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE, MOCK_CONFIG_SECOND]);
      const registry = new AgentRegistry();
      const ids = registry.getAgentIds();
      expect(ids).toContain('test-agent');
      expect(ids).toContain('second-agent');
    });
  });

  describe('hasAgent()', () => {
    it('returns true for a registered agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      expect(registry.hasAgent('test-agent')).toBe(true);
    });

    it('returns false for an unknown agent', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      expect(registry.hasAgent('ghost-agent')).toBe(false);
    });
  });

  describe('AgentCard generation', () => {
    it('builds a valid A2A AgentCard with correct shape', () => {
      process.env['GATEWAY_BASE_URL'] = 'https://gateway.example.com';
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;

      expect(card.name).toBe('Test Agent');
      expect(card.description).toBe('A test agent');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.version).toBe('1.0.0');
      expect(card.url).toBe('https://gateway.example.com/agents/test-agent/');
      // MOCK_CONFIG_SINGLE uses endpointType:'REST' → streaming:false
      expect(card.capabilities).toEqual({
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: false,
      });
    });

    it('sets streaming:true for SOCKET agents and streaming:false for REST agents', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE, MOCK_CONFIG_SECOND]);
      const registry = new AgentRegistry();

      const restCard = registry.getAgentCard('test-agent')!;   // REST
      const socketCard = registry.getAgentCard('second-agent')!; // SOCKET

      expect(restCard.capabilities.streaming).toBe(false);
      expect(socketCard.capabilities.streaming).toBe(true);
    });

    it('maps skills correctly to AgentCard skills', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;

      expect(card.skills).toHaveLength(1);
      expect(card.skills[0]).toMatchObject({
        id: 'greet',
        name: 'Greeting',
        description: 'Say hello',
        tags: ['greeting'],
      });
    });

    it('uses GATEWAY_BASE_URL env var when set', () => {
      process.env['GATEWAY_BASE_URL'] = 'https://custom.gateway.example';
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;
      expect(card.url).toContain('https://custom.gateway.example');
    });

    it('falls back to localhost:3000 when no base URL or PORT set', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;
      expect(card.url).toContain('localhost:3000');
    });

    it('uses PORT env var for fallback URL when GATEWAY_BASE_URL not set', () => {
      process.env['PORT'] = '8080';
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;
      expect(card.url).toContain('localhost:8080');
    });

    it('sets defaultInputModes and defaultOutputModes to [text]', () => {
      mockLoadAgentsConfig.mockReturnValue([MOCK_CONFIG_SINGLE]);
      const registry = new AgentRegistry();
      const card = registry.getAgentCard('test-agent')!;
      expect(card.defaultInputModes).toEqual(['text']);
      expect(card.defaultOutputModes).toEqual(['text']);
    });
  });
});
