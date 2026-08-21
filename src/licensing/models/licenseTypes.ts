export interface Entitlements {
  active: boolean;
  paid: boolean;
  blocked: boolean;
  maxAgents: number;
  maxRnms: number;
  allowedProviders: string[];
  expiresAt: string; // ISO 8601
  offlineLimitHours: number; // default 24
  features?: Record<string, boolean>;
}

export interface LicenseSeat {
  seatId: string;
  agentId: string;
  hardwareId: string;
  registeredAt: string;
  lastHeartbeatAt: string;
  deviceToken?: string;
}

export interface LicenseProviderBinding {
  bindingId: string;
  providerCode: string;
  providerAccountId: string;
  agentId: string;
  createdAt: string;
}

export interface LicenseFpoBinding {
  rnm: string;
  agentId: string;
  createdAt: string;
}

export interface LicenseRecord {
  licenseKey: string;
  activationCode: string;
  moduleCode: string; // 'FPO_INTEGRATION'
  companyName: string;
  entitlements: Entitlements;
  seats: LicenseSeat[];
  providerBindings: LicenseProviderBinding[];
  fpoBindings: LicenseFpoBinding[];
  createdAt: string;
  updatedAt: string;
}

export interface LicenseRegisterRequest {
  activationCode: string;
  moduleCode: string;
  agentId: string;
  hardwareId: string;
  providerCode?: string;
  providerAccountId?: string;
  rnm?: string;
}

export interface LicenseRegisterResponse {
  success: boolean;
  licenseKey: string;
  deviceToken: string;
  entitlements: Entitlements;
}

export interface LicenseVerifyRequest {
  licenseKey: string;
  deviceToken: string;
  hardwareId: string;
  agentId: string;
  providerCode?: string;
  providerAccountId?: string;
  rnm?: string;
}

export interface LicenseVerifyResponse {
  valid: boolean;
  entitlements?: Entitlements;
  errorCode?: string;
  reason?: string;
}

export interface LicenseHeartbeatRequest {
  licenseKey: string;
  deviceToken: string;
  hardwareId: string;
  agentId: string;
}

export interface LicenseHeartbeatResponse {
  status: 'OK' | 'BLOCKED' | 'HARDWARE_MISMATCH' | 'EXPIRED' | 'UNPAID' | 'INVALID_TOKEN';
  entitlements?: Entitlements;
  message?: string;
}

export interface LicenseRebindRequest {
  licenseKey: string;
  agentId: string;
  newHardwareId: string;
  authSecret: string;
}

export interface LicenseRebindResponse {
  success: boolean;
  newDeviceToken: string;
  message?: string;
}

export interface CachedLicenseData {
  licenseKey: string;
  deviceToken: string;
  agentId: string;
  hardwareId: string;
  entitlements: Entitlements;
  lastLicenseOk: string; // ISO timestamp
  cachedAt: string;
}
