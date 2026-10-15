export interface SafeHeaders {
  [name: string]: string | string[];
}

export interface CapturedRequest {
  rawBody: string;
  receivedAt: string;
  method: string;
  headers: SafeHeaders;
}

export interface RequestStoreOptions {
  maxRequestsPerToken: number;
  maxTokens: number;
}

export const DEFAULT_MAX_REQUESTS_PER_TOKEN = 100;
export const DEFAULT_MAX_TOKENS = 1_000;

export class InMemoryRequestStore {
  private readonly requestsByToken = new Map<string, CapturedRequest[]>();

  private readonly maxRequestsPerToken: number;

  private readonly maxTokens: number;

  constructor(options: RequestStoreOptions) {
    this.maxRequestsPerToken = positiveInteger(
      options.maxRequestsPerToken,
      "maxRequestsPerToken",
    );
    this.maxTokens = positiveInteger(options.maxTokens, "maxTokens");
  }

  add(token: string, request: CapturedRequest): void {
    let requests = this.requestsByToken.get(token);
    if (!requests) {
      if (this.requestsByToken.size >= this.maxTokens) {
        const oldestToken = this.requestsByToken.keys().next().value;
        if (oldestToken !== undefined) {
          this.requestsByToken.delete(oldestToken);
        }
      }
      requests = [];
      this.requestsByToken.set(token, requests);
    }

    requests.push(cloneRequest(request));
    if (requests.length > this.maxRequestsPerToken) {
      requests.splice(0, requests.length - this.maxRequestsPerToken);
    }
  }

  list(token: string): CapturedRequest[] {
    return (this.requestsByToken.get(token) ?? []).map(cloneRequest);
  }

  clear(token: string): number {
    const requests = this.requestsByToken.get(token);
    if (!requests) return 0;

    this.requestsByToken.delete(token);
    return requests.length;
  }
}

function cloneRequest(request: CapturedRequest): CapturedRequest {
  return {
    rawBody: request.rawBody,
    receivedAt: request.receivedAt,
    method: request.method,
    headers: { ...request.headers },
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
