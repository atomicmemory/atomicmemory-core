/**
 * MemoryService config seam tests.
 *
 * Verifies that the service can thread an explicit runtime config into its
 * delegated modules while preserving the current singleton default when no
 * override is provided.
 */

import { describe, expect, it, vi } from 'vitest';

const {
  mockPerformSearch,
  mockPerformIngest,
  mockPerformQuickIngest,
  mockPerformWorkspaceIngest,
} = vi.hoisted(() => ({
  mockPerformSearch: vi.fn(),
  mockPerformIngest: vi.fn(),
  mockPerformQuickIngest: vi.fn(),
  mockPerformWorkspaceIngest: vi.fn(),
}));

const moduleConfig = {
  lessonsEnabled: true,
  consensusValidationEnabled: true,
  consensusMinMemories: 2,
  auditLoggingEnabled: true,
};

vi.mock('../../config.js', () => ({ config: moduleConfig }));
vi.mock('../memory-ingest.js', () => ({
  performIngest: mockPerformIngest,
  performQuickIngest: mockPerformQuickIngest,
  performStoreVerbatim: vi.fn(),
  performWorkspaceIngest: mockPerformWorkspaceIngest,
}));
vi.mock('../memory-search.js', () => ({
  performSearch: mockPerformSearch,
  performFastSearch: vi.fn(),
  performWorkspaceSearch: vi.fn(),
}));
vi.mock('../memory-crud.js', () => ({}));
vi.mock('../atomicmem-uri.js', () => ({
  URIResolver: class {
    resolve = vi.fn();
    format = vi.fn();
  },
}));

const { MemoryService } = await import('../memory-service.js');

describe('MemoryService config seam', () => {
  it('threads an explicit runtime config into delegated search deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformSearch.mockResolvedValue({
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: 'flat',
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.search('user-1', 'config seam query');

    expect(mockPerformSearch).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'config seam query',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('threads an explicit runtime config into delegated ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.ingest('user-1', 'text', 'site');

    expect(mockPerformIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      '',
      undefined,
    );
  });

  it('threads an explicit runtime config into delegated quick-ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    mockPerformQuickIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.quickIngest('user-1', 'text', 'site');

    expect(mockPerformQuickIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      '',
      undefined,
    );
  });

  it('threads an explicit runtime config into delegated workspace-ingest deps', async () => {
    const runtimeConfig = {
      lessonsEnabled: false,
      consensusValidationEnabled: false,
      consensusMinMemories: 5,
      auditLoggingEnabled: false,
    };
    const workspace = {
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      visibility: 'workspace',
    };
    mockPerformWorkspaceIngest.mockResolvedValue({
      episodeId: 'ep-1',
      factsExtracted: 0,
      stored: 0,
      skipped: 0,
      linksCreated: 0,
      compositesCreated: 0,
    });
    const service = new MemoryService(
      {} as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      runtimeConfig as any,
    );

    await service.workspaceIngest('user-1', 'text', 'site', '', workspace as any);

    expect(mockPerformWorkspaceIngest).toHaveBeenCalledWith(
      expect.objectContaining({ config: runtimeConfig }),
      'user-1',
      'text',
      'site',
      '',
      workspace,
      undefined,
    );
  });

  it('defaults delegated search deps to the module config singleton', async () => {
    mockPerformSearch.mockResolvedValue({
      memories: [],
      injectionText: '',
      citations: [],
      retrievalMode: 'flat',
    });
    const service = new MemoryService({} as any, {} as any);

    await service.search('user-1', 'default config query');

    expect(mockPerformSearch).toHaveBeenCalledWith(
      expect.objectContaining({ config: moduleConfig }),
      'user-1',
      'default config query',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});
