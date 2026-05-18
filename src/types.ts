export interface ApiKey {
  id: string;
  encryptedKey: string;
  key: string;
  useCount: number;
  lastUsed?: number;
  status: "active" | "inactive" | "invalid";
  createdAt: number;
}

export interface ProxyAuthKey {
  id: string;
  keyHash: string;
  name: string;
  useCount: number;
  lastUsed?: number;
  createdAt: number;
}

export interface ProxyConfig {
  modelPool: string[];
  currentModelIndex: number;
  totalRequests: number;
  kvFlushIntervalMs: number;
  proxyPublicAccess: boolean;
}

export interface ModelCatalog {
  source: "cerebras-public";
  fetchedAt: number;
  models: string[];
}
