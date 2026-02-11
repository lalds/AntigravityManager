import assert from 'node:assert/strict';

import { transformClaudeRequestIn } from '../../lib/antigravity/ClaudeRequestMapper';
import { ProxyService } from '../../server/modules/proxy/proxy.service';
import { TokenManagerService } from '../../server/modules/proxy/token-manager.service';
import { CloudAccountRepo } from '../../ipc/database/cloudHandler';
import { GoogleAPIService } from '../../services/GoogleAPIService';

const mockTokenManager: any = {
  getNextToken: async () => null,
  markAsRateLimited: () => undefined,
  markAsForbidden: () => undefined,
};

const mockGeminiClient: any = {
  streamGenerateInternal: async () => undefined,
  generateInternal: async () => undefined,
};

class TestableProxyService extends ProxyService {
  constructor() {
    super(mockTokenManager, mockGeminiClient);
  }

  public createGeminiInternal(
    model: string,
    request: Record<string, unknown>,
    projectId: string | undefined,
    requestType: string,
  ): Record<string, unknown> {
    return (this as any).createGeminiInternalRequest(model, request, projectId, requestType);
  }
}

function getEnv(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value && value.trim() !== '') {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required env: ${name}`);
}

function getEnvFromList(names: string[], fallback?: string): string {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') {
      return value;
    }
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`Missing required env. Tried: ${names.join(', ')}`);
}

function getLiveHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey && apiKey.trim() !== '') {
    headers.Authorization = apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`;
  }
  return headers;
}

async function callLive(
  baseUrl: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  apiKey?: string,
): Promise<{ status: number; text: string }> {
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: getLiveHeaders(apiKey),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to call ${url}. Ensure proxy service is running and reachable. Original error: ${message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function validateMapperProjectField(): Promise<void> {
  const request = {
    model: 'claude-sonnet-4-5',
    stream: false,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hello' }],
  };

  const emptyProjectBody = transformClaudeRequestIn(request as any, '');
  assert.ok(!Object.prototype.hasOwnProperty.call(emptyProjectBody, 'project'));

  const blankProjectBody = transformClaudeRequestIn(request as any, '   ');
  assert.ok(!Object.prototype.hasOwnProperty.call(blankProjectBody, 'project'));

  const validProjectBody = transformClaudeRequestIn(request as any, 'resolved-project-id');
  assert.equal(validProjectBody.project, 'resolved-project-id');
}

async function validateProxyInternalBuilder(): Promise<void> {
  const service = new TestableProxyService();

  const emptyInternalBody = service.createGeminiInternal(
    'gemini-2.5-flash',
    { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    '',
    'generate-content',
  );
  console.log(
    '[DEBUG] Internal request with empty project_id:',
    JSON.stringify(emptyInternalBody, null, 2),
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(emptyInternalBody, 'project'));

  const validInternalBody = service.createGeminiInternal(
    'gemini-2.5-flash',
    { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] },
    'resolved-project-id',
    'generate-content',
  );
  console.log(
    '[DEBUG] Internal request with valid project_id:',
    JSON.stringify(validInternalBody, null, 2),
  );
  assert.equal(validInternalBody.project, 'resolved-project-id');
}

async function validateRuntimeGeminiRequestPath(): Promise<void> {
  const service = new TestableProxyService();
  const originalGetNextToken = mockTokenManager.getNextToken;
  const originalGenerateInternal = mockGeminiClient.generateInternal;
  let capturedBody: Record<string, unknown> | null = null;

  mockTokenManager.getNextToken = async () => ({
    id: 'account-1',
    email: 'project-test@example.com',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: '',
      upstream_proxy_url: undefined,
    },
  });

  mockGeminiClient.generateInternal = async (body: Record<string, unknown>) => {
    capturedBody = body;
    return {
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        totalTokenCount: 1,
      },
    };
  };

  try {
    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    } as any);
  } finally {
    mockTokenManager.getNextToken = originalGetNextToken;
    mockGeminiClient.generateInternal = originalGenerateInternal;
  }

  assert.ok(capturedBody, 'Expected captured Gemini internal request');
  console.log(
    '[DEBUG] Runtime captured internal request (from handleGeminiGenerateContent):',
    JSON.stringify(capturedBody, null, 2),
  );
  assert.ok(!Object.prototype.hasOwnProperty.call(capturedBody, 'project'));
}

