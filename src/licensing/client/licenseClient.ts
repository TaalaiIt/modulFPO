import os from 'os';
import crypto from 'crypto';
import {
  Entitlements,
  CachedLicenseData,
  LicenseRegisterRequest,
  LicenseRegisterResponse,
  LicenseVerifyResponse
} from '../models/licenseTypes';
import { AuditLogger, AuditEventType } from '../../core/audit/auditLogger';

export interface ILicenseServerTransport {
  register(req: LicenseRegisterRequest): Promise<LicenseRegisterResponse>;
  verify(req: {
    licenseKey: string;
    deviceToken: string;
    hardwareId: string;
    agentId: string;
    providerCode?: string;
    providerAccountId?: string;
    rnm?: string;
  }): Promise<LicenseVerifyResponse>;
  heartbeat(req: {
    licenseKey: string;
    deviceToken: string;
    hardwareId: string;
    agentId: string;
  }): Promise<{ status: string; entitlements?: Entitlements; message?: string }>;
}

export class LicenseClient {
  private agentId: string;
  private hardwareId: string;
  private cache: CachedLicenseData | null = null;
  private serverTransport: ILicenseServerTransport;
  private auditLogger?: AuditLogger;

  constructor(
    agentId: string,
    serverTransport: ILicenseServerTransport,
    hardwareId?: string,
    auditLogger?: AuditLogger
  ) {
    this.agentId = agentId;
    this.hardwareId = hardwareId || this.generateHardwareId();
    this.serverTransport = serverTransport;
    this.auditLogger = auditLogger;
  }

  /**
   * Generates hardware fingerprint based on OS, host, architecture, cpus, network interfaces
   */
  public generateHardwareId(): string {
    const raw = `${os.platform()}:${os.arch()}:${os.hostname()}:${os.cpus().length}:${os.totalmem()}`;
    return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
  }

  public getHardwareId(): string {
    return this.hardwareId;
  }

  public getAgentId(): string {
    return this.agentId;
  }

  public getCachedData(): CachedLicenseData | null {
    return this.cache ? { ...this.cache } : null;
  }

  public loadCache(data: CachedLicenseData): void {
    this.cache = { ...data };
  }

  /**
   * Register/activate module license with activationCode (UC-19)
   */
  public async activate(
    activationCode: string,
    providerCode?: string,
    providerAccountId?: string,
    rnm?: string
  ): Promise<LicenseRegisterResponse> {
    const res = await this.serverTransport.register({
      activationCode,
      moduleCode: 'FPO_INTEGRATION',
      agentId: this.agentId,
      hardwareId: this.hardwareId,
      providerCode,
      providerAccountId,
      rnm
    });

    this.cache = {
      licenseKey: res.licenseKey,
      deviceToken: res.deviceToken,
      agentId: this.agentId,
      hardwareId: this.hardwareId,
      entitlements: res.entitlements,
      lastLicenseOk: new Date().toISOString(),
      cachedAt: new Date().toISOString()
    };

    this.auditLogger?.log({
      eventType: AuditEventType.LICENSE_CHECKED,
      agentId: this.agentId,
      message: `License ${res.licenseKey} activated successfully for Agent ${this.agentId}`
    });

    return res;
  }

