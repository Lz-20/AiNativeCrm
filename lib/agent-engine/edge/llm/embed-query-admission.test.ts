import { describe,expect,it,vi } from 'vitest';
const wire=vi.hoisted(()=>vi.fn());
vi.mock('./embedding-provider',()=>({requestEmbedding:wire}));
import {embedQuery,embedConfigFromEnv} from './embed';
describe('retired environment embedding entry cannot bypass the operation ledger',()=> {
  it('an installation key alone never initiates an HTTP call',async()=> {
    const fetcher=vi.spyOn(globalThis,'fetch');
    try {
      const config=embedConfigFromEnv({RAG_EMBEDDING_API_KEY:'synthetic-no-supplier-key',RAG_EMBEDDING_MODEL:'text-embedding-3-small',RAG_EMBEDDING_TIMEOUT_MS:1000});
      await expect(embedQuery(config,'SVC-101')).rejects.toThrow('embedding_authorization_required');
      expect(wire).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    } finally {fetcher.mockRestore();}
  });
  it('explicit tenant/source grants go through the same governed provider entry',async()=> {
    const access={organizationId:'synthetic-org',kind:'query' as const,sourceIds:['synthetic-source']};
    wire.mockResolvedValue({embedding:Array(1536).fill(0.1),promptTokens:9});
    expect(await embedQuery({apiKey:'synthetic',model:'text-embedding-3-small',timeoutMs:1000,access},'SVC-101')).toHaveLength(1536);
    expect(wire).toHaveBeenCalledWith(expect.objectContaining({provider:'openai',model:'text-embedding-3-small',dimensions:1536}),'synthetic','SVC-101',undefined,access);
  });
});
