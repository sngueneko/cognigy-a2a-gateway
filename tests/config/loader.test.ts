/**
 * @fileoverview Tests for src/config/loader.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadAgentsConfig, ConfigurationError } from '../../src/config/loader';

function withTempConfig(content: object): { configPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
  const configPath = path.join(dir, 'agents.config.json');
  fs.writeFileSync(configPath, JSON.stringify(content), 'utf-8');
  process.env['AGENTS_CONFIG_PATH'] = configPath;
  return {
    configPath,
    cleanup: () => {
      delete process.env['AGENTS_CONFIG_PATH'];
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const validSocketAgent = {
  id: 'booking-agent',
  name: 'Booking Assistant',
  description: 'Test agent',
  version: '1.0.0',
  endpointType: 'SOCKET',
  endpointUrl: 'https://endpoint.cognigy.ai/socket/ws/endpoint',
  urlToken: 'test-token-123',
  skills: [{ id: 'booking', name: 'Booking', description: 'Book stuff', tags: ['booking'] }],
};

const validRestAgent = {
  id: 'faq-agent',
  name: 'FAQ Assistant',
  description: 'FAQ agent',
  version: '1.0.0',
  endpointType: 'REST',
  endpointUrl: 'https://endpoint.cognigy.ai/rest/endpoint',
  urlToken: 'faq-token-456',
  skills: [{ id: 'faq', name: 'FAQ', description: 'FAQs', tags: ['faq'] }],
};

describe('loadAgentsConfig', () => {
  afterEach(() => {
    delete process.env['AGENTS_CONFIG_PATH'];
    delete process.env['COGNIGY_TEST_URL'];
    delete process.env['COGNIGY_TEST_TOKEN'];
  });

  describe('happy path', () => {
    it('loads a single valid SOCKET agent', () => {
      const { cleanup } = withTempConfig({ agents: [validSocketAgent] });
      try {
        const agents = loadAgentsConfig();
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({ id: 'booking-agent', endpointType: 'SOCKET' });
      } finally { cleanup(); }
    });

    it('loads a single valid REST agent', () => {
      const { cleanup } = withTempConfig({ agents: [validRestAgent] });
      try {
        const agents = loadAgentsConfig();
        expect(agents).toHaveLength(1);
        expect(agents[0]).toMatchObject({ id: 'faq-agent', endpointType: 'REST' });
      } finally { cleanup(); }
    });

    it('loads multiple agents in one config', () => {
      const { cleanup } = withTempConfig({ agents: [validSocketAgent, validRestAgent] });
      try {
        const agents = loadAgentsConfig();
        expect(agents).toHaveLength(2);
        expect(agents.map((a) => a.id)).toEqual(['booking-agent', 'faq-agent']);
      } finally { cleanup(); }
    });
  });

  describe('environment variable substitution', () => {
    it('resolves ${VAR} placeholders from process.env', () => {
      process.env['COGNIGY_TEST_URL'] = 'https://socket.cognigy.ai/ws/abc123';
      process.env['COGNIGY_TEST_TOKEN'] = 'my-secret-token';
      const cfg = { ...validSocketAgent, id: 'env-agent', endpointUrl: '${COGNIGY_TEST_URL}', urlToken: '${COGNIGY_TEST_TOKEN}' };
      const { cleanup } = withTempConfig({ agents: [cfg] });
      try {
        const agents = loadAgentsConfig();
        expect(agents[0]?.endpointUrl).toBe('https://socket.cognigy.ai/ws/abc123');
        expect(agents[0]?.urlToken).toBe('my-secret-token');
      } finally { cleanup(); }
    });

    it('throws ConfigurationError if referenced ENV variable is missing', () => {
      delete process.env['COGNIGY_TEST_URL'];
      const cfg = { ...validSocketAgent, id: 'env-missing', endpointUrl: '${COGNIGY_TEST_URL}' };
      const { cleanup } = withTempConfig({ agents: [cfg] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('COGNIGY_TEST_URL');
      } finally { cleanup(); }
    });

    it('throws ConfigurationError if referenced ENV variable is empty string', () => {
      process.env['COGNIGY_TEST_TOKEN'] = '';
      const cfg = { ...validSocketAgent, id: 'empty-env', urlToken: '${COGNIGY_TEST_TOKEN}' };
      const { cleanup } = withTempConfig({ agents: [cfg] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
      } finally { cleanup(); }
    });
  });

  describe('file errors', () => {
    it('throws ConfigurationError if file does not exist', () => {
      process.env['AGENTS_CONFIG_PATH'] = '/nonexistent/path/agents.config.json';
      expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
      expect(() => loadAgentsConfig()).toThrow('not found');
    });

    it('throws ConfigurationError if file contains invalid JSON', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-test-'));
      const configPath = path.join(dir, 'agents.config.json');
      fs.writeFileSync(configPath, '{ invalid json {{{', 'utf-8');
      process.env['AGENTS_CONFIG_PATH'] = configPath;
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('parse');
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('throws ConfigurationError if top-level agents array is missing', () => {
      const { cleanup } = withTempConfig({ notAgents: [] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('"agents" array');
      } finally { cleanup(); }
    });
  });

  describe('agent validation', () => {
    it('throws for invalid endpointType', () => {
      const { cleanup } = withTempConfig({ agents: [{ ...validSocketAgent, id: 'bad', endpointType: 'GRPC' }] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('endpointType');
      } finally { cleanup(); }
    });

    it('throws for empty skills array', () => {
      const { cleanup } = withTempConfig({ agents: [{ ...validSocketAgent, id: 'no-skills', skills: [] }] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('skill');
      } finally { cleanup(); }
    });

    it('throws for invalid endpointUrl', () => {
      const { cleanup } = withTempConfig({ agents: [{ ...validSocketAgent, id: 'bad-url', endpointUrl: 'not-a-url' }] });
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('endpointUrl');
      } finally { cleanup(); }
    });

    it('throws for duplicate agent IDs', () => {
      const { cleanup } = withTempConfig({ agents: [
        { ...validSocketAgent, id: 'dup' },
        { ...validRestAgent, id: 'dup' },
      ]});
      try {
        expect(() => loadAgentsConfig()).toThrow(ConfigurationError);
        expect(() => loadAgentsConfig()).toThrow('dup');
      } finally { cleanup(); }
    });

    it('ConfigurationError has a field property', () => {
      process.env['AGENTS_CONFIG_PATH'] = '/no/such/file.json';
      try { loadAgentsConfig(); } catch (err) {
        expect(err).toBeInstanceOf(ConfigurationError);
        if (err instanceof ConfigurationError) {
          expect(typeof err.field).toBe('string');
          expect(err.field.length).toBeGreaterThan(0);
        }
      }
    });
  });
});