  /**
   * Pre-flight gatekeeper verification before sending operation to FPO (UC-20, UC-21, UC-22)
   */
  public async checkEntitlement(context?: {
    providerCode?: string;
    providerAccountId?: string;
    rnm?: string;
  }): Promise<{ allowed: boolean; reason?: string; errorCode?: string; inGrace?: boolean }> {
    if (!this.cache) {
      return { allowed: false, reason: 'License not activated on this agent.', errorCode: 'LICENSE_NOT_CONFIGURED' };
    }

    // First, verify HWID locally
    if (this.cache.hardwareId !== this.hardwareId) {
      this.auditLogger?.log({
        eventType: AuditEventType.LICENSE_BLOCKED,
        agentId: this.agentId,
        message: `HARDWARE_MISMATCH: Current HWID ${this.hardwareId} does not match licensed HWID ${this.cache.hardwareId}.`
      });
      return {
        allowed: false,
        errorCode: 'HARDWARE_MISMATCH',
        reason: 'Agent was copied to another machine. Hardware mismatch detected.'
      };
    }

    // Try online verification with server
    try {
      const verifyRes = await this.serverTransport.verify({
        licenseKey: this.cache.licenseKey,
        deviceToken: this.cache.deviceToken,
        hardwareId: this.hardwareId,
        agentId: this.agentId,
        providerCode: context?.providerCode,
        providerAccountId: context?.providerAccountId,
        rnm: context?.rnm
      });

      if (!verifyRes.valid) {
        this.auditLogger?.log({
          eventType: AuditEventType.LICENSE_BLOCKED,
          agentId: this.agentId,
          message: `License verification failed: ${verifyRes.errorCode} - ${verifyRes.reason}`
        });
        return {
          allowed: false,
          errorCode: verifyRes.errorCode || 'LICENSE_INVALID',
          reason: verifyRes.reason || 'License validation failed'
        };
      }

      // Refresh cache on success
      if (verifyRes.entitlements) {
        this.cache.entitlements = verifyRes.entitlements;
      }
      this.cache.lastLicenseOk = new Date().toISOString();

      return { allowed: true };
    } catch (err: unknown) {
      // Server unreachable -> fallback to offline grace window (UC-20)
      const offlineLimitHours = this.cache.entitlements.offlineLimitHours || 24;
      const lastOkTime = new Date(this.cache.lastLicenseOk).getTime();
      const elapsedHours = (Date.now() - lastOkTime) / (1000 * 3600);

      if (elapsedHours <= offlineLimitHours) {
        // Still inside offline grace window!
        this.auditLogger?.log({
          eventType: AuditEventType.LICENSE_GRACE,
          agentId: this.agentId,
          message: `License server unreachable. Operating under offline grace window (${elapsedHours.toFixed(1)}h / ${offlineLimitHours}h elapsed).`
        });

        // Check local cache entitlements
        if (this.cache.entitlements.blocked) {
          return { allowed: false, errorCode: 'LICENSE_BLOCKED', reason: 'License is marked blocked in local cache.' };
        }
        if (!this.cache.entitlements.paid || !this.cache.entitlements.active) {
          return { allowed: false, errorCode: 'LICENSE_INACTIVE', reason: 'License is unpaid or inactive in local cache.' };
        }

        return { allowed: true, inGrace: true };
      } else {
        // Offline grace expired
        this.auditLogger?.log({
          eventType: AuditEventType.LICENSE_BLOCKED,
          agentId: this.agentId,
          message: `Offline grace window expired (${elapsedHours.toFixed(1)}h > ${offlineLimitHours}h limit). Blocking new fiscal operations.`
        });

        return {
          allowed: false,
          errorCode: 'LICENSE_OFFLINE_LIMIT_EXCEEDED',
          reason: `Offline grace period of ${offlineLimitHours} hours exceeded. Please reconnect to internet to verify license.`
        };
      }
    }
  }

  /**
   * Heartbeat check
   */
  public async performHeartbeat(): Promise<{ status: string }> {
    if (!this.cache) {
      return { status: 'NOT_ACTIVATED' };
    }

    try {
      const res = await this.serverTransport.heartbeat({
        licenseKey: this.cache.licenseKey,
        deviceToken: this.cache.deviceToken,
        hardwareId: this.hardwareId,
        agentId: this.agentId
      });

      if (res.status === 'OK' && res.entitlements) {
        this.cache.entitlements = res.entitlements;
        this.cache.lastLicenseOk = new Date().toISOString();
      }

      return { status: res.status };
    } catch {
      return { status: 'OFFLINE' };
    }
  }
}