async function validateRuntimeGeminiRequestFromAccountProject(): Promise<void> {
  const sourceProjectId = `account-project-${Date.now()}`;
  const account = {
    id: 'account-source-1',
    provider: 'google',
    email: 'account-source@example.com',
    token: {
      access_token: 'source-access-token',
      refresh_token: 'source-refresh-token',
      token_type: 'Bearer',
      expires_in: 3600,
      expiry_timestamp: Math.floor(Date.now() / 1000) + 3600,
      project_id: sourceProjectId,
    },
    created_at: 1,
    last_used: 1,
  };

  const cloudAccountRepo = CloudAccountRepo as any;
  const googleApiService = GoogleAPIService as any;

  const originalGetAccounts = cloudAccountRepo.getAccounts;
  const originalGetAccount = cloudAccountRepo.getAccount;
  const originalUpdateToken = cloudAccountRepo.updateToken;
  const originalFetchProjectId = googleApiService.fetchProjectId;
  const originalGenerateInternal = mockGeminiClient.generateInternal;

  let capturedBody: Record<string, unknown> | null = null;
  let fetchProjectIdCalled = false;

  cloudAccountRepo.getAccounts = async () => [account];
  cloudAccountRepo.getAccount = async (id: string) => (id === account.id ? account : null);
  cloudAccountRepo.updateToken = async () => undefined;
  googleApiService.fetchProjectId = async () => {
    fetchProjectIdCalled = true;
    return 'unexpected-project-id';
  };

  mockGeminiClient.generateInternal = async (body: Record<string, unknown>) => {
    capturedBody = body;
    return {
      candidates: [
        {
          content: {
            parts: [{ text: 'ok' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        totalTokenCount: 1,
      },
    };
  };

  try {
    const tokenManager = new TokenManagerService();
    const service = new ProxyService(tokenManager as any, mockGeminiClient as any);
    await service.handleGeminiGenerateContent('models/gemini-2.5-flash', {
      contents: [{ role: 'user', parts: [{ text: 'hello from account source' }] }],
    } as any);
  } finally {
    cloudAccountRepo.getAccounts = originalGetAccounts;
    cloudAccountRepo.getAccount = originalGetAccount;
    cloudAccountRepo.updateToken = originalUpdateToken;
    googleApiService.fetchProjectId = originalFetchProjectId;
    mockGeminiClient.generateInternal = originalGenerateInternal;
  }

  assert.ok(capturedBody, 'Expected captured Gemini internal request');
  const captured = capturedBody as Record<string, unknown>;
  assert.equal(
    captured['project'],
    sourceProjectId,
    'Expected project field to come from account.token.project_id',
  );
  assert.equal(
    fetchProjectIdCalled,
    false,
    'fetchProjectId should not be called when account already has project_id',
  );

  console.log('[DEBUG] Account source project_id:', sourceProjectId);
  console.log(
    '[DEBUG] Runtime captured internal request (project from account):',
    JSON.stringify(captured, null, 2),
  );
}

async function validateLiveRequests(): Promise<void> {
  const baseUrl = getEnvFromList(['PROJECT_ID_TEST_BASE_URL', 'PARITY_BASE_URL_A']);
  const timeoutMs = Number(getEnv('PROJECT_ID_TEST_TIMEOUT_MS', '30000'));
  const apiKey = getEnvFromList(
    ['PROJECT_ID_TEST_API_KEY', 'PARITY_API_KEY_A', 'PARITY_API_KEY'],
    '',
  );

  const gemini = await callLive(
    baseUrl,
    '/v1beta/models/gemini-2.5-flash:generateContent',
    {
      contents: [{ role: 'user', parts: [{ text: 'project-id live validation' }] }],
    },
    timeoutMs,
    apiKey,
  );
  assert.ok(
    !gemini.text.toLowerCase().includes('invalid project resource name projects/'),
    `[gemini-live] still hit invalid empty project path. status=${gemini.status}, body=${gemini.text}`,
  );
  console.log(`[PASS] Live Gemini request check (status=${gemini.status})`);

  const anthropic = await callLive(
    baseUrl,
    '/v1/messages',
    {
      model: 'claude-sonnet-4-5',
      stream: false,
      max_tokens: 128,
      messages: [{ role: 'user', content: 'project-id live validation' }],
    },
    timeoutMs,
    apiKey,
  );
  assert.ok(
    !anthropic.text.toLowerCase().includes('invalid project resource name projects/'),
    `[anthropic-live] still hit invalid empty project path. status=${anthropic.status}, body=${anthropic.text}`,
  );
  console.log(`[PASS] Live Anthropic request check (status=${anthropic.status})`);
}

async function main(): Promise<void> {
  await validateMapperProjectField();
  console.log('[PASS] ClaudeRequestMapper project field behavior');

  await validateProxyInternalBuilder();
  console.log('[PASS] ProxyService internal request project field behavior');

  await validateRuntimeGeminiRequestPath();
  console.log('[PASS] Runtime Gemini request path omits empty project');

  await validateRuntimeGeminiRequestFromAccountProject();
  console.log('[PASS] Runtime Gemini request uses project_id from account source');

  if (process.argv.includes('--live')) {
    await validateLiveRequests();
    console.log('[PASS] Live request validation');
  }

  console.log('[DONE] Project ID request validation completed');
}

main().catch((error) => {
  console.error('[FAIL] Project ID request validation failed');
  console.error(error);
  process.exit(1);
});
